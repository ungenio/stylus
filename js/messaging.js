/*
global BG: true
global FIREFOX: true
global onRuntimeMessage applyOnMessage
*/
'use strict';

// keep message channel open for sendResponse in chrome.runtime.onMessage listener
const KEEP_CHANNEL_OPEN = true;

const CHROME = Boolean(chrome.app) && parseInt(navigator.userAgent.match(/Chrom\w+\/(?:\d+\.){2}(\d+)|$/)[1]);
const OPERA = Boolean(chrome.app) && parseFloat(navigator.userAgent.match(/\bOPR\/(\d+\.\d+)|$/)[1]);
const VIVALDI = Boolean(chrome.app) && navigator.userAgent.includes('Vivaldi');
const ANDROID = !chrome.windows;
let FIREFOX = !chrome.app && parseFloat(navigator.userAgent.match(/\bFirefox\/(\d+\.\d+)|$/)[1]);

if (!CHROME && !chrome.browserAction.openPopup) {
  // in FF pre-57 legacy addons can override useragent so we assume the worst
  // until we know for sure in the async getBrowserInfo()
  // (browserAction.openPopup was added in 57)
  FIREFOX = browser.runtime.getBrowserInfo ? 51 : 50;
  // getBrowserInfo was added in FF 51
  Promise.resolve(FIREFOX >= 51 ? browser.runtime.getBrowserInfo() : {version: 50}).then(info => {
    FIREFOX = parseFloat(info.version);
    document.documentElement.classList.add('moz-appearance-bug', FIREFOX && FIREFOX < 54);
  });
}

const URLS = {
  ownOrigin: chrome.runtime.getURL(''),

  optionsUI: [
    chrome.runtime.getURL('options.html'),
    'chrome://extensions/?options=' + chrome.runtime.id,
  ],

  configureCommands:
    OPERA ? 'opera://settings/configureCommands'
          : 'chrome://extensions/configureCommands',

  // CWS cannot be scripted in chromium, see ChromeExtensionsClient::IsScriptableURL
  // https://cs.chromium.org/chromium/src/chrome/common/extensions/chrome_extensions_client.cc
  browserWebStore:
    FIREFOX ? 'https://addons.mozilla.org/' :
    OPERA ? 'https://addons.opera.com/' :
      'https://chrome.google.com/webstore/',

  emptyTab: [
    // Chrome and simple forks
    'chrome://newtab/',
    // Opera
    'chrome://startpage/',
    // Vivaldi
    'chrome-extension://mpognobbkildjkofajifpdfhcoklimli/components/startpage/startpage.html',
    // Firefox
    'about:home',
    'about:newtab',
  ],

  // Chrome 61.0.3161+ doesn't run content scripts on NTP https://crrev.com/2978953002/
  // TODO: remove when "minimum_chrome_version": "61" or higher
  chromeProtectsNTP: CHROME >= 3161,

  supported: url => (
    url.startsWith('http') && (FIREFOX || !url.startsWith(URLS.browserWebStore)) ||
    url.startsWith('ftp') ||
    url.startsWith('file') ||
    url.startsWith(URLS.ownOrigin) ||
    !URLS.chromeProtectsNTP && url.startsWith('chrome://newtab/')
  ),
};

let BG = chrome.extension.getBackgroundPage();
if (BG && !BG.getStyles && BG !== window) {
  // own page like editor/manage is being loaded on browser startup
  // before the background page has been fully initialized;
  // it'll be resolved in onBackgroundReady() instead
  BG = null;
}
if (!BG || BG !== window) {
  if (FIREFOX) {
    document.documentElement.classList.add('firefox');
  } else if (OPERA) {
    document.documentElement.classList.add('opera');
  } else {
    if (VIVALDI) document.documentElement.classList.add('vivaldi');
  }
  // TODO: remove once our manifest's minimum_chrome_version is 50+
  // Chrome 49 doesn't report own extension pages in webNavigation apparently
  if (CHROME && CHROME < 2661) {
    getActiveTab().then(tab =>
      window.API.updateIcon({tab}));
  }
}

const FIREFOX_NO_DOM_STORAGE = FIREFOX && !tryCatch(() => localStorage);
if (FIREFOX_NO_DOM_STORAGE) {
  // may be disabled via dom.storage.enabled
  Object.defineProperty(window, 'localStorage', {value: {}});
  Object.defineProperty(window, 'sessionStorage', {value: {}});
}

// eslint-disable-next-line no-var
var API = (() => {
  return new Proxy(() => {}, {
    get: (target, name) =>
      name === 'remoteCall' ?
        remoteCall :
        arg => invokeBG(name, arg),
  });

  function remoteCall(name, arg, remoteWindow) {
    let thing = window[name] || window.API_METHODS[name];
    if (typeof thing === 'function') {
      thing = thing(arg);
    }
    if (!thing || typeof thing !== 'object') {
      return thing;
    } else if (thing instanceof Promise) {
      return thing.then(product => remoteWindow.deepCopy(product));
    } else {
      return remoteWindow.deepCopy(thing);
    }
  }

  function invokeBG(name, arg = {}) {
    if (BG && (name in BG || name in BG.API_METHODS)) {
      const call = BG !== window ?
        BG.API.remoteCall(name, BG.deepCopy(arg), window) :
        remoteCall(name, arg, BG);
      return Promise.resolve(call);
    }
    if (BG && BG.getStyles) {
      throw new Error('Bad API method', name, arg);
    }
    if (FIREFOX) {
      arg.method = name;
      return sendMessage(arg);
    }
    return onBackgroundReady().then(() => invokeBG(name, arg));
  }

  function onBackgroundReady() {
    return BG && BG.getStyles ? Promise.resolve() : new Promise(function ping(resolve) {
      sendMessage({method: 'healthCheck'}, health => {
        if (health !== undefined) {
          BG = chrome.extension.getBackgroundPage();
          resolve();
        } else {
          setTimeout(ping, 0, resolve);
        }
      });
    });
  }
})();


function notifyAllTabs(msg) {
  const originalMessage = msg;
  const styleUpdated = msg.method === 'styleUpdated';
  if (styleUpdated || msg.method === 'styleAdded') {
    // apply/popup/manage use only meta for these two methods,
    // editor may need the full code but can fetch it directly,
    // so we send just the meta to avoid spamming lots of tabs with huge styles
    msg = Object.assign({}, msg, {
      style: getStyleWithNoCode(msg.style)
    });
  }
  const affectsAll = !msg.affects || msg.affects.all;
  const affectsOwnOriginOnly = !affectsAll && (msg.affects.editor || msg.affects.manager);
  const affectsTabs = affectsAll || affectsOwnOriginOnly;
  const affectsIcon = affectsAll || msg.affects.icon;
  const affectsPopup = affectsAll || msg.affects.popup;
  const affectsSelf = affectsPopup || msg.prefs;
  // notify all open extension pages and popups
  if (affectsSelf) {
    msg.tabId = undefined;
    sendMessage(msg, ignoreChromeError);
  }
  // notify tabs
  if (affectsTabs || affectsIcon) {
    const notifyTab = tab => {
      if (!styleUpdated
      && (affectsTabs || URLS.optionsUI.includes(tab.url))
      // own pages are already notified via sendMessage
      && !(affectsSelf && tab.url.startsWith(URLS.ownOrigin))
      // skip lazy-loaded aka unloaded tabs that seem to start loading on message in FF
      && (!FIREFOX || tab.width)) {
        msg.tabId = tab.id;
        sendMessage(msg, ignoreChromeError);
      }
      if (affectsIcon) {
        // eslint-disable-next-line no-use-before-define
        debounce(API.updateIcon, 0, {tab});
      }
    };
    // list all tabs including chrome-extension:// which can be ours
    Promise.all([
      queryTabs(affectsOwnOriginOnly ? {url: URLS.ownOrigin + '*'} : {}),
      getActiveTab(),
    ]).then(([tabs, activeTab]) => {
      const activeTabId = activeTab && activeTab.id;
      for (const tab of tabs) {
        invokeOrPostpone(tab.id === activeTabId, notifyTab, tab);
      }
    });
  }
  // notify self: the message no longer is sent to the origin in new Chrome
  if (typeof onRuntimeMessage !== 'undefined') {
    onRuntimeMessage(originalMessage);
  }
  // notify apply.js on own pages
  if (typeof applyOnMessage !== 'undefined') {
    applyOnMessage(originalMessage);
  }
  // propagate saved style state/code efficiently
  if (styleUpdated) {
    msg.refreshOwnTabs = false;
    API.refreshAllTabs(msg);
  }
}


function sendMessage(msg, callback) {
  /*
  Promise mode [default]:
    - rejects on receiving {__ERROR__: message} created by background.js::onRuntimeMessage
    - automatically suppresses chrome.runtime.lastError because it's autogenerated
      by browserAction.setText which lacks a callback param in chrome API
  Standard callback mode:
    - enabled by passing a second param
  */
  const {tabId, frameId} = msg;
  const fn = tabId >= 0 ? chrome.tabs.sendMessage : chrome.runtime.sendMessage;
  const args = tabId >= 0 ? [tabId, msg, {frameId}] : [msg];
  if (callback) {
    fn(...args, callback);
  } else {
    return new Promise((resolve, reject) => {
      fn(...args, r => {
        const err = r && r.__ERROR__;
        (err ? reject : resolve)(err || r);
        ignoreChromeError();
      });
    });
  }
}


function queryTabs(options = {}) {
  return new Promise(resolve =>
    chrome.tabs.query(options, tabs =>
      resolve(tabs)));
}


function getTab(id) {
  return new Promise(resolve =>
    chrome.tabs.get(id, tab =>
      !chrome.runtime.lastError && resolve(tab)));
}


function getOwnTab() {
  return new Promise(resolve =>
    chrome.tabs.getCurrent(tab => resolve(tab)));
}


function getActiveTab() {
  return queryTabs({currentWindow: true, active: true})
    .then(tabs => tabs[0]);
}


function getActiveTabRealURL() {
  return getActiveTab()
    .then(getTabRealURL);
}


function getTabRealURL(tab) {
  return new Promise(resolve => {
    if (tab.url !== 'chrome://newtab/' || URLS.chromeProtectsNTP) {
      resolve(tab.url);
    } else {
      chrome.webNavigation.getFrame({tabId: tab.id, frameId: 0, processId: -1}, frame => {
        resolve(frame && frame.url || '');
      });
    }
  });
}

/**
 * Resolves when the [just created] tab is ready for communication.
 * @param {Number|Tab} tabOrId
 * @returns {Promise<?Tab>}
 */
function onTabReady(tabOrId) {
  let tabId, tab;
  if (Number.isInteger(tabOrId)) {
    tabId = tabOrId;
  } else {
    tab = tabOrId;
    tabId = tab && tab.id;
  }
  if (!tab) {
    return getTab(tabId).then(onTabReady);
  }
  if (tab.status === 'complete') {
    if (!FIREFOX || tab.url !== 'about:blank') {
      return Promise.resolve(tab);
    } else {
      return new Promise(resolve => {
        chrome.webNavigation.getFrame({tabId, frameId: 0}, frame => {
          ignoreChromeError();
          if (frame) {
            onTabReady(tab).then(resolve);
          } else {
            setTimeout(() => onTabReady(tabId).then(resolve));
          }
        });
      });
    }
  }
  return new Promise((resolve, reject) => {
    chrome.webNavigation.onCommitted.addListener(onCommitted);
    chrome.webNavigation.onErrorOccurred.addListener(onErrorOccurred);
    chrome.tabs.onRemoved.addListener(onTabRemoved);
    chrome.tabs.onReplaced.addListener(onTabReplaced);
    function onCommitted(info) {
      if (info.tabId !== tabId) return;
      unregister();
      getTab(tab.id).then(resolve);
    }
    function onErrorOccurred(info) {
      if (info.tabId !== tabId) return;
      unregister();
      reject();
    }
    function onTabRemoved(removedTabId) {
      if (removedTabId !== tabId) return;
      unregister();
      reject();
    }
    function onTabReplaced(addedTabId, removedTabId) {
      onTabRemoved(removedTabId);
    }
    function unregister() {
      chrome.webNavigation.onCommitted.removeListener(onCommitted);
      chrome.webNavigation.onErrorOccurred.removeListener(onErrorOccurred);
      chrome.tabs.onRemoved.removeListener(onTabRemoved);
      chrome.tabs.onReplaced.removeListener(onTabReplaced);
    }
  });
}


/**
 * Opens a tab or activates an existing one,
 * reuses the New Tab page or about:blank if it's focused now
 * @param {Object} params
 *        or just a string e.g. openURL('foo')
 * @param {string} params.url
 *        if relative, it's auto-expanded to the full extension URL
 * @param {number} [params.index]
 *        move the tab to this index in the tab strip, -1 = last
 * @param {Boolean} [params.active]
 *        true to activate the tab (this is the default value in the extensions API),
 *        false to open in background
 * @param {?Boolean} [params.currentWindow]
 *        pass null to check all windows
 * @param {any} [params.message]
 *        JSONifiable data to be sent to the tab via sendMessage()
 * @returns {Promise<Tab>} Promise that resolves to the opened/activated tab
 */
function openURL({
  url = arguments[0],
  index,
  active,
  currentWindow = true,
  message,
}) {
  url = url.includes('://') ? url : chrome.runtime.getURL(url);
  // [some] chromium forks don't handle their fake branded protocols
  url = url.replace(/^(opera|vivaldi)/, 'chrome');
  // FF doesn't handle moz-extension:// URLs (bug)
  // FF decodes %2F in encoded parameters (bug)
  // API doesn't handle the hash-fragment part
  const urlQuery =
    url.startsWith('moz-extension') ||
    url.startsWith('chrome:') ?
      undefined :
    FIREFOX && url.includes('%2F') ?
      url.replace(/%2F.*/, '*').replace(/#.*/, '') :
      url.replace(/#.*/, '');

  const task = queryTabs({url: urlQuery, currentWindow}).then(maybeSwitch);
  if (!message) {
    return task;
  } else {
    return task.then(onTabReady).then(tab => {
      message.tabId = tab.id;
      return sendMessage(message).then(() => tab);
    });
  }

  function maybeSwitch(tabs = []) {
    const urlWithSlash = url + '/';
    const urlFF = FIREFOX && url.replace(/%2F/g, '/');
    const tab = tabs.find(({url: u}) => u === url || u === urlFF || u === urlWithSlash);
    if (!tab) {
      return getActiveTab().then(maybeReplace);
    }
    if (index !== undefined && tab.index !== index) {
      chrome.tabs.move(tab.id, {index});
    }
    return activateTab(tab);
  }

  // update current NTP or about:blank
  // except when 'url' is chrome:// or chrome-extension:// in incognito
  function maybeReplace(tab) {
    const chromeInIncognito = tab && tab.incognito && url.startsWith('chrome');
    const emptyTab = tab && URLS.emptyTab.includes(tab.url);
    if (emptyTab && !chromeInIncognito) {
      return new Promise(resolve =>
        chrome.tabs.update({url}, resolve));
    }
    const options = {url, index, active};
    // FF57+ supports openerTabId, but not in Android (indicated by the absence of chrome.windows)
    if (tab && (!FIREFOX || FIREFOX >= 57 && chrome.windows) && !chromeInIncognito) {
      options.openerTabId = tab.id;
    }
    return new Promise(resolve =>
      chrome.tabs.create(options, resolve));
  }
}


function activateTab(tab) {
  return Promise.all([
    new Promise(resolve => {
      chrome.tabs.update(tab.id, {active: true}, resolve);
    }),
    chrome.windows && new Promise(resolve => {
      chrome.windows.update(tab.windowId, {focused: true}, resolve);
    }),
  ]).then(([tab]) => tab);
}


function stringAsRegExp(s, flags) {
  return new RegExp(s.replace(/[{}()[\]\\.+*?^$|]/g, '\\$&'), flags);
}


function ignoreChromeError() {
  // eslint-disable-next-line no-unused-expressions
  chrome.runtime.lastError;
}


function getStyleWithNoCode(style) {
  const stripped = deepCopy(style);
  for (const section of stripped.sections) section.code = null;
  stripped.sourceCode = null;
  return stripped;
}


// js engine can't optimize the entire function if it contains try-catch
// so we should keep it isolated from normal code in a minimal wrapper
// Update: might get fixed in V8 TurboFan in the future
function tryCatch(func, ...args) {
  try {
    return func(...args);
  } catch (e) {}
}


function tryRegExp(regexp, flags) {
  try {
    return new RegExp(regexp, flags);
  } catch (e) {}
}


function tryJSONparse(jsonString) {
  try {
    return JSON.parse(jsonString);
  } catch (e) {}
}


const debounce = Object.assign((fn, delay, ...args) => {
  clearTimeout(debounce.timers.get(fn));
  debounce.timers.set(fn, setTimeout(debounce.run, delay, fn, ...args));
}, {
  timers: new Map(),
  run(fn, ...args) {
    debounce.timers.delete(fn);
    fn(...args);
  },
  unregister(fn) {
    clearTimeout(debounce.timers.get(fn));
    debounce.timers.delete(fn);
  },
});


function deepCopy(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  // N.B. the copy should be an explicit literal
  if (Array.isArray(obj)) {
    const copy = [];
    for (const v of obj) {
      copy.push(!v || typeof v !== 'object' ? v : deepCopy(v));
    }
    return copy;
  }
  const copy = {};
  const hasOwnProperty = Object.prototype.hasOwnProperty;
  for (const k in obj) {
    if (!hasOwnProperty.call(obj, k)) continue;
    const v = obj[k];
    copy[k] = !v || typeof v !== 'object' ? v : deepCopy(v);
  }
  return copy;
}


function sessionStorageHash(name) {
  return {
    name,
    value: tryCatch(JSON.parse, sessionStorage[name]) || {},
    set(k, v) {
      this.value[k] = v;
      this.updateStorage();
    },
    unset(k) {
      delete this.value[k];
      this.updateStorage();
    },
    updateStorage() {
      sessionStorage[this.name] = JSON.stringify(this.value);
    }
  };
}

/**
 * @param {String} url
 * @param {Object} params
 * @param {String} [params.method]
 * @param {String|Object} [params.body]
 * @param {String} [params.responseType] arraybuffer, blob, document, json, text
 * @param {Number} [params.requiredStatusCode] resolved when matches, otherwise rejected
 * @param {Number} [params.timeout] ms
 * @param {Object} [params.headers] {name: value}
 * @returns {Promise}
 */
function download(url, {
  method = 'GET',
  body,
  responseType = 'text',
  requiredStatusCode = 200,
  timeout = 10e3,
  headers = {
    'Content-type': 'application/x-www-form-urlencoded',
  },
} = {}) {
  const queryPos = url.indexOf('?');
  if (queryPos > 0 && body === undefined) {
    method = 'POST';
    body = url.slice(queryPos);
    url = url.slice(0, queryPos);
  }
  return new Promise((resolve, reject) => {
    url = new URL(url);
    if (url.protocol === 'file:' && FIREFOX) {
      // https://stackoverflow.com/questions/42108782/firefox-webextensions-get-local-files-content-by-path
      // FIXME: add FetchController when it is available.
      const timer = setTimeout(reject, timeout, new Error('Timeout fetching ' + url.href));
      fetch(url.href, {mode: 'same-origin'})
        .then(r => {
          clearTimeout(timer);
          return r.status === 200 ? r.text() : Promise.reject(r.status);
        })
        .catch(reject)
        .then(resolve);
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.timeout = timeout;
    xhr.onloadend = event => {
      if (event.type !== 'error' && (
          xhr.status === requiredStatusCode || !requiredStatusCode ||
          url.protocol === 'file:')) {
        resolve(xhr.response);
      } else {
        reject(xhr.status);
      }
    };
    xhr.onerror = xhr.onloadend;
    xhr.responseType = responseType;
    xhr.open(method, url.href, true);
    for (const key in headers) {
      xhr.setRequestHeader(key, headers[key]);
    }
    xhr.send(body);
  });
}


function invokeOrPostpone(isInvoke, fn, ...args) {
  return isInvoke
    ? fn(...args)
    : setTimeout(invokeOrPostpone, 0, true, fn, ...args);
}


function openEditor({id}) {
  let url = '/edit.html';
  if (id) {
    url += `?id=${id}`;
  }
  if (chrome.windows && prefs.get('openEditInWindow')) {
    chrome.windows.create(Object.assign({url}, prefs.get('windowPosition')));
  } else {
    openURL({url});
  }
}


function closeCurrentTab() {
  // https://bugzilla.mozilla.org/show_bug.cgi?id=1409375
  getOwnTab().then(tab => {
    if (tab) {
      chrome.tabs.remove(tab.id);
    }
  });
}

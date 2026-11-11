'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const send = (channel, ...args) => ipcRenderer.send(channel, ...args);

const subscribe = (channel, callback) => {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('lite', {
  hydrate: () => invoke('lite:hydrate'),

  tabs: {
    create: () => invoke('lite:tab:create'),
    close: (id) => invoke('lite:tab:close', id),
    select: (id) => invoke('lite:tab:select', id),
    reorder: (ids) => invoke('lite:tab:reorder', ids),
    menu: (id, x, y) => invoke('lite:tab:menu', id, x, y),
    navigate: (id, input) => invoke('lite:tab:navigate', id, input),
    back: (id) => invoke('lite:tab:back', id),
    forward: (id) => invoke('lite:tab:forward', id),
    reload: (id, hard) => invoke('lite:tab:reload', id, Boolean(hard)),
    stop: (id) => invoke('lite:tab:stop', id),
    home: () => invoke('lite:tab:home'),
    zoom: (id, direction) => invoke('lite:tab:zoom', id, direction),
    resetZoom: (id) => invoke('lite:tab:reset-zoom', id),
  },

  find: {
    start: (text) => invoke('lite:find:start', text),
    next: (forward) => invoke('lite:find:next', forward),
    stop: () => invoke('lite:find:stop'),
    close: () => invoke('lite:find:close'),
  },

  window: {
    minimize: () => invoke('lite:window:minimize'),
    toggleMaximize: () => invoke('lite:window:toggle-maximize'),
    close: () => invoke('lite:window:close'),
    toggleFullscreen: () => invoke('lite:window:toggle-fullscreen'),
  },

  bookmarks: {
    toggle: (url, title, favicon) => invoke('lite:bookmark:toggle', url, title, favicon),
    remove: (id) => invoke('lite:bookmark:remove', id),
    menu: (id, x, y) => invoke('lite:bookmark:menu', id, x, y),
  },

  settings: {
    set: (key, value) => invoke('lite:settings:set', key, value),
  },

  history: {
    clear: () => invoke('lite:history:clear'),
    remove: (url) => invoke('lite:history:remove', url),
    menu: (url, x, y) => invoke('lite:history:menu', url, x, y),
  },

  menu: {
    app: () => invoke('lite:menu:app'),
    downloads: () => invoke('lite:menu:downloads'),
  },

  downloads: {
    panel: () => invoke('lite:downloads:panel'),
    clear: () => invoke('lite:downloads:clear'),
    open: (id) => invoke('lite:download:open', id),
  },

  userData: {
    open: () => invoke('lite:userdata:open'),
  },

  game: {
    open: () => invoke('lite:game:open'),
  },

  openExternal: (url) => invoke('lite:open-external', url),
  about: () => invoke('lite:app:about'),

  setChromeHeight: (height) => send('lite:chrome:height', height),
  setLayoutMetrics: (metrics) => send('lite:layout:metrics', metrics),

  onState: (callback) => subscribe('state', callback),
  onFocusOmnibox: (callback) => subscribe('ui:focus-omnibox', callback),
  onFindOpen: (callback) => subscribe('ui:find-open', callback),
  onFindClose: (callback) => subscribe('ui:find-close', callback),
  onFindResult: (callback) => subscribe('find:result', callback),
});

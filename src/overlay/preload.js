'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  data: () => ipcRenderer.invoke('lite:overlay:data'),
  measured: (size) => ipcRenderer.send('lite:overlay:measured', size),
  action: (id) => ipcRenderer.send('lite:overlay:action', id),
  close: () => ipcRenderer.send('lite:overlay:close'),
  onUpdate: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('lite:overlay:update', listener);
  },
  onShown: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('lite:overlay:shown', listener);
  },
  onTheme: (callback) => {
    const listener = (_event, theme) => callback(theme);
    ipcRenderer.on('lite:overlay:theme', listener);
  },
  rowMenu: (id, x, y) => ipcRenderer.send('lite:downloads:row-menu', id, x, y),
});

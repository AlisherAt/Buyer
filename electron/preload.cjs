const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('buyerAPI', {
  getStore: () => ipcRenderer.invoke('store:get'),
  saveStore: (data) => ipcRenderer.invoke('store:save', data),
  setLaunch: (enabled) => ipcRenderer.invoke('settings:launch', enabled),
  saveBackup: () => ipcRenderer.invoke('backup:save'),
  restoreBackup: () => ipcRenderer.invoke('backup:restore'),
  exportPdf: (html) => ipcRenderer.invoke('report:pdf', html),
  fetchRatesXml: () => ipcRenderer.invoke('rates:fetchXml')
});

const { contextBridge, ipcRenderer } = require('electron');

const bridge = {
  appName: '易标投标工具箱',
  platform: process.platform,
  config: {
    load: () => ipcRenderer.invoke('config:load'),
    save: (config) => ipcRenderer.invoke('config:save', config),
    listModels: () => ipcRenderer.invoke('config:list-models'),
  },
  ai: {
    chat: (request) => ipcRenderer.invoke('ai:chat', request),
    requestJson: (request) => ipcRenderer.invoke('ai:request-json', request),
  },
  file: {
    importDocument: () => ipcRenderer.invoke('file:import-document'),
  },
  export: {
    exportWord: (payload) => ipcRenderer.invoke('export:word', payload),
  },
};

contextBridge.exposeInMainWorld('yibiao', bridge);

contextBridge.exposeInMainWorld('yibiaoClient', {
  appName: bridge.appName,
  platform: bridge.platform,
});

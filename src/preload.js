const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desk', {
  onNavigate: callback => { ipcRenderer.on('desk:navigate',(_,page)=>callback(page)); },
  call: (action, data) => ipcRenderer.invoke('desk:call', action, data),
  subscribe: callback => { const handler = (_, state) => callback(state); ipcRenderer.on('desk:state', handler); return () => ipcRenderer.removeListener('desk:state', handler); },
  browserSubscribe: callback => { ipcRenderer.on('desk:browser', (_, state) => callback(state)); },
});

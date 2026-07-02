const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dropApi', {
  upload:     (filePath, fileName, fileSize) => ipcRenderer.invoke('drop:upload', { filePath, fileName, fileSize }),
  close:      ()     => ipcRenderer.send('drop:close'),
  onProgress: (cb)   => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('drop:progress', h);
    return () => ipcRenderer.removeListener('drop:progress', h);
  },
});

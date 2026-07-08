const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lanWin', {
  getPeers:  ()                     => ipcRenderer.invoke('lan-win:peers'),
  getStatus: ()                     => ipcRenderer.invoke('lan-win:status'),
  announce:  ()                     => ipcRenderer.invoke('lan-win:announce'),
  sendFile:  (peerId, filePath)     => ipcRenderer.invoke('lan-win:send-file', { peerId, filePath }),
  pickFile:  ()                     => ipcRenderer.invoke('lan-win:pick-file'),
  close:     ()                     => ipcRenderer.send('lan-win:close'),

  onPeers:          (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('lan-win:peers',            h); return () => ipcRenderer.removeListener('lan-win:peers',            h); },
  onSendProgress:   (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('lan-win:send-progress',    h); return () => ipcRenderer.removeListener('lan-win:send-progress',    h); },
  onSendDone:       (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('lan-win:send-done',        h); return () => ipcRenderer.removeListener('lan-win:send-done',        h); },
  onIncoming:       (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('lan-win:incoming',         h); return () => ipcRenderer.removeListener('lan-win:incoming',         h); },
  onReceiveProgress:(cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('lan-win:receive-progress', h); return () => ipcRenderer.removeListener('lan-win:receive-progress', h); },
  onFileReceived:   (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('lan-win:file-received',    h); return () => ipcRenderer.removeListener('lan-win:file-received',    h); },
});

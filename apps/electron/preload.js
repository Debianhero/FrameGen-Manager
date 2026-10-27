

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__TAURI__', {
  core: {
    invoke: function (cmd, args) {
      return ipcRenderer.invoke('fgm:invoke', cmd, args || {});
    },
  },
  event: {
    listen: function (name, cb) {
      const channel = 'fgm:event:' + name;
      const handler = function (_e, payload) { cb({ event: name, payload: payload }); };
      ipcRenderer.on(channel, handler);
      return Promise.resolve(function () { ipcRenderer.removeListener(channel, handler); });
    },
  },
});

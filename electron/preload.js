// electron/preload.js — the only bridge into the dashboard page.
// The app UI is the product's existing web frontend; it keeps talking to the
// embedded server over http://127.0.0.1 like it always has. This bridge just
// lets the page detect it is running inside the desktop app.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('staychatDesktop', {
  isDesktop: true,
  info: () => ipcRenderer.invoke('app:info'),
});

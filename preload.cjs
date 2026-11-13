'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const send = (ch) => (...a) => ipcRenderer.send(ch, ...a);
const on = (ch) => (cb) => ipcRenderer.on(ch, (_e, ...a) => cb(...a));
contextBridge.exposeInMainWorld('api', {
  listWindows: () => ipcRenderer.invoke('list-windows'),
  selectWindow: send('select-window'), pickPhoto: send('pick-photo'), pickAdb: send('pick-adb'),
  setOpacity: send('set-opacity'), toggleView: send('toggle-view'), setClickThrough: send('set-click-through'),
  setAutoFit: send('set-auto-fit'), setAutoCompare: send('set-auto-compare'), fitNow: send('fit-now'),
  resetOffset: send('reset-offset'), calibrate: send('calibrate'), compareNow: send('compare-now'),
  getState: send('get-state'), resizeUi: send('resize-ui'),
  calibClick: send('calib-click'), calibCancel: send('calib-cancel'),
  onState: on('state'), onOverlay: on('overlay'), onOverlayImage: on('overlay-image'), onCalibStep: on('calib-step'),
});

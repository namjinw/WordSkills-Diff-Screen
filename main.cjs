'use strict';
const { app, BrowserWindow, ipcMain, dialog, globalShortcut, screen, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
let winapi;
try { winapi = require('./lib/winapi.cjs'); }
catch (e) {
  // koffi(네이티브 모듈) 로드 실패 시 원인을 보여주고 종료
  app.whenReady().then(() => { dialog.showErrorBox('Windows API 로드 실패', String(e && e.stack || e)); app.quit(); });
  winapi = null;
}
const adbLib = require('./lib/adb.cjs');
const { compareToPhoto } = require('./lib/compare.cjs');
const config = require('./lib/config.cjs');
if (process.env.DIFFM_USERDATA) app.setPath('userData', process.env.DIFFM_USERDATA);
if (process.argv.includes('--selftest')) app.setPath('userData', path.join(require('os').tmpdir(), 'wordskills-diff-screen-selftest'));

let control = null, overlay = null, calibWin = null;
let target = null;            // { hwnd, title, className }
let photo = null;             // nativeImage
let offset = { x: 0, y: 0 };  // 방향키 미세 이동(물리 px)
let lastRect = '';
let comparing = false;
const state = {
  opacity: 50, view: 'blend', clickThrough: true, autoFit: true, autoCompare: true,
  photoName: '', targetTitle: '', match: null, status: '창을 선택하고 사진을 불러오세요.',
  calibrated: false, adbPath: '',
};

const cfg = () => config.load();
const hwndOf = (w) => (w && !w.isDestroyed() ? Number(w.getNativeWindowHandle().readBigUInt64LE(0)) : 0);
const ownHwnds = () => [control, overlay, calibWin].map(hwndOf).filter(Boolean);

function pushState() {
  if (control && !control.isDestroyed()) control.webContents.send('state', state);
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send('overlay', { opacity: state.view === 'photo' ? 100 : state.opacity, match: state.match });
}
function setStatus(msg) { state.status = msg; pushState(); }

// ---------- 창 ----------
function createControl() {
  control = new BrowserWindow({
    width: 640, height: 150, useContentSize: true, resizable: false, maximizable: false, fullscreenable: false,
    title: 'wordskills-diff-screen', autoHideMenuBar: true, alwaysOnTop: true, backgroundColor: '#15171c',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  control.setMenuBarVisibility(false);
  control.setAlwaysOnTop(true, 'screen-saver');
  control.loadFile(path.join(__dirname, 'renderer', 'control.html'));
  control.on('closed', () => app.quit());
}

function createOverlay() {
  overlay = new BrowserWindow({
    width: 300, height: 600, x: 100, y: 100, show: false, frame: false, transparent: true, hasShadow: false,
    resizable: false, skipTaskbar: true, focusable: false, alwaysOnTop: true, minWidth: 1, minHeight: 1,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  overlay.setAlwaysOnTop(true, 'floating');
  overlay.setIgnoreMouseEvents(state.clickThrough, { forward: false });
  overlay.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
  overlay.webContents.on('did-finish-load', () => { pushState(); if (photo) sendPhoto(); });
}

function sendPhoto() {
  if (!photo || !overlay || overlay.isDestroyed()) return;
  overlay.webContents.send('overlay-image', 'data:image/png;base64,' + photo.toPNG().toString('base64'));
}

// ---------- 위치 맞춤 ----------
function screenRect() {
  if (!target) return null;
  const f = winapi.getFrameRect(target.hwnd);
  if (!f) return null;
  const c = cfg().calib[target.className];
  let r = f;
  if (!c && photo && /^Qt|Android Emulator/.test(target.className + ' ' + target.title)) {
    // 보정 전 기본값: 에뮬레이터 창은 위쪽에만 제목줄이 있으므로 아래·좌우를 창에 붙이고 사진 비율로 높이를 정한다
    const { width: pw, height: ph } = photo.getSize();
    const h = Math.round(f.width * ph / pw);
    if (h > 0 && h <= f.height) r = { x: f.x, y: f.y + f.height - h, width: f.width, height: h };
  }
  if (c) r = { x: f.x + c.left, y: f.y + c.top, width: f.width - c.left - c.right, height: f.height - c.top - c.bottom };
  return { x: r.x + offset.x, y: r.y + offset.y, width: Math.max(1, r.width), height: Math.max(1, r.height) };
}

function applyRect(force) {
  if (!overlay || overlay.isDestroyed() || !target) return;
  if (!winapi.windowExists(target.hwnd)) {
    overlay.hide(); target = null; state.targetTitle = '';
    setStatus('선택한 창이 닫혔습니다. 창을 다시 선택하세요.'); return;
  }
  if (winapi.isMinimized(target.hwnd)) { if (overlay.isVisible()) overlay.hide(); return; }
  const r = screenRect();
  if (!r) return;
  const key = JSON.stringify(r);
  if (!force && key === lastRect) {
    if (!overlay.isVisible() && state.view !== 'emu' && photo) overlay.showInactive();
    return;
  }
  lastRect = key;
  overlay.setBounds(screen.screenToDipRect(null, r));
  if (state.view !== 'emu' && photo && !overlay.isVisible()) overlay.showInactive();
}

function updateVisibility() {
  if (!overlay || overlay.isDestroyed()) return;
  if (state.view !== 'emu' && photo && target) { applyRect(true); overlay.showInactive(); }
  else overlay.hide();
  pushState();
}

setInterval(() => { if (state.autoFit) applyRect(false); }, 120);

// ---------- 동작 ----------
// 사진 100% ↔ 에뮬레이터 전환. 슬라이더를 움직이면 겹쳐 보기(blend)로 돌아간다.
function toggleView() {
  state.view = state.view === 'emu' ? 'photo' : 'emu';
  updateVisibility();
  if (state.view === 'emu' && target) winapi.bringToFront(target.hwnd); // 다른 창에 가려져 있어도 에뮬레이터를 앞으로
}
function setOpacity(v) {
  state.opacity = Math.min(100, Math.max(0, Math.round(v)));
  config.save({ opacity: state.opacity }); pushState();
}
function setClickThrough(b) {
  state.clickThrough = !!b; config.save({ clickThrough: state.clickThrough });
  overlay.setIgnoreMouseEvents(state.clickThrough, { forward: false }); pushState();
}
function nudge(dx, dy) { offset.x += dx; offset.y += dy; applyRect(true); setStatus(`미세 이동 X ${offset.x}px, Y ${offset.y}px`); }

function loadPhotoFile(file) {
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) { setStatus('사진을 열 수 없습니다 (PNG/JPG/BMP만 지원): ' + file); return; }
  photo = img; state.photoName = path.basename(file); config.save({ photoPath: file });
  sendPhoto(); state.view = 'blend'; updateVisibility(); setStatus('사진을 불러왔습니다.');
  compareNow();
}

async function compareNow() {
  if (comparing || !photo) return;
  const adb = adbLib.findAdb(cfg().adbPath);
  if (!adb) { setStatus('adb를 찾을 수 없습니다. [adb 지정]으로 adb.exe 경로를 지정하세요.'); return; }
  state.adbPath = adb;
  comparing = true;
  try {
    const png = await adbLib.screencap(adb);
    state.match = compareToPhoto(png, photo);
    setStatus(`일치도 ${state.match}% (adb 캡처 ${new Date().toLocaleTimeString()})`);
  } catch (e) { state.match = null; setStatus('일치도 계산 실패: ' + e.message); }
  finally { comparing = false; pushState(); }
}
let compareTimer = null;
function restartCompareTimer() {
  clearInterval(compareTimer);
  if (state.autoCompare) compareTimer = setInterval(() => { if (photo) compareNow(); }, 1500);
}

function selectWindow(hwnd) {
  const w = winapi.listWindows(ownHwnds()).find((x) => x.hwnd === Number(hwnd));
  if (!w) { setStatus('창을 찾을 수 없습니다.'); return; }
  target = { hwnd: w.hwnd, title: w.title, className: w.className };
  offset = { x: 0, y: 0 }; lastRect = '';
  state.targetTitle = w.title;
  state.calibrated = !!cfg().calib[w.className];
  const hint = !photo ? ' — [사진 불러오기]를 누르면 이 창 위에 겹쳐 보입니다.' : state.calibrated ? '' : ' — [화면 영역 보정]이 필요합니다.';
  setStatus(`연결: ${w.title}${hint}`);
  updateVisibility();
  winapi.bringToFront(target.hwnd);
}

// ---------- 화면 영역 보정 (왼쪽 위 → 오른쪽 아래 클릭) ----------
function startCalibration() {
  if (!target) { setStatus('먼저 에뮬레이터 창을 선택하세요.'); return; }
  const ds = screen.getAllDisplays();
  const minX = Math.min(...ds.map((d) => d.bounds.x)), minY = Math.min(...ds.map((d) => d.bounds.y));
  const maxX = Math.max(...ds.map((d) => d.bounds.x + d.bounds.width));
  const maxY = Math.max(...ds.map((d) => d.bounds.y + d.bounds.height));
  const pts = [];
  if (overlay.isVisible()) overlay.hide();
  calibWin = new BrowserWindow({
    x: minX, y: minY, width: maxX - minX, height: maxY - minY, frame: false, transparent: true, hasShadow: false,
    skipTaskbar: true, resizable: false, alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  calibWin.setAlwaysOnTop(true, 'screen-saver');
  calibWin.loadFile(path.join(__dirname, 'renderer', 'calibrate.html'));
  const finish = () => {
    ipcMain.removeAllListeners('calib-click'); ipcMain.removeAllListeners('calib-cancel');
    if (calibWin && !calibWin.isDestroyed()) calibWin.close();
    calibWin = null;
    updateVisibility();
  };
  ipcMain.on('calib-click', () => {
    pts.push(winapi.getCursor());
    if (pts.length === 1) { calibWin.webContents.send('calib-step', 2); return; }
    const f = winapi.getFrameRect(target.hwnd);
    const [a, b] = pts;
    const c = { left: a.x - f.x, top: a.y - f.y, right: f.x + f.width - b.x, bottom: f.y + f.height - b.y };
    finish();
    if (b.x - a.x < 20 || b.y - a.y < 20 || c.left < 0 || c.top < 0 || c.right < 0 || c.bottom < 0) {
      setStatus('보정 값이 올바르지 않습니다. 창 안쪽의 왼쪽 위 → 오른쪽 아래 순서로 클릭하세요.'); return;
    }
    config.save({ calib: { ...cfg().calib, [target.className]: c } });
    state.calibrated = true; offset = { x: 0, y: 0 };
    updateVisibility(); setStatus(`보정 저장: 화면 영역 ${b.x - a.x}×${b.y - a.y}px`);
  });
  ipcMain.on('calib-cancel', () => { finish(); setStatus('보정을 취소했습니다.'); });
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('list-windows', () => {
    try {
    const score = (t, c) => (/emulator|android|pixel|sdk_gphone/i.test(t) || /^Qt/.test(c) ? 0 : 1);
    return winapi.listWindows(ownHwnds()).sort((a, b) => score(a.title, a.className) - score(b.title, b.className))
      .map((w) => ({ hwnd: w.hwnd, title: w.title, className: w.className, size: `${w.rect.width}×${w.rect.height}` }));
    } catch (e) { return { error: String(e && e.message || e) }; }
  });
  ipcMain.on('select-window', (_e, hwnd) => selectWindow(hwnd));
  ipcMain.on('pick-photo', async () => {
    const r = await dialog.showOpenDialog(control, {
      title: '프로토타입 사진', properties: ['openFile'],
      filters: [{ name: '이미지', extensions: ['png', 'jpg', 'jpeg', 'bmp'] }],
    });
    if (!r.canceled && r.filePaths[0]) loadPhotoFile(r.filePaths[0]);
  });
  ipcMain.on('pick-adb', async () => {
    const r = await dialog.showOpenDialog(control, { title: 'adb.exe 지정', properties: ['openFile'], filters: [{ name: 'adb', extensions: ['exe'] }] });
    if (!r.canceled && r.filePaths[0]) {
      config.save({ adbPath: r.filePaths[0] }); state.adbPath = r.filePaths[0];
      setStatus('adb 경로 저장: ' + r.filePaths[0]); compareNow();
    }
  });
  ipcMain.on('set-opacity', (_e, v) => { state.view = 'blend'; setOpacity(v); updateVisibility(); });
  ipcMain.on('toggle-view', toggleView);
  ipcMain.on('set-click-through', (_e, b) => setClickThrough(b));
  ipcMain.on('set-auto-fit', (_e, b) => { state.autoFit = !!b; config.save({ autoFit: state.autoFit }); if (b) applyRect(true); pushState(); });
  ipcMain.on('set-auto-compare', (_e, b) => { state.autoCompare = !!b; config.save({ autoCompare: state.autoCompare }); restartCompareTimer(); pushState(); });
  ipcMain.on('fit-now', () => { applyRect(true); setStatus('에뮬레이터 화면에 맞췄습니다.'); });
  ipcMain.on('reset-offset', () => { offset = { x: 0, y: 0 }; applyRect(true); setStatus('미세 이동을 초기화했습니다.'); });
  ipcMain.on('calibrate', startCalibration);
  ipcMain.on('compare-now', compareNow);
  ipcMain.on('get-state', () => pushState());
  ipcMain.on('resize-ui', (_e, h) => {
    if (control && !control.isDestroyed()) control.setContentSize(640, Math.max(100, Math.min(600, Math.round(h))));
  });
}

function registerShortcuts() {
  const reg = (acc, fn) => { try { if (!globalShortcut.register(acc, fn)) console.warn('단축키 등록 실패:', acc); } catch (e) { console.warn(e.message); } };
  const M = 'CommandOrControl+Alt+';
  reg('F4', toggleView);
  reg('F5', compareNow);
  reg('F6', () => setClickThrough(!state.clickThrough));
  for (const [k, dx, dy] of [['Left', -1, 0], ['Right', 1, 0], ['Up', 0, -1], ['Down', 0, 1]]) {
    reg(M + k, () => nudge(dx, dy));
    reg(M + 'Shift+' + k, () => nudge(dx * 10, dy * 10));
  }
  reg(M + '0', () => { offset = { x: 0, y: 0 }; applyRect(true); });
  reg(M + 'PageUp', () => setOpacity(state.opacity + 5));
  reg(M + 'PageDown', () => setOpacity(state.opacity - 5));
}

app.whenReady().then(() => {
  const c = cfg();
  Object.assign(state, { opacity: c.opacity, clickThrough: c.clickThrough, autoFit: c.autoFit, autoCompare: c.autoCompare });
  state.adbPath = adbLib.findAdb(c.adbPath) || '';
  registerIpc(); createControl(); createOverlay(); registerShortcuts(); restartCompareTimer();
  if (c.photoPath && fs.existsSync(c.photoPath)) loadPhotoFile(c.photoPath);
  if (process.argv.includes('--selftest')) {
    require('./test/selftest.cjs')({ selectWindow, loadPhotoFile, setOpacity, toggleView, getOverlay: () => overlay, getControl: () => control, state, winapi });
  }
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());

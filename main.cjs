'use strict';
const { app, BrowserWindow, ipcMain, dialog, globalShortcut, screen, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const adbLib = require('./lib/adb.cjs');
const { compareToPhoto } = require('./lib/compare.cjs');
const config = require('./lib/config.cjs');
if (process.env.DIFFM_USERDATA) app.setPath('userData', process.env.DIFFM_USERDATA);
if (process.argv.includes('--selftest')) app.setPath('userData', path.join(require('os').tmpdir(), 'wordskills-diff-screen-selftest'));

let winapi;
try { winapi = require('./lib/winapi.cjs'); }
catch (e) {
  // koffi(네이티브 모듈) 로드 실패 시 원인을 보여주고 종료
  app.whenReady().then(() => { dialog.showErrorBox('Windows API 로드 실패', String((e && e.stack) || e)); app.quit(); });
  winapi = null;
}

const ICON = path.join(__dirname, 'build', 'icon.png');
const DOCK_W = 320;        // 사이드바 너비(DIP)
const TOOLBAR_GAP = 76;    // 에뮬레이터 옆 도구 막대를 피하는 간격(DIP)

let control = null, overlay = null, calibWin = null, calibWins = [];
let target = null;            // { hwnd, title, className }
let photo = null;             // nativeImage
let photoFile = '';
let files = [];               // 현재 폴더의 png 목록(전체 경로)
let offset = { x: 0, y: 0 };  // 방향키 미세 이동(물리 px)
let lastRect = '', lastDock = '';
let comparing = false, comparePending = false;
let missingSince = 0, lastReacquire = 0;
const state = {
  opacity: 50, view: 'blend', clickThrough: true, autoFit: true, autoCompare: true,
  photoName: '', dir: '', index: -1, count: 0,
  targetTitle: '', match: null, status: '창을 선택하고 사진을 불러오세요.',
  calibrated: false, adbPath: '', docked: true, dockSide: 'right',
};

/** 서로 배율(DPI)이 다른 모니터로 넘어갈 때 첫 setBounds가 틀어지는 문제를 피하려고 한 번 더 맞춘다 */
function setBoundsSafe(win, b) {
  win.setBounds(b);
  for (let i = 0; i < 2; i++) {
    const c = win.getBounds();
    if (Math.abs(c.x - b.x) <= 1 && Math.abs(c.y - b.y) <= 1 && Math.abs(c.width - b.width) <= 2 && Math.abs(c.height - b.height) <= 2) return;
    win.setBounds(b);
  }
}

const cfg = () => config.load();
const hwndOf = (w) => (w && !w.isDestroyed() ? Number(w.getNativeWindowHandle().readBigUInt64LE(0)) : 0);
const ownHwnds = () => [control, overlay, ...calibWins].map(hwndOf).filter(Boolean);

function pushState() {
  if (control && !control.isDestroyed()) control.webContents.send('state', state);
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send('overlay', { opacity: state.view === 'photo' ? 100 : state.opacity, match: state.match });
}
function setStatus(msg) { state.status = msg; pushState(); }

// ---------- 창 ----------
function createControl() {
  control = new BrowserWindow({
    width: DOCK_W, height: 720, resizable: false, maximizable: false, fullscreenable: false,
    title: 'wordskills-diff-screen', icon: ICON, autoHideMenuBar: true, alwaysOnTop: true, backgroundColor: '#15171c',
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

/** 대상 창이 닫혔다 다시 열려도(핸들이 바뀌어도) 같은 제목의 창을 다시 찾는다 */
function reacquire() {
  if (Date.now() - lastReacquire < 1000) return;
  lastReacquire = Date.now();
  const list = winapi.listWindows(ownHwnds());
  const w = list.find((x) => x.title === target.title && x.className === target.className)
    || list.find((x) => x.className === target.className && /Android Emulator/.test(x.title) && /Android Emulator/.test(target.title));
  if (w) { target.hwnd = w.hwnd; target.title = w.title; state.targetTitle = w.title; }
}

function applyRect(force) {
  if (!overlay || overlay.isDestroyed() || !target) return;
  if (!winapi.windowExists(target.hwnd)) {
    overlay.hide();
    if (!missingSince) { missingSince = Date.now(); setStatus('대상 창이 사라졌습니다. 같은 창이 다시 열리면 자동으로 이어집니다.'); }
    reacquire();
    if (!winapi.windowExists(target.hwnd)) return;
  }
  if (missingSince) { missingSince = 0; force = true; setStatus('대상 창을 다시 찾았습니다.'); }
  if (winapi.isMinimized(target.hwnd)) { if (overlay.isVisible()) overlay.hide(); return; }
  const r = screenRect();
  if (!r) return;
  const key = JSON.stringify(r);
  if (!force && key === lastRect) {
    if (!overlay.isVisible() && state.view !== 'emu' && photo && !away) overlay.showInactive();
    return;
  }
  lastRect = key;
  setBoundsSafe(overlay, screen.screenToDipRect(null, r));
  if (state.view !== 'emu' && photo && !away && !overlay.isVisible()) overlay.showInactive();
}

function updateVisibility() {
  if (!overlay || overlay.isDestroyed()) return;
  if (state.view !== 'emu' && photo && target && !away) { applyRect(true); overlay.showInactive(); }
  else overlay.hide();
  syncShortcuts();
  pushState();
}

/** 컨트롤 창을 에뮬레이터 옆 사이드바로 붙여 따라다니게 한다 */
function dockControl(force) {
  if (!control || control.isDestroyed() || !state.docked || !target) return;
  if (!winapi.windowExists(target.hwnd) || winapi.isMinimized(target.hwnd)) return;
  const f = winapi.getFrameRect(target.hwnd);
  if (!f) return;
  const d = screen.screenToDipRect(null, f);
  const wa = screen.getDisplayMatching(d).workArea;
  const h = Math.min(wa.height, Math.max(560, d.height));
  let x = state.dockSide === 'left' ? d.x - DOCK_W - 6 : d.x + d.width + TOOLBAR_GAP;
  if (x + DOCK_W > wa.x + wa.width) x = d.x - DOCK_W - 6;          // 오른쪽 공간이 모자라면 왼쪽
  x = Math.min(Math.max(x, wa.x), wa.x + wa.width - DOCK_W);       // 그래도 모자라면 화면 안으로
  const y = Math.min(Math.max(d.y, wa.y), wa.y + wa.height - h);
  const b = { x: Math.round(x), y: Math.round(y), width: DOCK_W, height: h };
  const key = JSON.stringify(b);
  if (!force && key === lastDock) return;
  lastDock = key;
  setBoundsSafe(control, b);
}

let away = false;
/** 에뮬레이터/이 앱이 앞일 때만 오버레이와 사이드바를 맨 위에 둔다. 다른 창이 위로 오면 그 창이 가려지지 않게 물러난다 */
function syncAway() {
  const fg = winapi.getForeground();
  const mine = ownHwnds().includes(fg) || (target && fg === Number(target.hwnd));
  const nowAway = !mine && !!target;
  if (nowAway === away) return;
  away = nowAway;
  if (control && !control.isDestroyed()) {
    if (away) control.setAlwaysOnTop(false); else control.setAlwaysOnTop(true, 'screen-saver');
  }
  if (away) { if (overlay && !overlay.isDestroyed()) overlay.hide(); }
  else updateVisibility();
}

setInterval(() => {
  if (!winapi) return;
  syncAway();
  if (!away && state.autoFit) applyRect(false);
  dockControl(false);
  syncShortcuts();
}, 120);

// ---------- 동작 ----------
function toggleView() {
  if (!target) { setStatus('먼저 [창 선택]으로 에뮬레이터 창을 고르세요.'); return; }
  if (!photo) { setStatus('먼저 [사진 불러오기]로 사진을 고르세요.'); return; }
  state.view = state.view === 'emu' ? 'photo' : 'emu';
  updateVisibility();
  if (state.view === 'emu') winapi.bringToFront(target.hwnd); // 다른 창에 가려져 있어도 에뮬레이터를 앞으로
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
function resetOffset() { offset = { x: 0, y: 0 }; applyRect(true); setStatus('미세 이동을 초기화했습니다.'); }

// ---------- 사진·폴더 ----------
function listPngs(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => /\.png$/i.test(n))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
      .map((n) => path.join(dir, n));
  } catch { return []; }
}

function refreshDir(dir) {
  state.dir = dir; files = listPngs(dir); config.save({ photoDir: dir });
  state.count = files.length;
  state.index = files.findIndex((f) => path.resolve(f) === path.resolve(photoFile || ''));
}

function loadPhotoFile(file) {
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) { setStatus('사진을 열 수 없습니다 (PNG/JPG/BMP만 지원): ' + file); return false; }
  photo = img; photoFile = file; state.photoName = path.basename(file); state.match = null;
  config.save({ photoPath: file });
  if (path.resolve(path.dirname(file)) !== path.resolve(state.dir || '.')) refreshDir(path.dirname(file));
  else state.index = files.findIndex((f) => path.resolve(f) === path.resolve(file));
  sendPhoto();
  if (state.view === 'emu') state.view = 'blend';
  lastRect = ''; updateVisibility();
  setStatus(`${state.photoName}${state.count ? ` (${state.index + 1}/${state.count})` : ''}`);
  compareNow();
  return true;
}

/** 폴더를 지정(경로 기억)하고, 아직 이 폴더 사진을 보고 있지 않으면 첫 사진을 연다 */
function setDir(dir) {
  dir = String(dir || '').trim().replace(/^"|"$/g, '');
  let ok = false;
  try { ok = fs.statSync(dir).isDirectory(); } catch {}
  if (!ok) { setStatus('폴더를 찾을 수 없습니다: ' + dir); return false; }
  refreshDir(dir);
  if (!files.length) { setStatus('이 폴더에 .png 파일이 없습니다: ' + dir); return false; }
  if (state.index < 0) return loadPhotoFile(files[0]);
  setStatus(`폴더 저장: ${dir} (png ${files.length}개)`); return true;
}

/** ← → : 폴더의 이전/다음 png로 전환 (사진이 보이는 상태에서만) */
function stepPhoto(delta) {
  if (state.view === 'emu') return;
  if (!files.length) { setStatus('폴더를 먼저 지정하세요 (png 목록이 없습니다).'); return; }
  const i = state.index < 0 ? 0 : (state.index + delta + files.length) % files.length;
  loadPhotoFile(files[i]);
}

async function compareNow() {
  if (!photo) return;
  if (comparing) { comparePending = true; return; }
  const adb = adbLib.findAdb(cfg().adbPath);
  if (!adb) { setStatus('adb를 찾을 수 없습니다. [adb 지정]으로 adb.exe 경로를 지정하세요.'); return; }
  state.adbPath = adb;
  comparing = true;
  try {
    const png = await adbLib.screencap(adb);
    state.match = compareToPhoto(png, photo);
    setStatus(`일치도 ${state.match}% (adb 캡처 ${new Date().toLocaleTimeString()})`);
  } catch (e) { state.match = null; setStatus('일치도 계산 실패: ' + e.message); }
  finally {
    comparing = false; pushState();
    if (comparePending) { comparePending = false; compareNow(); }
  }
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
  offset = { x: 0, y: 0 }; lastRect = ''; lastDock = ''; missingSince = 0;
  state.targetTitle = w.title;
  state.calibrated = !!cfg().calib[w.className];
  const hint = !photo ? ' — [사진 불러오기]를 누르면 이 창 위에 겹쳐 보입니다.' : state.calibrated ? '' : ' — 더 정확히 맞추려면 [화면 영역 보정]을 하세요.';
  setStatus(`연결: ${w.title}${hint}`);
  updateVisibility();
  dockControl(true);
  winapi.bringToFront(target.hwnd);
}

// ---------- 화면 영역 보정 (왼쪽 위 → 오른쪽 아래 클릭) ----------
function startCalibration() {
  if (!target) { setStatus('먼저 에뮬레이터 창을 선택하세요.'); return; }
  const pts = [];
  if (overlay.isVisible()) overlay.hide();
  // 모니터마다 보정 창을 하나씩 띄운다(배율이 다른 모니터에 걸친 큰 창 하나는 위치가 틀어진다).
  // 클릭 좌표는 GetCursorPos(물리 픽셀)로 읽으므로 모니터 배율과 상관없이 정확하다.
  calibWins = screen.getAllDisplays().map((d) => {
    const w = new BrowserWindow({
      x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height, frame: false, transparent: true, hasShadow: false,
      skipTaskbar: true, resizable: false, alwaysOnTop: true,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
    });
    w.setAlwaysOnTop(true, 'screen-saver');
    setBoundsSafe(w, d.bounds);
    w.loadFile(path.join(__dirname, 'renderer', 'calibrate.html'));
    return w;
  });
  calibWin = calibWins[0];
  const finish = () => {
    ipcMain.removeAllListeners('calib-click'); ipcMain.removeAllListeners('calib-cancel');
    for (const w of calibWins) if (!w.isDestroyed()) w.close();
    calibWins = []; calibWin = null;
    updateVisibility();
  };
  ipcMain.on('calib-click', () => {
    pts.push(winapi.getCursor());
    if (pts.length === 1) { for (const w of calibWins) if (!w.isDestroyed()) w.webContents.send('calib-step', 2); return; }
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
    } catch (e) { return { error: String((e && e.message) || e) }; }
  });
  ipcMain.on('select-window', (_e, hwnd) => selectWindow(hwnd));
  ipcMain.on('pick-photo', async () => {
    const r = await dialog.showOpenDialog(control, {
      title: '프로토타입 사진', properties: ['openFile'], defaultPath: state.dir || undefined,
      filters: [{ name: '이미지', extensions: ['png', 'jpg', 'jpeg', 'bmp'] }],
    });
    if (!r.canceled && r.filePaths[0]) loadPhotoFile(r.filePaths[0]);
  });
  ipcMain.on('pick-dir', async () => {
    const r = await dialog.showOpenDialog(control, { title: '사진 폴더', properties: ['openDirectory'], defaultPath: state.dir || undefined });
    if (!r.canceled && r.filePaths[0]) setDir(r.filePaths[0]);
  });
  ipcMain.on('set-dir', (_e, dir) => setDir(dir));
  ipcMain.on('step', (_e, d) => stepPhoto(d));
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
  ipcMain.on('set-dock', (_e, b) => { state.docked = !!b; config.save({ docked: state.docked }); lastDock = ''; dockControl(true); pushState(); });
  ipcMain.on('set-dock-side', (_e, s) => { state.dockSide = s === 'left' ? 'left' : 'right'; config.save({ dockSide: state.dockSide }); lastDock = ''; dockControl(true); pushState(); });
  ipcMain.on('fit-now', () => { applyRect(true); dockControl(true); setStatus('에뮬레이터 화면에 맞췄습니다.'); });
  ipcMain.on('nudge', (_e, dx, dy) => nudge(dx, dy));
  ipcMain.on('reset-offset', resetOffset);
  ipcMain.on('calibrate', startCalibration);
  ipcMain.on('compare-now', compareNow);
  ipcMain.on('get-state', () => pushState());
}

// ---------- 단축키 ----------
// 전역 단축키는 대상(에뮬레이터) 창이 맨 앞일 때만 등록한다. 다른 프로그램의 키를 가로채지 않기 위해서.
// 컨트롤 창이 앞일 때는 컨트롤 창 안에서 같은 키를 직접 처리한다(renderer/control.js).
let regKey = '';
function syncShortcuts() {
  if (!winapi) return;
  const active = !!target && winapi.getForeground() === Number(target.hwnd);
  const nav = active && state.view !== 'emu' && files.length > 0;
  const key = (active ? 'a' : '-') + (nav ? 'n' : '-');
  if (key === regKey) return;
  regKey = key;
  globalShortcut.unregisterAll();
  const reg = (acc, fn) => { try { globalShortcut.register(acc, fn); } catch {} };
  if (active) {
    const M = 'CommandOrControl+Alt+';
    reg('F4', toggleView);
    reg('F5', compareNow);
    reg('F6', () => setClickThrough(!state.clickThrough));
    for (const [k, dx, dy] of [['Left', -1, 0], ['Right', 1, 0], ['Up', 0, -1], ['Down', 0, 1]]) {
      reg(M + k, () => nudge(dx, dy));
      reg(M + 'Shift+' + k, () => nudge(dx * 10, dy * 10));
    }
    reg(M + '0', resetOffset);
    reg(M + 'PageUp', () => setOpacity(state.opacity + 5));
    reg(M + 'PageDown', () => setOpacity(state.opacity - 5));
  }
  if (nav) { reg('Left', () => stepPhoto(-1)); reg('Right', () => stepPhoto(1)); }
}

app.whenReady().then(() => {
  const c = cfg();
  Object.assign(state, { opacity: c.opacity, clickThrough: c.clickThrough, autoFit: c.autoFit, autoCompare: c.autoCompare, docked: c.docked, dockSide: c.dockSide });
  state.adbPath = adbLib.findAdb(c.adbPath) || '';
  registerIpc(); createControl(); createOverlay(); restartCompareTimer();
  if (c.photoDir && fs.existsSync(c.photoDir)) refreshDir(c.photoDir);
  if (c.photoPath && fs.existsSync(c.photoPath)) loadPhotoFile(c.photoPath);
  if (process.argv.includes('--selftest')) {
    require('./test/selftest.cjs')({ selectWindow, loadPhotoFile, setOpacity, toggleView, setDir, stepPhoto, getOverlay: () => overlay, getControl: () => control, state, winapi });
  }
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());

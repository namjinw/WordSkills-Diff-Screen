'use strict';
const { app, BrowserWindow, ipcMain, dialog, globalShortcut, screen, nativeImage, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const adbLib = require('./lib/adb.cjs');
const { analyze, makeThumb, matchBest } = require('./lib/compare.cjs');
const config = require('./lib/config.cjs');
if (process.env.DIFFM_USERDATA) app.setPath('userData', process.env.DIFFM_USERDATA);
if (process.argv.includes('--selftest')) {
  const ud = path.join(require('os').tmpdir(), 'wordskills-diff-screen-selftest');
  try { fs.rmSync(ud, { recursive: true, force: true }); } catch {}   // 매번 깨끗한 상태에서 시작
  app.setPath('userData', ud);
}

let winapi;
try { winapi = require('./lib/winapi.cjs'); }
catch (e) {
  // koffi(네이티브 모듈) 로드 실패 시 원인을 보여주고 종료
  app.whenReady().then(() => { dialog.showErrorBox('Windows API 로드 실패', String((e && e.stack) || e)); app.quit(); });
  winapi = null;
}

const ICON = path.join(__dirname, 'build', 'icon.png');
const DOCK_W = 320;         // 사이드바 너비(DIP)
const TOOLBAR_GAP = 76;     // 에뮬레이터 옆 도구 막대(별도 창, 실측 폭 68)를 피하는 간격(DIP)
const MATCH_MARGIN = 2;     // 자동 매칭: 현재 사진보다 이만큼(점수 %p) 더 비슷해야 교체
const MODES = ['photo', 'blend', 'split', 'diff', 'emu'];

let control = null, overlay = null, calibWin = null, calibWins = [];
let target = null;            // { hwnd, title, className }
let photo = null;             // nativeImage
let photoFile = '';
let photoBmp = null;          // 스포이드용 (BGRA)
let files = [];               // 현재 폴더의 png 목록(전체 경로)
let offset = { x: 0, y: 0 };  // 방향키 미세 이동(물리 px)
let lastRect = '', lastDock = '';
let comparing = false, comparePending = false;
let missingSince = 0, lastReacquire = 0, lastOccCheck = 0;
let lastShot = null, lastShotBmp = null;   // 틱마다 한 번 찍는 에뮬레이터 화면(모든 기능이 공유)
let tickCount = 0, devInfoBusy = false;
let away = false;
let autoUpdater = null;
const state = {
  version: '', opacity: 50, mode: 'blend', lastMode: 'blend', split: 50, threshold: 20,
  excludeTop: 0, excludeBottom: 0, autoMatch: false, rulers: false, tool: null,
  clickThrough: true, autoFit: true, autoCompare: true,
  photoName: '', dir: '', index: -1, count: 0, links: 0, matchNote: '',
  targetTitle: '', match: null, regions: null, status: '창을 선택하고 사진을 불러오세요.',
  calibrated: false, adbPath: '', docked: true, dockSide: 'right',
  dev: { w: null, h: null, density: null },
  readout: [], update: { state: 'idle', text: '', version: '' },
};

const cfg = () => config.load();
const hwndOf = (w) => (w && !w.isDestroyed() ? Number(w.getNativeWindowHandle().readBigUInt64LE(0)) : 0);
const ownHwnds = () => [control, overlay, ...calibWins].map(hwndOf).filter(Boolean);
const showsPhoto = () => state.mode !== 'emu';

/** 서로 배율(DPI)이 다른 모니터로 넘어갈 때 첫 setBounds가 틀어지는 문제를 피하려고 한 번 더 맞춘다 */
function setBoundsSafe(win, b) {
  win.setBounds(b);
  for (let i = 0; i < 2; i++) {
    const c = win.getBounds();
    if (Math.abs(c.x - b.x) <= 1 && Math.abs(c.y - b.y) <= 1 && Math.abs(c.width - b.width) <= 2 && Math.abs(c.height - b.height) <= 2) return;
    win.setBounds(b);
  }
}

/** 기기 크기·밀도 → dp 크기. adb 값이 없으면 Pixel 7(1080x2400, 420dpi) 기본값 */
function devDp() {
  const w = state.dev.w || (lastShot && lastShot.getSize().width) || 1080;
  const h = state.dev.h || (lastShot && lastShot.getSize().height) || 2400;
  const density = state.dev.density || 420;
  const k = 160 / density;
  return { pxW: w, pxH: h, density, dpW: Math.round(w * k * 10) / 10, dpH: Math.round(h * k * 10) / 10, estimated: !state.dev.density };
}

function overlayPayload() {
  return {
    opacity: state.mode === 'photo' ? 100 : state.opacity, mode: state.mode, split: state.split,
    match: state.match, regions: state.regions, tool: state.tool, rulers: state.rulers, dev: devDp(),
  };
}
function pushState() {
  if (control && !control.isDestroyed()) control.webContents.send('state', state);
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send('overlay', overlayPayload());
}
function setStatus(msg) { state.status = msg; pushState(); }
function addReadout(text) { state.readout = [text, ...state.readout].slice(0, 6); pushState(); }

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

function applyClickThrough() {
  if (overlay && !overlay.isDestroyed()) overlay.setIgnoreMouseEvents(state.clickThrough && !state.tool, { forward: false });
}

function createOverlay() {
  overlay = new BrowserWindow({
    width: 300, height: 600, x: 100, y: 100, show: false, frame: false, transparent: true, hasShadow: false,
    resizable: false, skipTaskbar: true, focusable: false, alwaysOnTop: true, minWidth: 1, minHeight: 1,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  overlay.setAlwaysOnTop(true, 'floating');
  applyClickThrough();
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
    if (!overlay.isVisible() && showsPhoto() && photo && !away) overlay.showInactive();
    return;
  }
  lastRect = key;
  setBoundsSafe(overlay, screen.screenToDipRect(null, r));
  if (showsPhoto() && photo && !away && !overlay.isVisible()) overlay.showInactive();
}

function updateVisibility() {
  if (!overlay || overlay.isDestroyed()) return;
  if (showsPhoto() && photo && target && !away) { applyRect(true); overlay.showInactive(); }
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

/** 대상 창 위에 다른 창이 겹쳐 있으면(코드 에디터 등) 오버레이를 숨기고 사이드바의 항상 위를 푼다.
 *  포커스가 아니라 실제 창 겹침(z-order)으로 판단하므로 옆에 나란히 둔 창은 영향이 없다. */
function syncAway() {
  if (!target) return;
  if (Date.now() - lastOccCheck < 200) return;
  lastOccCheck = Date.now();
  let nowAway = false;
  if (winapi.windowExists(target.hwnd) && !winapi.isMinimized(target.hwnd)) {
    const f = winapi.getFrameRect(target.hwnd);
    nowAway = !!f && winapi.isOccluded(target.hwnd, f, ownHwnds());
  }
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

// ---------- 보기 모드 ----------
/** 모드는 한 곳에서만 바꾼다: photo(사진 100%) / blend(겹침) / split(분할) / diff(차이) / emu(에뮬레이터만) */
function setMode(m) {
  if (!MODES.includes(m)) return;
  if (m !== 'emu') state.lastMode = m;
  state.mode = m;
  updateVisibility();
  if (m === 'diff') compareNow();
}
/** F4: emu ↔ 직전에 보던 모드. 어느 방향이든 에뮬레이터 창을 앞으로 가져온다 */
function toggleView() {
  if (!target) { setStatus('먼저 [창 선택]으로 에뮬레이터 창을 고르세요.'); return; }
  if (!photo) { setStatus('먼저 [사진 불러오기]로 사진을 고르세요.'); return; }
  state.mode = state.mode === 'emu' ? (state.lastMode || 'blend') : 'emu';
  winapi.bringToFront(target.hwnd);
  lastOccCheck = 0; syncAway();
  updateVisibility();
  if (state.mode === 'diff') compareNow();
}
function setOpacity(v) {
  state.opacity = Math.min(100, Math.max(0, Math.round(v)));
  config.save({ opacity: state.opacity }); pushState();
}
function setClickThrough(b) {
  state.clickThrough = !!b; config.save({ clickThrough: state.clickThrough });
  applyClickThrough(); pushState();
}
function setTool(t) {
  state.tool = state.tool === t ? null : (t || null);
  applyClickThrough();
  if (state.tool && state.mode === 'emu') setMode(state.lastMode || 'blend');
  setStatus(state.tool ? ({ measure: '측정: 사진 위를 드래그하세요.', guide: '가이드: 위쪽/왼쪽 눈금자를 클릭하면 선이 생기고, 우클릭하면 지워집니다.', pick: '스포이드: 색을 뽑을 곳을 클릭하세요.' }[state.tool]) : '도구를 껐습니다.');
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

function loadPhotoFile(file, opts = {}) {
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) { setStatus('사진을 열 수 없습니다 (PNG/JPG/BMP만 지원): ' + file); return false; }
  photo = img; photoFile = file; photoBmp = null; state.photoName = path.basename(file); state.match = null; state.regions = null;
  config.save({ photoPath: file });
  if (path.resolve(path.dirname(file)) !== path.resolve(state.dir || '.')) refreshDir(path.dirname(file));
  else state.index = files.findIndex((f) => path.resolve(f) === path.resolve(file));
  state.links = (links[path.resolve(file)] || []).length;
  sendPhoto();
  if (state.mode === 'emu' && !opts.keepMode) state.mode = state.lastMode || 'blend';
  lastRect = ''; updateVisibility();
  setStatus(`${state.photoName}${state.count ? ` (${state.index + 1}/${state.count})` : ''}`);
  if (!opts.noCompare) compareNow();
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
  if (!showsPhoto()) return;
  if (!files.length) { setStatus('폴더를 먼저 지정하세요 (png 목록이 없습니다).'); return; }
  const i = state.index < 0 ? 0 : (state.index + delta + files.length) % files.length;
  loadPhotoFile(files[i]);
}

// ---------- 화면 ↔ 사진 연결, 자동 매칭 ----------
// Flutter 앱은 Activity가 하나뿐이라 화면 이름을 adb로 알 수 없다. 대신 "이 화면은 이 사진"이라고 한 번 알려 주면
// 그때의 에뮬레이터 화면 썸네일을 사진에 붙여 저장하고, 자동 매칭이 그 썸네일도 후보로 쓴다.
let links = {};   // 사진 전체경로 → [{w,h,png(base64)}]
const linkBmps = new Map();
const thumbCache = new Map();
const linksFile = () => path.join(app.getPath('userData'), 'screen-links.json');
function loadLinks() { try { links = JSON.parse(fs.readFileSync(linksFile(), 'utf8')); } catch { links = {}; } }
function saveLinks() { try { fs.mkdirSync(path.dirname(linksFile()), { recursive: true }); fs.writeFileSync(linksFile(), JSON.stringify(links)); } catch {} }
function linkThumbs(file) {
  const key = path.resolve(file);
  return (links[key] || []).map((l, i) => {
    const ck = key + '#' + i + '#' + l.png.length;
    if (!linkBmps.has(ck)) linkBmps.set(ck, { w: l.w, h: l.h, bmp: nativeImage.createFromBuffer(Buffer.from(l.png, 'base64')).toBitmap() });
    return linkBmps.get(ck);
  });
}
function linkCurrent() {
  if (!photoFile) { setStatus('먼저 사진을 불러오세요.'); return; }
  if (!lastShot) { setStatus('에뮬레이터 화면이 아직 없습니다. adb 연결을 확인하세요.'); return; }
  const t = makeThumb(lastShot);
  const png = nativeImage.createFromBitmap(t.bmp, { width: t.w, height: t.h }).toPNG().toString('base64');
  const key = path.resolve(photoFile);
  links[key] = [...(links[key] || []), { w: t.w, h: t.h, png }].slice(-6);
  saveLinks(); state.links = links[key].length;
  setStatus(`현재 에뮬레이터 화면을 "${state.photoName}"에 연결했습니다 (${state.links}개).`);
}

async function thumbFor(file) {
  let mt = 0;
  try { mt = fs.statSync(file).mtimeMs; } catch { return null; }
  const c = thumbCache.get(file);
  if (c && c.mt === mt) return c.thumb;
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) return null;
  const thumb = makeThumb(img);
  thumbCache.set(file, { mt, thumb });
  await new Promise((r) => setImmediate(r)); // 사진이 많아도 화면이 멈추지 않게 양보
  return thumb;
}

let pendingKey = '', pendingCount = 0;
/** 에뮬레이터 화면과 가장 비슷한 사진으로 자동 전환. 깜빡임 방지: 여유 점수(MATCH_MARGIN)와 2회 연속 확인 */
async function autoMatchStep(shot) {
  if (files.length < 2) return;
  const cands = [];
  for (const f of files.slice(0, 120)) {
    const t = await thumbFor(f);
    if (t) cands.push({ key: f, thumbs: [t, ...linkThumbs(f)] });
  }
  const rank = matchBest(shot, cands, state);
  const top = rank[0];
  if (!top) return;
  const same = (a, b) => path.resolve(a) === path.resolve(b);
  if (same(top.key, photoFile)) { pendingKey = ''; pendingCount = 0; return; }
  const cur = rank.find((r) => same(r.key, photoFile));
  if (cur && top.score - cur.score < MATCH_MARGIN) { pendingKey = ''; pendingCount = 0; return; }
  if (pendingKey === top.key) pendingCount++; else { pendingKey = top.key; pendingCount = 1; }
  if (pendingCount < 2) return;
  pendingKey = ''; pendingCount = 0;
  loadPhotoFile(top.key, { noCompare: true, keepMode: true });   // 앱(emu) 보는 중이면 오버레이를 다시 띄우지 않는다
  state.matchNote = `자동 매칭: ${path.basename(top.key)} (${top.score}%)`;
}

// ---------- 일치도·차이 ----------
async function refreshDeviceInfo(adb) {
  if (devInfoBusy) return;
  devInfoBusy = true;
  try {
    const i = await adbLib.deviceInfo(adb);
    state.dev = { w: i.width, h: i.height, density: i.density };
  } catch {} finally { devInfoBusy = false; }
}

async function compareNow() {
  if (!photo) return;
  if (comparing) { comparePending = true; return; }
  const adb = adbLib.findAdb(cfg().adbPath);
  if (!adb) { setStatus('adb를 찾을 수 없습니다. [adb 지정]으로 adb.exe 경로를 지정하세요.'); return; }
  state.adbPath = adb;
  comparing = true;
  try {
    // 틱마다 화면은 한 번만 찍고(수백 ms), 일치도·차이·자동 매칭·스포이드가 이 한 장을 공유한다
    const shot = nativeImage.createFromBuffer(await adbLib.screencap(adb));
    if (shot.isEmpty()) throw new Error('에뮬레이터 화면을 해석하지 못했습니다');
    lastShot = shot; lastShotBmp = null;
    if (tickCount++ % 20 === 0 || !state.dev.density) refreshDeviceInfo(adb);
    if (state.autoMatch) await autoMatchStep(shot);
    const r = analyze(shot, photo, { excludeTop: state.excludeTop, excludeBottom: state.excludeBottom, diff: state.mode === 'diff', threshold: state.threshold });
    state.match = r.score; state.regions = r.regions;
    if (r.diffPng && overlay && !overlay.isDestroyed()) overlay.webContents.send('overlay-diff', 'data:image/png;base64,' + r.diffPng.toString('base64'));
    setStatus(`일치도 ${state.match}% (adb 캡처 ${new Date().toLocaleTimeString()})${state.matchNote ? ' · ' + state.matchNote : ''}`);
  } catch (e) { state.match = null; state.regions = null; setStatus('일치도 계산 실패: ' + e.message); }
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

// ---------- 스포이드 ----------
const hex2 = (n) => n.toString(16).padStart(2, '0').toUpperCase();
function pixelAt(img, cache, fx, fy) {
  const { width, height } = img.getSize();
  const bmp = cache || img.toBitmap();
  const x = Math.min(width - 1, Math.max(0, Math.floor(fx * width))), y = Math.min(height - 1, Math.max(0, Math.floor(fy * height)));
  const i = (y * width + x) * 4;
  return { r: bmp[i + 2], g: bmp[i + 1], b: bmp[i], bmp };
}
function pickColor(fx, fy) {
  if (!photo) return null;
  const p = pixelAt(photo, photoBmp, fx, fy); photoBmp = p.bmp;
  const out = { photo: `#${hex2(p.r)}${hex2(p.g)}${hex2(p.b)}`, emu: null };
  if (lastShot) { const e = pixelAt(lastShot, lastShotBmp, fx, fy); lastShotBmp = e.bmp; out.emu = `#${hex2(e.r)}${hex2(e.g)}${hex2(e.b)}`; }
  const flutter = `Color(0xFF${out.photo.slice(1)})`;
  clipboard.writeText(out.photo);
  addReadout(`색 ${out.photo} · ${flutter}${out.emu ? ` · 앱 화면 ${out.emu}` : ''} (사진 색을 복사함)`);
  return out;
}

// ---------- 창 선택 ----------
function selectWindow(hwnd) {
  const w = winapi.listWindows(ownHwnds()).find((x) => x.hwnd === Number(hwnd));
  if (!w) { setStatus('창을 찾을 수 없습니다.'); return; }
  target = { hwnd: w.hwnd, title: w.title, className: w.className };
  offset = { x: 0, y: 0 }; lastRect = ''; lastDock = ''; missingSince = 0;
  state.targetTitle = w.title;
  state.calibrated = !!cfg().calib[w.className];
  const hint = !photo ? ' — [사진 불러오기]를 누르면 이 창 위에 겹쳐 보입니다.' : state.calibrated ? '' : ' — 더 정확히 맞추려면 [화면 영역 보정]을 하세요.';
  setStatus(`연결: ${w.title}${hint}`);
  winapi.bringToFront(target.hwnd);
  lastOccCheck = 0; syncAway();
  updateVisibility();
  dockControl(true);
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

// ---------- 자동 업데이트 (GitHub Releases, electron-updater) ----------
function setUpdate(st, text, version) { state.update = { state: st, text, version: version || state.update.version || '' }; pushState(); }
function initUpdater() {
  try { ({ autoUpdater } = require('electron-updater')); }
  catch (e) { autoUpdater = null; setUpdate('unavailable', '업데이트 모듈을 불러오지 못했습니다.'); return; }
  if (!app.isPackaged && !process.env.DIFFM_UPDATE_DEV) { autoUpdater = null; setUpdate('dev', '개발 실행에서는 업데이트를 확인하지 않습니다.'); return; }
  if (process.env.DIFFM_UPDATE_DEV) autoUpdater.forceDevUpdateConfig = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => setUpdate('checking', '업데이트 확인 중...'));
  autoUpdater.on('update-available', (i) => setUpdate('downloading', `새 버전 ${i.version} 받는 중...`, i.version));
  autoUpdater.on('update-not-available', () => setUpdate('none', `최신 버전입니다 (v${app.getVersion()}).`));
  autoUpdater.on('download-progress', (p) => setUpdate('downloading', `새 버전 받는 중... ${Math.round(p.percent)}%`));
  autoUpdater.on('update-downloaded', (i) => setUpdate('ready', `새 버전 ${i.version} 준비됨 — [재시작하여 설치]를 누르세요. (종료 시 자동 설치)`, i.version));
  autoUpdater.on('error', (e) => setUpdate('error', '업데이트 확인 실패: ' + String((e && e.message) || e).split('\n')[0]));
  setTimeout(checkUpdate, 4000);
}
function checkUpdate() {
  if (!autoUpdater) { setUpdate(state.update.state, state.update.text || '업데이트를 사용할 수 없습니다.'); return; }
  autoUpdater.checkForUpdates().catch((e) => setUpdate('error', '업데이트 확인 실패: ' + String((e && e.message) || e).split('\n')[0]));
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
  ipcMain.on('set-opacity', (_e, v) => { if (state.mode === 'photo' || state.mode === 'emu') state.mode = 'blend'; state.lastMode = state.mode; setOpacity(v); updateVisibility(); });
  ipcMain.on('set-mode', (_e, m) => { setMode(m); if (m === 'emu' && target) { winapi.bringToFront(target.hwnd); lastOccCheck = 0; syncAway(); } });
  ipcMain.on('toggle-view', () => { const now = Date.now(); if (now - lastToggle < 300) return; lastToggle = now; toggleView(); });
  ipcMain.on('set-split', (_e, v) => { state.split = Math.min(100, Math.max(0, Math.round(v))); config.save({ split: state.split }); pushState(); });
  ipcMain.on('set-threshold', (_e, v) => { state.threshold = Math.min(100, Math.max(1, Math.round(v))); config.save({ threshold: state.threshold }); if (state.mode === 'diff') compareNow(); pushState(); });
  ipcMain.on('set-exclude', (_e, top, bottom) => {
    state.excludeTop = Math.min(80, Math.max(0, Number(top) || 0)); state.excludeBottom = Math.min(80, Math.max(0, Number(bottom) || 0));
    config.save({ excludeTop: state.excludeTop, excludeBottom: state.excludeBottom }); compareNow(); pushState();
  });
  ipcMain.on('set-auto-match', (_e, b) => {
    state.autoMatch = !!b; config.save({ autoMatch: state.autoMatch }); pendingKey = ''; pendingCount = 0; state.matchNote = '';
    setStatus(state.autoMatch ? (files.length > 1 ? '자동 매칭을 켰습니다. 에뮬레이터 화면과 가장 비슷한 사진으로 바뀝니다.' : '자동 매칭: 폴더에 사진이 2장 이상 필요합니다.') : '자동 매칭을 껐습니다.');
    if (state.autoMatch) compareNow();
  });
  ipcMain.on('link-current', linkCurrent);
  ipcMain.on('set-tool', (_e, t) => setTool(t));
  ipcMain.on('set-rulers', (_e, b) => { state.rulers = !!b; config.save({ rulers: state.rulers }); pushState(); });
  ipcMain.on('clear-guides', () => { if (overlay && !overlay.isDestroyed()) overlay.webContents.send('clear-guides'); });
  ipcMain.on('readout', (_e, text) => addReadout(String(text).slice(0, 200)));
  ipcMain.handle('pick-color', (_e, fx, fy) => pickColor(fx, fy));
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
  ipcMain.on('check-update', checkUpdate);
  ipcMain.on('install-update', () => { if (autoUpdater && state.update.state === 'ready') autoUpdater.quitAndInstall(false, true); });
  ipcMain.on('get-state', () => pushState());
}

// ---------- 단축키 ----------
let regKey = '';
let condKeys = [];            // 조건부로 등록한 단축키 목록
let lastToggle = 0, lastStep = 0;

/** F4는 시작할 때 한 번만 등록하고 절대 해제/재등록하지 않는다.
 *  (재등록하면 키를 누르고 있는 동안 자동 반복 입력이 다시 잡혀 전환이 연속으로 일어나는 문제가 있었다) */
function registerF4() {
  try {
    globalShortcut.register('F4', () => {
      const now = Date.now();
      if (now - lastToggle < 300) return; // 키 반복·중복 입력 무시
      lastToggle = now; toggleView();
    });
  } catch {}
}

// F4 외의 전역 단축키는 대상(에뮬레이터) 창이 맨 앞일 때만 등록해 다른 프로그램의 키를 가로채지 않는다.
// 컨트롤 창이 앞일 때는 컨트롤 창 안에서 같은 키를 직접 처리한다(renderer/control.js).
function syncShortcuts() {
  if (!winapi) return;
  const active = !!target && winapi.getForeground() === Number(target.hwnd);
  const nav = active && showsPhoto() && files.length > 0;
  const key = (active ? 'a' : '-') + (nav ? 'n' : '-');
  if (key === regKey) return;
  regKey = key;
  for (const k of condKeys) { try { globalShortcut.unregister(k); } catch {} }
  condKeys = [];
  const reg = (acc, fn) => { try { if (globalShortcut.register(acc, fn)) condKeys.push(acc); } catch {} };
  if (active) {
    const M = 'CommandOrControl+Alt+';
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
  const step = (d) => () => { const now = Date.now(); if (now - lastStep < 150) return; lastStep = now; stepPhoto(d); };
  if (nav) { reg('Left', step(-1)); reg('Right', step(1)); }
}

app.whenReady().then(() => {
  const c = cfg();
  Object.assign(state, {
    version: app.getVersion(), opacity: c.opacity, clickThrough: c.clickThrough, autoFit: c.autoFit, autoCompare: c.autoCompare,
    docked: c.docked, dockSide: c.dockSide, split: c.split, threshold: c.threshold, excludeTop: c.excludeTop,
    excludeBottom: c.excludeBottom, autoMatch: c.autoMatch, rulers: c.rulers,
  });
  state.adbPath = adbLib.findAdb(c.adbPath) || '';
  loadLinks();
  registerIpc(); createControl(); createOverlay(); registerF4(); restartCompareTimer(); initUpdater();
  if (c.photoDir && fs.existsSync(c.photoDir)) refreshDir(c.photoDir);
  if (c.photoPath && fs.existsSync(c.photoPath)) loadPhotoFile(c.photoPath);
  const ctx = {
    selectWindow, loadPhotoFile, setOpacity, toggleView, setMode, setDir, stepPhoto, setTool, linkCurrent, compareNow, pickColor,
    getOverlay: () => overlay, getControl: () => control, getLastShot: () => lastShot, winapi, state, links: () => links,
    setShot: (img) => { lastShot = img; lastShotBmp = null; }, autoMatchStep,
  };
  if (process.argv.includes('--e2e')) require('./test/e2e.cjs')(ctx);
  if (process.argv.includes('--selftest')) require('./test/selftest.cjs')(ctx);
  if (process.argv.includes('--emutest')) require('./test/emulator.cjs')(ctx);
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());

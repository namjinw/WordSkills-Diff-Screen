'use strict';
// Windows 창 목록·위치 조회 (user32 / dwmapi, koffi)
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const dwmapi = koffi.load('dwmapi.dll');

const RECT = koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const POINT = koffi.struct('POINT', { x: 'int32', y: 'int32' });
const EnumProc = koffi.proto('bool __stdcall EnumProc(intptr_t hwnd, intptr_t lparam)');

const EnumWindows = user32.func('bool __stdcall EnumWindows(EnumProc *cb, intptr_t lparam)');
const IsWindow = user32.func('bool __stdcall IsWindow(intptr_t hwnd)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(intptr_t hwnd)');
const IsIconic = user32.func('bool __stdcall IsIconic(intptr_t hwnd)');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(intptr_t hwnd, _Out_ void *buf, int max)');
const GetClassNameW = user32.func('int __stdcall GetClassNameW(intptr_t hwnd, _Out_ void *buf, int max)');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ RECT *rect)');
const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(intptr_t hwnd)');
const ShowWindow = user32.func('bool __stdcall ShowWindow(intptr_t hwnd, int cmd)');
const BringWindowToTop = user32.func('bool __stdcall BringWindowToTop(intptr_t hwnd)');
const SetWindowPos = user32.func('bool __stdcall SetWindowPos(intptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, uint32_t flags)');
const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hwnd, void *pid)');
const AttachThreadInput = user32.func('bool __stdcall AttachThreadInput(uint32_t from, uint32_t to, bool attach)');
const GetCurrentThreadId = koffi.load('kernel32.dll').func('uint32_t __stdcall GetCurrentThreadId()');
const GetWindow = user32.func('intptr_t __stdcall GetWindow(intptr_t hwnd, uint32_t cmd)');
const GetForegroundWindow = user32.func('intptr_t __stdcall GetForegroundWindow()');
const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ POINT *pt)');
const DwmGetRect = dwmapi.func('int __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32_t attr, _Out_ RECT *out, uint32_t size)');
const DwmGetU32 = dwmapi.func('int __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32_t attr, _Out_ uint32_t *out, uint32_t size)');

const DWMWA_CLOAKED = 14;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;

function readStr(fn, hwnd) {
  const buf = Buffer.alloc(1024);
  const n = fn(hwnd, buf, 512);
  return buf.toString('utf16le', 0, n * 2);
}

/** 그림자 테두리를 뺀, 실제로 보이는 창 영역(물리 픽셀). 실패하면 GetWindowRect로 대체 */
function getFrameRect(hwnd) {
  hwnd = Number(hwnd);
  const r = {};
  if (DwmGetRect(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, r, 16) !== 0) {
    if (!GetWindowRect(hwnd, r)) return null;
  }
  return { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top };
}

function isCloaked(hwnd) {
  const out = [0];
  return DwmGetU32(Number(hwnd), DWMWA_CLOAKED, out, 4) === 0 && out[0] !== 0;
}

/** 열려 있는 최상위 창 목록. excludeHwnds: 이 앱 자신의 창 */
function listWindows(excludeHwnds = []) {
  const skip = new Set(excludeHwnds.map(Number));
  const out = [];
  EnumWindows((hwnd) => {
    hwnd = Number(hwnd);
    if (skip.has(hwnd) || !IsWindowVisible(hwnd) || isCloaked(hwnd)) return true;
    const title = readStr(GetWindowTextW, hwnd);
    if (!title.trim()) return true;
    const className = readStr(GetClassNameW, hwnd);
    if (className === 'Progman' || className === 'Shell_TrayWnd') return true;
    const rect = getFrameRect(hwnd);
    if (!rect || rect.width < 50 || rect.height < 50) return true;
    out.push({ hwnd, title, className, rect, minimized: !!IsIconic(hwnd) });
    return true;
  }, 0);
  return out;
}

function windowExists(hwnd) { return !!IsWindow(Number(hwnd)); }
function isMinimized(hwnd) { return !!IsIconic(Number(hwnd)); }
/** 대상 창을 맨 앞으로 (최소화면 복원).
 *  주의: 예전처럼 Alt 키 입력을 흉내 내면 F4와 겹쳐 Alt+F4(창 닫기)가 될 수 있어 쓰지 않는다.
 *  대신 ① 창 순서를 직접 올리고(포커스 권한 불필요) ② 입력 스레드를 잠시 붙여 포커스를 준다. */
function bringToFront(hwnd) {
  hwnd = Number(hwnd);
  if (IsIconic(hwnd)) ShowWindow(hwnd, 9); // SW_RESTORE
  const NOMOVE_NOSIZE_NOACTIVATE = 0x13;
  SetWindowPos(hwnd, -1, 0, 0, 0, 0, NOMOVE_NOSIZE_NOACTIVATE); // HWND_TOPMOST
  SetWindowPos(hwnd, -2, 0, 0, 0, 0, NOMOVE_NOSIZE_NOACTIVATE); // HWND_NOTOPMOST (맨 위 비고정으로 되돌림)
  const fgThread = GetWindowThreadProcessId(GetForegroundWindow(), null);
  const me = GetCurrentThreadId();
  const attach = fgThread && fgThread !== me;
  if (attach) AttachThreadInput(me, fgThread, true);
  BringWindowToTop(hwnd);
  SetForegroundWindow(hwnd);
  if (attach) AttachThreadInput(me, fgThread, false);
}
const SHELL_CLASSES = new Set(['Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'Progman', 'WorkerW', 'NotifyIconOverflowWindow',
  'TopLevelWindowForOverflowXamlIsland', 'Windows.UI.Core.CoreWindow', 'XamlExplorerHostIslandWindow']);

/** hwnd 창 위(z-order)에 다른 창이 rect(물리 px)와 겹쳐 있으면 true. own: 이 앱 자신의 창들은 무시 */
function isOccluded(hwnd, rect, own = []) {
  const skip = new Set(own.map(Number));
  let h = Number(GetWindow(Number(hwnd), 3)); // GW_HWNDPREV: 바로 위 창
  for (let guard = 0; h && guard < 800; guard++, h = Number(GetWindow(h, 3))) {
    if (skip.has(h) || !IsWindowVisible(h) || IsIconic(h) || isCloaked(h)) continue;
    if (!readStr(GetWindowTextW, h).trim()) continue;
    if (SHELL_CLASSES.has(readStr(GetClassNameW, h))) continue;
    const r = getFrameRect(h);
    if (!r) continue;
    const ix = Math.min(r.x + r.width, rect.x + rect.width) - Math.max(r.x, rect.x);
    const iy = Math.min(r.y + r.height, rect.y + rect.height) - Math.max(r.y, rect.y);
    if (ix > 8 && iy > 8) return true;
  }
  return false;
}
function getForeground() { return Number(GetForegroundWindow()); }
function getCursor() { const p = {}; GetCursorPos(p); return { x: p.x, y: p.y }; }

module.exports = { listWindows, getFrameRect, windowExists, isMinimized, bringToFront, getForeground, isOccluded, getCursor };

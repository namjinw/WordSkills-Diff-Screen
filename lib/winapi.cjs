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
const keybd_event = user32.func('void __stdcall keybd_event(uint8_t vk, uint8_t scan, uint32_t flags, uintptr_t extra)');
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
/** 대상 창을 맨 앞으로 (최소화면 복원). Windows의 포커스 제한을 피하려 Alt 키 입력을 한 번 보낸다 */
function bringToFront(hwnd) {
  hwnd = Number(hwnd);
  if (IsIconic(hwnd)) ShowWindow(hwnd, 9); // SW_RESTORE
  keybd_event(0x12, 0, 0, 0); keybd_event(0x12, 0, 2, 0); // Alt 눌렀다 떼기
  SetForegroundWindow(hwnd);
}
function getForeground() { return Number(GetForegroundWindow()); }
function getCursor() { const p = {}; GetCursorPos(p); return { x: p.x, y: p.y }; }

module.exports = { listWindows, getFrameRect, windowExists, isMinimized, bringToFront, getForeground, getCursor };

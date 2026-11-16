'use strict';
// 실제 키 입력(SendKeys)으로 F4/←/→ 시나리오를 재현: electron . --e2e
const { BrowserWindow, app, screen } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (keys) => new Promise((r) => execFile('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${keys}')`], { windowsHide: true }, r));

module.exports = async (ctx) => {
  const { selectWindow, setDir, getOverlay, getControl, winapi, state } = ctx;
  const log = (m) => console.log(m);
  const snap = (tag) => {
    const ov = getOverlay();
    log(`${tag.padEnd(34)} view=${state.mode.padEnd(5)} photo=${state.photoName.padEnd(22)} idx=${state.index + 1}/${state.count} overlay=${ov.isVisible() ? 'SHOW' : 'hide'} fgIsTarget=${winapi.getForeground() === tgt.hwnd} status="${state.status.slice(0, 40)}"`);
  };
  const emu = new BrowserWindow({ x: 300, y: 80, width: 420, height: 880, title: 'Android Emulator - e2e:5554' });
  emu.loadURL('data:text/html,emu');
  let tgt = null;
  for (let i = 0; i < 40 && !tgt; i++) { await sleep(250); tgt = winapi.listWindows().find((w) => w.title.startsWith('Android Emulator - e2e')); }
  selectWindow(tgt.hwnd);
  const dir = JSON.parse(fs.readFileSync(process.env.DIFFM_REAL_CFG, 'utf8')).photoDir;
  setDir(dir); await sleep(1500);
  snap('start');
  const seq = [['{RIGHT}', '→'], ['{RIGHT}', '→'], ['{F4}', 'F4(to emu)'], ['{RIGHT}', '→ in emu (ignored)'], ['{F4}', 'F4(to photo)'], ['{LEFT}', '←'], ['{F4}', 'F4'], ['{F4}', 'F4'], ['{RIGHT}', '→'], ['{RIGHT}', '→'], ['{RIGHT}', '→'], ['{F4}', 'F4'], ['{F4}', 'F4'], ['{LEFT}', '←']];
  for (const [k, name] of seq) { await send(k); await sleep(700); snap('key ' + name); }
  // 빠르게 연타
  for (let i = 0; i < 8; i++) await send('{RIGHT}');
  await sleep(1500); snap('8x → burst');
  await send('{F4}'); await sleep(700); snap('F4 after burst');
  await send('{F4}'); await sleep(700); snap('F4 after burst');
  // 컨트롤 창이 앞일 때(경로 입력 후)
  getControl().focus(); await sleep(500);
  const wc = getControl().webContents;
  for (const k of ['Right', 'F4', 'F4', 'Left']) { wc.sendInputEvent({ type: 'keyDown', keyCode: k }); wc.sendInputEvent({ type: 'keyUp', keyCode: k }); await sleep(700); snap('control key ' + k); }
  emu.destroy(); app.exit(0);
};

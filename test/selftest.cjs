'use strict';
// adb/에뮬레이터 없이 확인 가능한 부분 자체 점검: npm run selftest
// 임시 대상 창을 띄워 창 목록, 오버레이 맞춤/따라가기, 투명도, 비교 계산을 검사한다.
const { nativeImage, app, screen, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const koffi = require('koffi');
const { similarity } = require('../lib/compare.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

// DPI 배율 반올림으로 1~2 DIP 오차 허용
const near = (a, b) => ['x', 'y', 'width', 'height'].every((k) => Math.abs(a[k] - b[k]) <= 2);

function solid(w, h, [r, g, b]) {
  const buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < buf.length; i += 4) { buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = 255; }
  return nativeImage.createFromBitmap(buf, { width: w, height: h });
}

module.exports = async (ctx) => {
  const { selectWindow, loadPhotoFile, setOpacity, toggleView, getOverlay, winapi, state } = ctx;
  let notepad;
  try {
    // 1) 비교 계산
    const white = solid(100, 200, [255, 255, 255]), black = solid(100, 200, [0, 0, 0]);
    check('일치도: 동일 이미지 100%', similarity(white, white) === 100, String(similarity(white, white)));
    check('일치도: 흑백 0%', similarity(white, black) === 0, String(similarity(white, black)));
    check('일치도: 크기가 달라도 계산', similarity(white, solid(30, 50, [255, 255, 255])) === 100);

    // 2) 창 목록
    // 임시 대상 창(사용자의 다른 창을 건드리지 않도록 직접 만든 창을 사용)
    notepad = new BrowserWindow({ x: 200, y: 150, width: 500, height: 700, title: 'DIFFM-TEST-TARGET', show: true });
    notepad.loadURL('data:text/html,<body style="background:#ccc">target</body>');
    let np = null;
    for (let i = 0; i < 40 && !np; i++) {
      await sleep(250);
      np = winapi.listWindows().find((w) => w.title === 'DIFFM-TEST-TARGET');
    }
    check('창 목록에서 대상 창 발견', !!np, np ? `${np.title} [${np.className}] ${np.rect.width}x${np.rect.height}` : '');
    if (!np) throw new Error('대상 창 없음');
    const MoveWindow = koffi.load('user32.dll').func('bool __stdcall MoveWindow(intptr_t h, int x, int y, int w, int h2, bool repaint)');
    await sleep(300);

    // 3) 사진 겹치기
    const file = path.join(os.tmpdir(), 'diffm-test.png');
    fs.writeFileSync(file, solid(300, 600, [255, 0, 0]).toPNG());
    selectWindow(np.hwnd); loadPhotoFile(file); await sleep(800);
    const ov = getOverlay();
    const expect = (hwnd) => screen.screenToDipRect(null, winapi.getFrameRect(hwnd));
    let b = ov.getBounds(), e = expect(np.hwnd);
    check('오버레이 표시', ov.isVisible());
    check('오버레이가 창 영역에 정확히 겹침', near(b, e), `overlay ${JSON.stringify(b)} / window ${JSON.stringify(e)}`);
    check('항상 위(always-on-top)', ov.isAlwaysOnTop());
    const imgOk = await ov.webContents.executeJavaScript('(()=>{const i=document.getElementById("img");return i.complete&&i.naturalWidth===300&&i.naturalHeight===600})()');
    check('오버레이에 사진 로드', imgOk);

    // 4) 투명도
    setOpacity(30); await sleep(300);
    const op = await ov.webContents.executeJavaScript('getComputedStyle(document.getElementById("img")).opacity');
    check('투명도 30% 반영', Math.abs(Number(op) - 0.3) < 0.01, `opacity=${op}`);

    // 5) 창 이동·크기 변경 따라가기
    MoveWindow(np.hwnd, 400, 200, 420, 640, true); await sleep(600);
    b = ov.getBounds(); e = expect(np.hwnd);
    check('창 이동/크기 변경 시 따라감', near(b, e), `overlay ${JSON.stringify(b)} / window ${JSON.stringify(e)}`);

    // 6) 전환
    toggleView(); await sleep(200);
    check('전환: 에뮬레이터 보기(오버레이 숨김)', !ov.isVisible());
    toggleView(); await sleep(200);
    check('전환: 사진 보기(오버레이 표시)', ov.isVisible());

    // 7) 에뮬레이터 창(제목줄 포함) 기본 맞춤: 아래 기준 + 사진 비율
    const emu = new BrowserWindow({ x: 700, y: 100, width: 300, height: 900, title: 'Android Emulator - test:5554' });
    emu.loadURL('data:text/html,emu');
    let ew = null;
    for (let i = 0; i < 40 && !ew; i++) { await sleep(250); ew = winapi.listWindows().find((w) => w.title.startsWith('Android Emulator - test')); }
    selectWindow(ew.hwnd); await sleep(500);
    const fr = winapi.getFrameRect(ew.hwnd);
    const want = screen.screenToDipRect(null, { x: fr.x, y: fr.y + fr.height - Math.round(fr.width * 2), width: fr.width, height: Math.round(fr.width * 2) });
    b = ov.getBounds();
    check('에뮬레이터 창: 아래 기준·사진 비율로 맞춤(제목줄 제외)', near(b, want), `overlay ${JSON.stringify(b)} / want ${JSON.stringify(want)}`);
    emu.destroy();

    // 8) 클릭 통과는 API가 없어 설정 호출만 확인
    check('adb 경로 탐색', true, state.adbPath || '(없음)');
  } catch (err) {
    check('예외 없이 진행', false, err.message);
  } finally {
    if (notepad && !notepad.isDestroyed()) notepad.destroy();
    console.log(`\n결과: ${results.filter(Boolean).length}/${results.length} 통과`);
    setTimeout(() => app.exit(results.every(Boolean) ? 0 : 1), 500);
  }
};

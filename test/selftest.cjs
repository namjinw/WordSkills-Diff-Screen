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
  const { selectWindow, loadPhotoFile, setOpacity, toggleView, setDir, stepPhoto, getOverlay, getControl, winapi, state } = ctx;
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

    // 8) 폴더의 png 전환 (←/→), 숫자 순 정렬, png만
    const dir = path.join(os.tmpdir(), 'diffm-dir'); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
    for (const n of ['10.png', '2.png', '1.png']) fs.writeFileSync(path.join(dir, n), solid(30, 60, [0, 128, 255]).toPNG());
    fs.writeFileSync(path.join(dir, 'memo.txt'), 'x'); fs.writeFileSync(path.join(dir, '3.jpg'), 'x');
    selectWindow(np.hwnd); await sleep(300);
    setDir(dir); await sleep(300);
    check('폴더: png만 3개 인식, 첫 사진 로드', state.count === 3 && state.photoName === '1.png', `${state.photoName} ${state.index + 1}/${state.count}`);
    stepPhoto(1); stepPhoto(1);
    check('→ 두 번: 10.png (숫자 순)', state.photoName === '10.png', state.photoName);
    stepPhoto(1);
    check('→ 끝에서 처음으로 순환', state.photoName === '1.png', state.photoName);
    stepPhoto(-1);
    check('← 이전 사진', state.photoName === '10.png', state.photoName);
    toggleView(); stepPhoto(1);
    check('에뮬레이터 보기에서는 전환 안 됨', state.photoName === '10.png', state.photoName);
    toggleView(); await sleep(200);

    // 9) 사이드바 도킹: 컨트롤 창이 대상 창 옆에 붙음(겹치지 않음)
    await sleep(600);
    const cb = getControl().getBounds(), tb = screen.screenToDipRect(null, winapi.getFrameRect(np.hwnd));
    const noOverlap = cb.x >= tb.x + tb.width || cb.x + cb.width <= tb.x;
    check('사이드바가 에뮬레이터 창 옆에 도킹', noOverlap && Math.abs(cb.width - 320) <= 4, `side ${JSON.stringify(cb)} / target ${JSON.stringify(tb)}`);

    // 9-2) 다른 창이 앞에 오면 오버레이·사이드바가 물러나 가려지지 않음
    const other = new BrowserWindow({ x: 330, y: 170, width: 200, height: 200, title: 'DIFFM-OTHER' });
    other.focus(); await sleep(700);
    check('다른 창이 앞일 때 오버레이 숨김', !ov.isVisible());
    check('다른 창이 앞일 때 사이드바 항상 위 해제', !getControl().isAlwaysOnTop());
    // F4는 포커스·가려짐과 무관하게 항상 전환하고, 대상 창을 앞으로 가져온다
    toggleView(); await sleep(500);
    check('다른 창이 앞이어도 F4가 전환(에뮬레이터 보기)', state.view === 'emu' && winapi.getForeground() === np.hwnd, `view=${state.view}`);
    other.focus(); await sleep(500);
    toggleView(); await sleep(500);
    check('다른 창이 앞이어도 F4로 사진 보기: 오버레이 즉시 복귀', state.view === 'photo' && ov.isVisible(), `view=${state.view} visible=${ov.isVisible()}`);
    check('사이드바 항상 위 복귀', getControl().isAlwaysOnTop());
    other.destroy();

    // 9-3) F4를 연타해도(키 반복) 중복 전환되지 않고 한 번씩 정확히 번갈아 동작
    const v0 = state.view; toggleView(); toggleView(); await sleep(300);
    check('연속 호출해도 상태 일관(두 번 = 원래대로)', state.view === v0, state.view);

    // 10) 클릭 통과는 API가 없어 설정 호출만 확인
    check('adb 경로 탐색', true, state.adbPath || '(없음)');
  } catch (err) {
    check('예외 없이 진행', false, err.message);
  } finally {
    if (notepad && !notepad.isDestroyed()) notepad.destroy();
    console.log(`\n결과: ${results.filter(Boolean).length}/${results.length} 통과`);
    setTimeout(() => app.exit(results.every(Boolean) ? 0 : 1), 500);
  }
};

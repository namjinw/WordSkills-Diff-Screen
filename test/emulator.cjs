'use strict';
// 실제 에뮬레이터(adb 연결 필수) 점검: npm run emutest
// 켜져 있는 에뮬레이터를 그대로 쓰며 종료하지 않는다. 에뮬레이터/adb가 없으면 SKIP.
const { nativeImage, app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const adbLib = require('../lib/adb.cjs');
const { analyze } = require('../lib/compare.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

module.exports = async (ctx) => {
  const { selectWindow, loadPhotoFile, setDir, compareNow, setMode, setTool, pickColor, autoMatchStep, getOverlay, winapi, state } = ctx;
  const done = (code) => { console.log(`\n결과: ${results.filter(Boolean).length}/${results.length} 통과`); setTimeout(() => app.exit(code), 300); };
  try {
    const adb = adbLib.findAdb('');
    if (!adb) { console.log('SKIP  adb를 찾을 수 없음'); return done(0); }
    let devs = '';
    try { devs = (await adbLib.run(adb, ['devices'])).toString(); } catch {}
    if (!/\tdevice/.test(devs)) { console.log('SKIP  연결된 에뮬레이터 없음'); return done(0); }

    // 기기 정보
    const info = await adbLib.deviceInfo(adb);
    check('adb: 해상도·밀도 읽기', !!info.width && !!info.height && !!info.density, JSON.stringify(info));

    // 실제 에뮬레이터 창
    const wins = winapi.listWindows();
    const emu = wins.find((w) => /^Android Emulator - /.test(w.title));
    check('에뮬레이터 창 발견', !!emu, emu ? `[${emu.className}] ${emu.title} ${emu.rect.width}x${emu.rect.height}` : '');
    if (!emu) return done(1);
    const toolbar = wins.find((w) => w.className.startsWith('Qt') && w.title === 'Emulator');
    console.log(`INFO  측면 도구 막대: ${toolbar ? `별도 최상위 창 [${toolbar.className}] ${toolbar.rect.width}x${toolbar.rect.height} (메인 창 오른쪽 끝 ${emu.rect.x + emu.rect.width} / 도구막대 왼쪽 ${toolbar.rect.x})` : '없음'}`);
    // AVD가 저장해 둔 창 위치가 현재 모니터 밖일 수 있어, 눈에 보이는 곳으로 옮겨 놓고 시작한다
    const MoveWindow = require('koffi').load('user32.dll').func('bool __stdcall MoveWindow(intptr_t h, int x, int y, int w, int h2, bool repaint)');
    const PostMessageW = require('koffi').load('user32.dll').func('bool __stdcall PostMessageW(intptr_t h, uint32_t m, uintptr_t w, intptr_t l)');
    for (const w of wins.filter((x) => x.title === 'Compatibility Warnings')) { PostMessageW(w.hwnd, 0x10, 0, 0); console.log('INFO  에뮬레이터의 "Compatibility Warnings" 대화상자를 닫음(화면을 가려서 오버레이가 물러남)'); }
    await sleep(600);
    const f0 = winapi.getFrameRect(emu.hwnd);
    MoveWindow(emu.hwnd, 250, 0, f0.width, f0.height, true); await sleep(700);
    selectWindow(emu.hwnd); await sleep(1200);

    // 실제 화면을 "사진"으로 쓰는 자기 검증
    const png = await adbLib.screencap(adb);
    const shot = nativeImage.createFromBuffer(png);
    const sz = shot.getSize();
    check('screencap: 기기 해상도와 일치', sz.width === info.width && sz.height === info.height, `${sz.width}x${sz.height}`);
    const dir = path.join(os.tmpdir(), 'diffm-emu'); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
    const me = path.join(dir, '050. 현재화면.png'); fs.writeFileSync(me, png);
    // 가짜 후보(실제 프로토타입 사진이 있으면 그것들)
    let decoys = 0;
    try {
      const real = JSON.parse(fs.readFileSync(process.env.DIFFM_REAL_CFG, 'utf8')).photoDir;
      for (const f of fs.readdirSync(real).filter((n) => /\.png$/i.test(n)).slice(0, 8)) { fs.copyFileSync(path.join(real, f), path.join(dir, f)); decoys++; }
    } catch {}
    if (!decoys) for (let i = 1; i <= 3; i++) { const b = Buffer.alloc(100 * 200 * 4, 40 * i); fs.writeFileSync(path.join(dir, `00${i}. 가짜.png`), nativeImage.createFromBitmap(b, { width: 100, height: 200 }).toPNG()); }
    console.log(`INFO  후보 사진: 현재화면 1장 + 다른 사진 ${decoys || 3}장`);

    setDir(dir); await sleep(500);
    loadPhotoFile(me); await sleep(300);
    await compareNow(); await sleep(500);
    check('일치도: 같은 화면을 사진으로 쓰면 ≈100%', state.match != null && state.match >= 99, `match=${state.match} 구역=${JSON.stringify(state.regions)}`);

    // 오버레이가 실제 에뮬레이터 화면 영역에 겹치는지(보정 전 기본 맞춤: 아래 기준·사진 비율)
    const ov = getOverlay();
    const fr = winapi.getFrameRect(emu.hwnd);
    const { screen } = require('electron');
    const want = screen.screenToDipRect(null, { x: fr.x, y: fr.y + fr.height - Math.round(fr.width * info.height / info.width), width: fr.width, height: Math.round(fr.width * info.height / info.width) });
    const b = ov.getBounds();
    const near = (a, c) => ['x', 'y', 'width', 'height'].every((k) => Math.abs(a[k] - c[k]) <= 3);
    check('오버레이: 에뮬레이터 화면 영역(제목줄 제외)에 겹침', near(b, want), `overlay ${JSON.stringify(b)} / want ${JSON.stringify(want)}`);
    console.log(`INFO  창 높이 ${fr.height} − 화면 높이 ${want.height > 0 ? Math.round(fr.width * info.height / info.width) : '?'} = 제목줄 추정 ${fr.height - Math.round(fr.width * info.height / info.width)}px`);

    // 일부를 칠한 사진: 일치도 하락 + 구역별 + 차이 이미지
    const bm = Buffer.from(shot.toBitmap());
    for (let y = Math.floor(sz.height * 0.7); y < sz.height; y++) for (let x = 0; x < sz.width; x++) { const i = (y * sz.width + x) * 4; bm[i] = 255; bm[i + 1] = 0; bm[i + 2] = 255; }
    const painted = nativeImage.createFromBitmap(bm, { width: sz.width, height: sz.height });
    const a = analyze(shot, painted, { diff: true });
    check('칠한 사진: 하단 구역만 크게 하락', a.regions[0] > 99 && a.regions[2] < a.regions[0] - 20, JSON.stringify(a.regions));
    const exclude = analyze(shot, painted, { excludeBottom: 32 });
    check('칠한 사진: 하단 32% 제외하면 ≈100%', exclude.score > 99, String(exclude.score));
    const d = nativeImage.createFromBuffer(a.diffPng), dbm = d.toBitmap(), ds = d.getSize();
    const al = (fy) => dbm[(Math.floor(fy * ds.height) * ds.width + Math.floor(ds.width / 2)) * 4 + 3];
    check('차이 이미지: 칠한 하단만 표시', al(0.3) === 0 && al(0.9) > 80, `상 ${al(0.3)} 하 ${al(0.9)}`);

    // 자동 매칭: 다른 사진을 보고 있다가 현재 화면 사진으로 돌아오는지
    const decoyFile = fs.readdirSync(dir).find((n) => n !== path.basename(me));
    loadPhotoFile(path.join(dir, decoyFile), { noCompare: true });
    state.autoMatch = true;
    ctx.compareNow();
    for (let i = 0; i < 30 && state.photoName !== path.basename(me); i++) await sleep(500); // 1.5초 주기 + 2회 연속 확인을 기다림
    check('자동 매칭: 실제 에뮬레이터 화면과 같은 사진을 후보 속에서 선택', state.photoName === path.basename(me), `선택=${state.photoName} / ${state.status}`);
    state.autoMatch = false;

    // 스포이드: 에뮬레이터 화면의 실제 픽셀과 일치
    loadPhotoFile(me, { noCompare: true }); await compareNow(); await sleep(300);
    const cx = Math.floor(sz.width * 0.5), cy = Math.floor(sz.height * 0.5);
    const i = (cy * sz.width + cx) * 4, sb = shot.toBitmap();
    const hex = (n) => n.toString(16).padStart(2, '0').toUpperCase();
    const want2 = `#${hex(sb[i + 2])}${hex(sb[i + 1])}${hex(sb[i])}`;
    const pc = pickColor(0.5, 0.5);
    // 화면이 움직이는 중일 수 있어 같은 색 계열인지 폭넓게 확인
    check('스포이드: 사진 색 = 에뮬레이터 화면 픽셀', !!pc && pc.photo === want2, `사진 ${pc && pc.photo} / 화면 ${want2} / 앱 ${pc && pc.emu}`);

    // 측정: 실제 밀도로 dp 환산
    setMode('blend'); setTool('measure'); await sleep(400);
    state.readout.length = 0;
    await ov.webContents.executeJavaScript(`(() => { const W = innerWidth, H = innerHeight; const f = (t, x, y) => document.dispatchEvent(new MouseEvent(t, { clientX: x, clientY: y, button: 0, bubbles: true })); f('mousedown', 0, 0); f('mousemove', W, H * 0.1); f('mouseup', W, H * 0.1); })()`);
    await sleep(300);
    const m = /측정 ([0-9.]+) × ([0-9.]+) dp/.exec(state.readout[0] || '');
    const dpW = info.width * 160 / info.density, dpH = info.height * 160 / info.density;
    check('측정: 화면 전체 폭 × 높이 10% → 실제 dp', !!m && Math.abs(+m[1] - dpW) < 2 && Math.abs(+m[2] - dpH * 0.1) < 2, `${state.readout[0]} / 기대 ${dpW.toFixed(1)} × ${(dpH * 0.1).toFixed(1)}`);
    setTool('measure');

    // 화면 텍스트(uiautomator) — 화면 이름 연결에 쓸 수 있는지 조사만 한다
    try {
      const t = await adbLib.screenTexts(adb);
      console.log(`INFO  uiautomator 화면 텍스트 ${t.length}개: ${t.slice(0, 6).join(' | ')}`);
    } catch (e) { console.log('INFO  uiautomator 실패: ' + e.message); }
    done(results.every(Boolean) ? 0 : 1);
  } catch (e) {
    check('예외 없이 진행', false, e.stack || e.message);
    done(1);
  }
};

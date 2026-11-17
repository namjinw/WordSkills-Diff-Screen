'use strict';
// 모드 전이·비교 엔진·자동 매칭·연결·도구 점검 (selftest에서 호출)
const { nativeImage, clipboard } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { analyze } = require('../lib/compare.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function solid(w, h, [r, g, b]) {
  const buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < buf.length; i += 4) { buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = 255; }
  return nativeImage.createFromBitmap(buf, { width: w, height: h });
}
function stripes(c1, c2, vertical) {
  const W = 60, H = 120, buf = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = ((vertical ? x : y) >> 3) % 2 ? c1 : c2; const i = (y * W + x) * 4;
    buf[i] = c[2]; buf[i + 1] = c[1]; buf[i + 2] = c[0]; buf[i + 3] = 255;
  }
  return nativeImage.createFromBitmap(buf, { width: W, height: H });
}

module.exports = async function features(ctx, check) {
  const { setMode, toggleView, setDir, loadPhotoFile, setTool, linkCurrent, pickColor, setShot, autoMatchStep, links, getOverlay, state } = ctx;
  const ov = getOverlay();

  // 보기 모드 전이 전수: 어떤 모드든 F4로 앱(emu)에 갔다가 같은 모드로 돌아온다
  for (const mo of ['photo', 'blend', 'split', 'diff']) {
    setMode(mo); await sleep(250);
    const vis = ov.isVisible();
    toggleView(); await sleep(250);
    const hidden = !ov.isVisible() && state.mode === 'emu';
    toggleView(); await sleep(250);
    check(`모드 ${mo}: 표시 → F4(앱) → F4(복귀)`, vis && hidden && state.mode === mo && ov.isVisible(), `mode=${state.mode}`);
  }
  setMode('emu'); await sleep(250);
  check('모드 emu: 오버레이 숨김', !ov.isVisible());
  setMode('blend'); await sleep(250);

  // 비교 엔진: 일치도·구역별·제외 영역·차이 이미지
  {
    const W = 90, H = 180;
    const base = solid(W, H, [30, 120, 220]);
    const bm = Buffer.from(base.toBitmap());
    for (let y = Math.floor(H * 2 / 3); y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; bm[i] = 255; bm[i + 1] = 255; bm[i + 2] = 255; }
    const edited = nativeImage.createFromBitmap(bm, { width: W, height: H });
    const same = analyze(base, base, { diff: true });
    check('분석: 동일 이미지 100% / 구역 모두 100%', same.score === 100 && same.regions.every((r) => r === 100), JSON.stringify(same.regions));
    const a = analyze(base, edited, { diff: true, threshold: 20 });
    check('분석: 아래 구역만 낮음(상·중 100%, 하 50% 미만)', a.regions[0] === 100 && a.regions[1] === 100 && a.regions[2] < 50, JSON.stringify(a.regions));
    const ex = analyze(base, edited, { excludeBottom: 34 });
    check('분석: 하단 34% 제외하면 100%', ex.score === 100, String(ex.score));
    const dimg = nativeImage.createFromBuffer(a.diffPng), dbm = dimg.toBitmap(), dsz = dimg.getSize();
    const px = (fy) => (Math.floor(fy * dsz.height) * dsz.width + Math.floor(dsz.width / 2)) * 4;
    check('차이 이미지: 달라진 아래쪽만 불투명, 위쪽은 투명', dbm[px(0.1) + 3] === 0 && dbm[px(0.5) + 3] === 0 && dbm[px(0.9) + 3] > 80, `alpha 상 ${dbm[px(0.1) + 3]} 중 ${dbm[px(0.5) + 3]} 하 ${dbm[px(0.9) + 3]}`);
    const i9 = px(0.9);
    check('차이 이미지 색 순서(BGRA): 붉은색', dbm[i9 + 2] > dbm[i9] && dbm[i9 + 2] > dbm[i9 + 1], `B${dbm[i9]} G${dbm[i9 + 1]} R${dbm[i9 + 2]}`);
  }

  // 자동 매칭·화면 연결
  {
    const mdir = path.join(os.tmpdir(), 'diffm-match'); fs.rmSync(mdir, { recursive: true, force: true }); fs.mkdirSync(mdir);
    const imgs = { '1.png': stripes([255, 0, 0], [0, 0, 0], true), '2.png': stripes([0, 255, 0], [0, 0, 255], false), '3.png': stripes([255, 255, 0], [255, 0, 255], true) };
    for (const [n, im] of Object.entries(imgs)) fs.writeFileSync(path.join(mdir, n), im.toPNG());
    setDir(mdir); await sleep(300);
    state.autoMatch = true;
    setShot(imgs['2.png']);
    await autoMatchStep(imgs['2.png']);
    check('자동 매칭: 1회만으로는 바뀌지 않음(안정성 확인 대기)', state.photoName === '1.png', state.photoName);
    await autoMatchStep(imgs['2.png']);
    check('자동 매칭: 2회 연속 확인되면 2.png로 전환', state.photoName === '2.png', state.photoName);
    await autoMatchStep(imgs['2.png']); await autoMatchStep(imgs['2.png']);
    check('자동 매칭: 이미 맞으면 유지', state.photoName === '2.png', state.photoName);
    // 앱 화면이 사진과 많이 다를 때: 연결해 두면 그 화면을 보고 사진을 찾는다
    const appScreen = stripes([200, 200, 200], [20, 20, 20], true);
    loadPhotoFile(path.join(mdir, '3.png'), { noCompare: true }); setShot(appScreen);
    linkCurrent();
    check('화면↔사진 연결 저장', state.links === 1 && Object.keys(links()).length === 1, `links=${state.links}`);
    loadPhotoFile(path.join(mdir, '1.png'), { noCompare: true });
    await autoMatchStep(appScreen); await autoMatchStep(appScreen);
    check('연결한 화면이 나타나면 연결된 사진(3.png)으로 자동 전환', state.photoName === '3.png', state.photoName);
    // 앱 화면(F4)을 보는 중에 자동 매칭이 사진을 바꿔도 오버레이가 다시 뜨면 안 된다
    setMode('emu'); await sleep(250);
    loadPhotoFile(path.join(mdir, '1.png'), { noCompare: true, keepMode: true });
    await autoMatchStep(imgs['2.png']); await autoMatchStep(imgs['2.png']);
    check('앱 보는 중 자동 매칭: 사진은 바뀌어도 모드는 emu 유지·오버레이 숨김', state.photoName === '2.png' && state.mode === 'emu' && !ov.isVisible(), state.photoName + ' ' + state.mode);
    setMode('blend'); await sleep(250);
    state.autoMatch = false;
  }

  // 도구: 스포이드(색 읽기), 측정(dp 환산), 가이드
  {
    fs.writeFileSync(path.join(os.tmpdir(), 'diffm-col.png'), solid(40, 80, [0x12, 0x34, 0x56]).toPNG());
    loadPhotoFile(path.join(os.tmpdir(), 'diffm-col.png'), { noCompare: true });
    setShot(solid(40, 80, [0xAB, 0xCD, 0xEF]));
    const pc = pickColor(0.5, 0.5);
    check('스포이드: 사진 #123456 / 앱 화면 #ABCDEF', !!pc && pc.photo === '#123456' && pc.emu === '#ABCDEF', JSON.stringify(pc));
    { const ct = await clipboard.readText(); check('스포이드: 클립보드에 사진 색 복사', ct === '#123456', JSON.stringify(ct)); }
    state.dev = { w: 1080, h: 2400, density: 420 };   // adb 기기 유무와 상관없이 같은 조건(Pixel 7)으로 검사
    setMode('blend'); setTool('measure'); await sleep(400);
    check('측정 도구 켜짐', state.tool === 'measure');
    state.readout.length = 0;
    await ov.webContents.executeJavaScript(`(() => { const W = innerWidth, H = innerHeight; const fire = (t, x, y) => document.dispatchEvent(new MouseEvent(t, { clientX: x, clientY: y, button: 0, bubbles: true })); fire('mousedown', W * 0.25, H * 0.25); fire('mousemove', W * 0.75, H * 0.5); fire('mouseup', W * 0.75, H * 0.5); })()`);
    await sleep(300);
    const line = state.readout[0] || '';
    const m = /측정 ([0-9.]+) × ([0-9.]+) dp/.exec(line);
    // 기기 정보가 없으면 Pixel 7 기본값(1080x2400, 420dpi → 411.4 x 914.3 dp)
    check('측정: 폭 50%·높이 25% 드래그 → dp 환산', !!m && Math.abs(+m[1] - 411.4 * 0.5) < 3 && Math.abs(+m[2] - 914.3 * 0.25) < 3, line);
    setTool('measure'); await sleep(200);
    check('도구 끄면 상태 복귀', state.tool === null);
    setTool('guide'); await sleep(200);
    await ov.webContents.executeJavaScript(`document.dispatchEvent(new MouseEvent('mousedown', { clientX: innerWidth / 2, clientY: 5, button: 0, bubbles: true }))`);
    setTool('guide'); setTool('pick'); setTool('pick');
    check('도구 전환·해제 상태 일관', state.tool === null);
  }
};

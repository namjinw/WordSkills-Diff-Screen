// 에뮬레이터 화면 위에 겹쳐지는 투명 오버레이: 사진/분할/차이 + 눈금자·가이드·측정·스포이드
const photo = document.getElementById('photo');
const diff = document.getElementById('diff');
const divider = document.getElementById('divider');
const badge = document.getElementById('badge');
const hud = document.getElementById('hud');
const ctx = hud.getContext('2d');
const A = window.api;

let S = { opacity: 50, mode: 'blend', split: 50, match: null, regions: null, tool: null, rulers: false, dev: { dpW: 412, dpH: 915, pxW: 1080, pxH: 2400, estimated: true } };
let hasDiff = false;
const guides = [];            // { axis: 'x'|'y', dp }
let measure = null;           // { x0, y0, x1, y1 } (css px)
let dragging = false;
let tip = null;               // { x, y, lines, sw, until }
const RULER = 18;

// 오버레이는 에뮬레이터 화면 영역과 같은 비율이므로 가로·세로를 각각 dp로 환산한다
const hDp = (px) => px * S.dev.dpW / window.innerWidth;
const vDp = (px) => px * S.dev.dpH / window.innerHeight;
const hPx = (dp) => dp * window.innerWidth / S.dev.dpW;
const vPx = (dp) => dp * window.innerHeight / S.dev.dpH;
const r1 = (v) => Math.round(v * 10) / 10;

function render() {
  const showDiff = S.mode === 'diff';
  photo.style.display = showDiff ? 'none' : 'block';
  diff.style.display = showDiff && hasDiff ? 'block' : 'none';
  photo.style.opacity = S.opacity / 100;
  diff.style.opacity = Math.max(0.4, S.opacity / 100);
  photo.style.clipPath = S.mode === 'split' ? `inset(0 ${100 - S.split}% 0 0)` : 'none';
  divider.style.display = S.mode === 'split' ? 'block' : 'none';
  divider.style.left = S.split + '%';
  const r = S.regions;
  badge.textContent = '일치도 ' + (S.match == null ? '--' : S.match) + '%' +
    (r ? `\n상 ${r[0]}% · 중 ${r[1]}% · 하 ${r[2]}%` : '') +
    (showDiff && !hasDiff ? '\n차이 계산 중… (adb 필요)' : '');
  drawHud();
}

function drawRulers(w, h) {
  ctx.fillStyle = 'rgba(15,18,28,.78)';
  ctx.fillRect(0, 0, w, RULER); ctx.fillRect(0, 0, RULER, h);
  ctx.strokeStyle = 'rgba(200,210,235,.9)'; ctx.fillStyle = 'rgba(220,228,245,.95)'; ctx.lineWidth = 1;
  ctx.font = '9px Segoe UI, sans-serif'; ctx.textBaseline = 'top';
  for (let d = 0; d <= S.dev.dpW; d += 10) {
    const x = Math.round(hPx(d)) + .5, major = d % 50 === 0;
    ctx.beginPath(); ctx.moveTo(x, RULER); ctx.lineTo(x, RULER - (major ? 10 : 5)); ctx.stroke();
    if (d % 100 === 0) ctx.fillText(String(d), x + 2, 1);
  }
  for (let d = 0; d <= S.dev.dpH; d += 10) {
    const y = Math.round(vPx(d)) + .5, major = d % 50 === 0;
    ctx.beginPath(); ctx.moveTo(RULER, y); ctx.lineTo(RULER - (major ? 10 : 5), y); ctx.stroke();
    if (d % 100 === 0) { ctx.save(); ctx.translate(1, y); ctx.rotate(-Math.PI / 2); ctx.fillText(String(d), 2, 1); ctx.restore(); }
  }
}

function measureLabel(m) {
  const w = Math.abs(m.x1 - m.x0), h = Math.abs(m.y1 - m.y0);
  return {
    dp: `${r1(hDp(w))} × ${r1(vDp(h))} dp`,
    px: `${Math.round(w / window.innerWidth * S.dev.pxW)} × ${Math.round(h / window.innerHeight * S.dev.pxH)} px`,
  };
}

function drawHud() {
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth, h = window.innerHeight;
  if (hud.width !== Math.round(w * dpr) || hud.height !== Math.round(h * dpr)) { hud.width = Math.round(w * dpr); hud.height = Math.round(h * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (S.rulers || S.tool === 'guide') drawRulers(w, h);
  ctx.font = '11px Segoe UI, Malgun Gothic, sans-serif'; ctx.textBaseline = 'alphabetic';
  for (const g of guides) {
    ctx.strokeStyle = '#00e0ff'; ctx.lineWidth = 1;
    const p = Math.round(g.axis === 'x' ? hPx(g.dp) : vPx(g.dp)) + .5;
    ctx.beginPath();
    if (g.axis === 'x') { ctx.moveTo(p, 0); ctx.lineTo(p, h); } else { ctx.moveTo(0, p); ctx.lineTo(w, p); }
    ctx.stroke();
    const label = r1(g.dp) + 'dp';
    const tw = ctx.measureText(label).width + 6;
    const lx = g.axis === 'x' ? p + 3 : w - tw - 3, ly = g.axis === 'x' ? RULER + 14 : p - 3;
    ctx.fillStyle = 'rgba(0,0,0,.7)'; ctx.fillRect(lx, ly - 12, tw, 15);
    ctx.fillStyle = '#00e0ff'; ctx.fillText(label, lx + 3, ly);
  }
  if (measure) {
    const x = Math.min(measure.x0, measure.x1), y = Math.min(measure.y0, measure.y1);
    const mw = Math.abs(measure.x1 - measure.x0), mh = Math.abs(measure.y1 - measure.y0);
    ctx.strokeStyle = '#ffd400'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 3]); ctx.strokeRect(x + .5, y + .5, mw, mh); ctx.setLineDash([]);
    const t = measureLabel(measure).dp;
    const tw = ctx.measureText(t).width + 10;
    const tx = Math.min(Math.max(2, x), w - tw - 2), ty = y > 24 ? y - 6 : y + mh + 16;
    ctx.fillStyle = 'rgba(0,0,0,.8)'; ctx.fillRect(tx, ty - 13, tw, 18);
    ctx.fillStyle = '#ffd400'; ctx.fillText(t, tx + 5, ty);
  }
  if (tip && Date.now() < tip.until) {
    ctx.font = '12px Segoe UI, Malgun Gothic, sans-serif';
    const tw = Math.max(...tip.lines.map((l) => ctx.measureText(l).width)) + 24;
    const tx = Math.min(Math.max(2, tip.x + 12), w - tw - 2), ty = Math.min(Math.max(2, tip.y + 12), h - tip.lines.length * 17 - 8);
    ctx.fillStyle = 'rgba(0,0,0,.85)'; ctx.fillRect(tx, ty, tw, tip.lines.length * 17 + 6);
    tip.lines.forEach((l, i) => {
      ctx.fillStyle = tip.sw[i] || 'transparent'; ctx.fillRect(tx + 5, ty + 5 + i * 17, 10, 12);
      ctx.fillStyle = '#fff'; ctx.fillText(l, tx + 20, ty + 16 + i * 17);
    });
  }
}

// ---- 입력 (도구가 켜져 있을 때만 메인이 클릭 통과를 끈다)
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (S.tool !== 'guide' || !guides.length) return;
  let best = -1, bd = 12;
  guides.forEach((g, i) => {
    const d = Math.abs((g.axis === 'x' ? e.clientX - hPx(g.dp) : e.clientY - vPx(g.dp)));
    if (d < bd) { bd = d; best = i; }
  });
  if (best >= 0) { guides.splice(best, 1); drawHud(); }
});
document.addEventListener('mousedown', async (e) => {
  if (e.button !== 0) return;
  const x = e.clientX, y = e.clientY;
  if (S.tool === 'measure') { dragging = true; measure = { x0: x, y0: y, x1: x, y1: y }; drawHud(); }
  else if (S.tool === 'guide') {
    if (y <= RULER) guides.push({ axis: 'x', dp: Math.round(hDp(x) * 2) / 2 });        // 위쪽 눈금자 → 세로선
    else if (x <= RULER) guides.push({ axis: 'y', dp: Math.round(vDp(y) * 2) / 2 });   // 왼쪽 눈금자 → 가로선
    drawHud();
  } else if (S.tool === 'pick') {
    const r = await A.pickColor(x / window.innerWidth, y / window.innerHeight);
    if (!r) return;
    tip = { x, y, until: Date.now() + 3500, lines: [`사진 ${r.photo}`, ...(r.emu ? [`앱 ${r.emu}`] : []), '(사진 색 복사됨)'], sw: [r.photo, ...(r.emu ? [r.emu] : [])] };
    drawHud(); setTimeout(drawHud, 3600);
  }
});
document.addEventListener('mousemove', (e) => { if (dragging && measure) { measure.x1 = e.clientX; measure.y1 = e.clientY; drawHud(); } });
document.addEventListener('mouseup', () => {
  if (!dragging || !measure) return;
  dragging = false;
  if (Math.abs(measure.x1 - measure.x0) > 2 || Math.abs(measure.y1 - measure.y0) > 2) {
    const l = measureLabel(measure);
    A.readout(`측정 ${l.dp} (${l.px}) · 기기 ${S.dev.pxW}×${S.dev.pxH}px @${S.dev.density}dpi${S.dev.estimated ? ' (기본값)' : ''}`);
  }
});

A.onOverlayImage((url) => { photo.src = url; });
A.onOverlayDiff((url) => { diff.src = url; hasDiff = true; render(); });
A.onClearGuides(() => { guides.length = 0; measure = null; drawHud(); });
A.onOverlay((s) => {
  S = { ...S, ...s };
  if (!S.tool) { measure = null; dragging = false; }
  render();
});
window.addEventListener('resize', drawHud);
render();

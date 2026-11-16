'use strict';
// 두 이미지 비교: 일치도(%), 구역별 일치도, 차이 이미지, 폴더 사진 자동 매칭.
// nativeImage.toBitmap()은 BGRA 순서다. 차이 이미지도 같은 순서(미리 곱한 알파)로 만든다.
const { nativeImage } = require('electron');

const SCORE_SIDE = 480;   // 일치도 계산용 최대 변(px)
const THUMB_SIDE = 160;   // 자동 매칭용 썸네일 최대 변(px)

function fitSize(w, h, maxSide) {
  const k = Math.min(1, maxSide / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** 행 범위의 색 차이 합과 픽셀 수 */
function rowsDiff(A, B, w, y0, y1) {
  let sum = 0;
  for (let y = y0; y < y1; y++) {
    let i = y * w * 4;
    for (let x = 0; x < w; x++, i += 4) {
      sum += Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]);
    }
  }
  return { sum, n: Math.max(0, (y1 - y0) * w) };
}
const toPct = (sum, n) => (n ? Math.round((1 - sum / (n * 3 * 255)) * 1000) / 10 : 0);

function clampBands(h, excludeTop = 0, excludeBottom = 0) {
  const t = Math.min(90, Math.max(0, Number(excludeTop) || 0));
  const b = Math.min(90 - t, Math.max(0, Number(excludeBottom) || 0));
  const y0 = Math.floor(h * t / 100), y1 = h - Math.floor(h * b / 100);
  return { y0, y1: Math.max(y0 + 1, y1) };
}

/**
 * shot: 에뮬레이터 화면(nativeImage), photo: 프로토타입 사진(nativeImage)
 * opts: { excludeTop%, excludeBottom%, diff: bool, threshold: 1~100(차이가 이 % 이상인 픽셀만 표시) }
 * 반환: { score, regions:[상,중,하], diffPng? }
 */
function analyze(shot, photo, opts = {}) {
  const s = shot.getSize();
  if (!s.width || !s.height) throw new Error('빈 이미지');
  const { w, h } = fitSize(s.width, s.height, SCORE_SIDE);
  const A = shot.resize({ width: w, height: h, quality: 'good' }).toBitmap();
  const B = photo.resize({ width: w, height: h, quality: 'good' }).toBitmap(); // 사진을 화면과 같은 크기로 맞춤
  const { y0, y1 } = clampBands(h, opts.excludeTop, opts.excludeBottom);
  const all = rowsDiff(A, B, w, y0, y1);
  const span = y1 - y0;
  const cuts = [y0, y0 + Math.round(span / 3), y0 + Math.round(span * 2 / 3), y1];
  const regions = [0, 1, 2].map((k) => { const r = rowsDiff(A, B, w, cuts[k], cuts[k + 1]); return toPct(r.sum, r.n); });
  const out = { score: toPct(all.sum, all.n), regions };
  if (opts.diff) out.diffPng = buildDiff(A, B, w, h, y0, y1, opts.threshold);
  return out;
}

/** 차이가 큰 픽셀을 붉게 표시한 투명 PNG (에뮬레이터 화면 위에 그대로 덮어 볼 수 있다) */
function buildDiff(A, B, w, h, y0, y1, thresholdPct = 20) {
  const thr = Math.min(100, Math.max(1, Number(thresholdPct) || 20)) / 100;
  const out = Buffer.alloc(w * h * 4); // 전부 투명
  for (let y = y0; y < y1; y++) {
    let i = y * w * 4;
    for (let x = 0; x < w; x++, i += 4) {
      const d = (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2])) / 765;
      if (d < thr) continue;
      const a = Math.min(235, Math.round(90 + d * 300));
      out[i] = Math.round(60 * a / 255);     // B
      out[i + 1] = Math.round(40 * a / 255); // G
      out[i + 2] = a;                        // R (255 * a / 255)
      out[i + 3] = a;
    }
  }
  return nativeImage.createFromBitmap(out, { width: w, height: h }).toPNG();
}

/** 자동 매칭용: 사진 썸네일(비율 유지) */
function makeThumb(img) {
  const s = img.getSize();
  const { w, h } = fitSize(s.width, s.height, THUMB_SIDE);
  return { w, h, bmp: img.resize({ width: w, height: h, quality: 'good' }).toBitmap() };
}

/** 에뮬레이터 화면과 가장 비슷한 후보 순위. candidates: [{key, thumbs:[{w,h,bmp}]}] */
function matchBest(shot, candidates, opts = {}) {
  const cache = new Map();
  const shotAt = (w, h) => {
    const k = w + 'x' + h;
    if (!cache.has(k)) cache.set(k, shot.resize({ width: w, height: h, quality: 'good' }).toBitmap());
    return cache.get(k);
  };
  const scores = [];
  for (const c of candidates) {
    let best = -1;
    for (const t of c.thumbs) {
      const { y0, y1 } = clampBands(t.h, opts.excludeTop, opts.excludeBottom);
      const r = rowsDiff(shotAt(t.w, t.h), t.bmp, t.w, y0, y1);
      best = Math.max(best, toPct(r.sum, r.n));
    }
    scores.push({ key: c.key, score: best });
  }
  scores.sort((a, b) => b.score - a.score);
  return scores;
}

/** (호환) 두 nativeImage의 일치도만 */
function similarity(a, b, opts = {}) { return analyze(a, b, opts).score; }

module.exports = { analyze, similarity, makeThumb, matchBest, clampBands };

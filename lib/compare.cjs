'use strict';
// 두 이미지의 평균 픽셀 색 차이로 일치도(%) 계산. 비교 속도를 위해 같은 비율로 줄여서 비교한다.
const { nativeImage } = require('electron');

const MAX_SIDE = 480;

function similarity(a, b) {
  const size = a.getSize();
  if (!size.width || !size.height) throw new Error('빈 이미지');
  const k = Math.min(1, MAX_SIDE / Math.max(size.width, size.height));
  const w = Math.max(1, Math.round(size.width * k)), h = Math.max(1, Math.round(size.height * k));
  const A = a.resize({ width: w, height: h, quality: 'good' }).toBitmap();
  const B = b.resize({ width: w, height: h, quality: 'good' }).toBitmap(); // b를 a와 같은 크기로 맞춤
  let sum = 0;
  const n = w * h;
  for (let i = 0; i < n * 4; i += 4) {
    sum += Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]);
  }
  return Math.round((1 - sum / (n * 3 * 255)) * 1000) / 10; // 소수 1자리
}

/** pngBuffer(에뮬레이터 화면) vs photoImage(프로토타입 사진) */
function compareToPhoto(pngBuffer, photoImage) {
  const shot = nativeImage.createFromBuffer(pngBuffer);
  if (shot.isEmpty()) throw new Error('에뮬레이터 화면을 해석하지 못했습니다');
  return similarity(shot, photoImage);
}

module.exports = { similarity, compareToPhoto };

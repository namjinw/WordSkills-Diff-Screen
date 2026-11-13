const msg = document.getElementById('msg');
const text = {
  1: '① 에뮬레이터 화면의 왼쪽 위 모서리를 클릭하세요 (Esc: 취소)',
  2: '② 에뮬레이터 화면의 오른쪽 아래 모서리를 클릭하세요',
};
msg.textContent = text[1];
window.api.onCalibStep((n) => { msg.textContent = text[n]; });
document.addEventListener('mousedown', () => window.api.calibClick());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.api.calibCancel(); });

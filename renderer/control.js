const $ = (id) => document.getElementById(id);
const api = window.api;
let dragging = false;

function fitHeight() { api.resizeUi(document.documentElement.scrollHeight); }

api.onState((s) => {
  if (!dragging) { $('op').value = s.opacity; }
  $('opv').textContent = s.opacity;
  $('match').textContent = '일치도 ' + (s.match == null ? '--' : s.match) + '%';
  $('autofit').checked = s.autoFit;
  $('click').checked = s.clickThrough;
  $('autocmp').checked = s.autoCompare;
  $('toggle').classList.toggle('on', s.view === 'photo');
  $('status').textContent = s.status;
  fitHeight();
});

$('op').addEventListener('input', (e) => { dragging = true; $('opv').textContent = e.target.value; api.setOpacity(Number(e.target.value)); });
$('op').addEventListener('change', () => { dragging = false; });
$('autofit').addEventListener('change', (e) => api.setAutoFit(e.target.checked));
$('click').addEventListener('change', (e) => api.setClickThrough(e.target.checked));
$('autocmp').addEventListener('change', (e) => api.setAutoCompare(e.target.checked));
$('photo').addEventListener('click', () => api.pickPhoto());
$('toggle').addEventListener('click', () => api.toggleView());
$('fit').addEventListener('click', () => api.fitNow());
$('calib').addEventListener('click', () => api.calibrate());
$('cmp').addEventListener('click', () => api.compareNow());
$('adb').addEventListener('click', () => api.pickAdb());

$('pick').addEventListener('click', async () => {
  const p = $('picker');
  if (p.classList.contains('open')) { p.classList.remove('open'); fitHeight(); return; }
  p.textContent = '불러오는 중...'; p.classList.add('open'); fitHeight();
  const list = await api.listWindows();
  p.textContent = '';
  for (const w of list) {
    const d = document.createElement('div');
    d.className = 'win';
    d.textContent = w.title;
    const small = document.createElement('small');
    small.textContent = w.size;
    d.appendChild(small);
    d.addEventListener('click', () => { api.selectWindow(w.hwnd); p.classList.remove('open'); fitHeight(); });
    p.appendChild(d);
  }
  if (!list.length) p.textContent = '열린 창이 없습니다.';
  fitHeight();
});

// Tab: 사진↔에뮬레이터 전환 (컨트롤 창에 포커스가 있을 때). 어디서든 쓰려면 F4.
document.addEventListener('keydown', (e) => { if (e.key === 'Tab') { e.preventDefault(); api.toggleView(); } });

api.getState();
fitHeight();

const $ = (id) => document.getElementById(id);
const A = window.api;
let dragging = false;

function fitHeight() { A.resizeUi(document.documentElement.scrollHeight); }

A.onState((s) => {
  if (!dragging) { $('op').value = s.opacity; }
  $('opv').textContent = s.opacity;
  $('match').textContent = '일치도 ' + (s.match == null ? '--' : s.match) + '%';
  $('autofit').checked = s.autoFit;
  $('click').checked = s.clickThrough;
  $('autocmp').checked = s.autoCompare;
  $('toggle').classList.toggle('on', s.view !== 'emu');
  $('status').textContent = s.status;
  fitHeight();
});

$('op').addEventListener('input', (e) => { dragging = true; $('opv').textContent = e.target.value; A.setOpacity(Number(e.target.value)); });
$('op').addEventListener('change', () => { dragging = false; });
$('autofit').addEventListener('change', (e) => A.setAutoFit(e.target.checked));
$('click').addEventListener('change', (e) => A.setClickThrough(e.target.checked));
$('autocmp').addEventListener('change', (e) => A.setAutoCompare(e.target.checked));
$('photo').addEventListener('click', () => A.pickPhoto());
$('toggle').addEventListener('click', () => A.toggleView());
$('fit').addEventListener('click', () => A.fitNow());
$('calib').addEventListener('click', () => A.calibrate());
$('cmp').addEventListener('click', () => A.compareNow());
$('adb').addEventListener('click', () => A.pickAdb());

$('pick').addEventListener('click', async () => {
  const p = $('picker');
  if (p.classList.contains('open')) { p.classList.remove('open'); fitHeight(); return; }
  p.textContent = '불러오는 중...'; p.classList.add('open'); fitHeight();
  let list = [];
  try { list = await A.listWindows(); } catch (e) { list = { error: String(e) }; }
  if (list.error) { p.textContent = '창 목록을 가져오지 못했습니다: ' + list.error; fitHeight(); return; }
  p.textContent = '';
  for (const w of list) {
    const d = document.createElement('div');
    d.className = 'win';
    d.textContent = w.title;
    const small = document.createElement('small');
    small.textContent = w.size;
    d.appendChild(small);
    d.addEventListener('click', () => { A.selectWindow(w.hwnd); p.classList.remove('open'); fitHeight(); });
    p.appendChild(d);
  }
  if (!list.length) p.textContent = '열린 창이 없습니다.';
  fitHeight();
});

// Tab: 사진↔에뮬레이터 전환 (컨트롤 창에 포커스가 있을 때). 어디서든 쓰려면 F4.
document.addEventListener('keydown', (e) => { if (e.key === 'Tab') { e.preventDefault(); A.toggleView(); } });

A.getState();
fitHeight();

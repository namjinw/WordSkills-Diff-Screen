const $ = (id) => document.getElementById(id);
const A = window.api;
let dragging = false;

A.onState((s) => {
  if (!dragging) $('op').value = s.opacity;
  $('opv').textContent = s.opacity;
  $('match').textContent = (s.match == null ? '--' : s.match) + '%';
  $('autofit').checked = s.autoFit;
  $('click').checked = s.clickThrough;
  $('autocmp').checked = s.autoCompare;
  $('dock').checked = s.docked;
  $('side').value = s.dockSide;
  $('toggle').classList.toggle('on', s.view !== 'emu');
  $('target').textContent = s.targetTitle ? '연결: ' + s.targetTitle : '선택된 창 없음';
  if (document.activeElement !== $('dir')) $('dir').value = s.dir || '';
  $('photoName').textContent = s.photoName ? `${s.photoName}${s.count ? `  (${s.index + 1}/${s.count})` : ''}` : '-';
  $('status').textContent = s.status;
});

$('op').addEventListener('input', (e) => { dragging = true; $('opv').textContent = e.target.value; A.setOpacity(Number(e.target.value)); });
$('op').addEventListener('change', () => { dragging = false; });
$('autofit').addEventListener('change', (e) => A.setAutoFit(e.target.checked));
$('click').addEventListener('change', (e) => A.setClickThrough(e.target.checked));
$('autocmp').addEventListener('change', (e) => A.setAutoCompare(e.target.checked));
$('dock').addEventListener('change', (e) => A.setDock(e.target.checked));
$('side').addEventListener('change', (e) => A.setDockSide(e.target.value));
$('photo').addEventListener('click', () => A.pickPhoto());
$('toggle').addEventListener('click', () => A.toggleView());
$('fit').addEventListener('click', () => A.fitNow());
$('calib').addEventListener('click', () => A.calibrate());
$('cmp').addEventListener('click', () => A.compareNow());
$('adb').addEventListener('click', () => A.pickAdb());
$('dirpick').addEventListener('click', () => A.pickDir());
$('prev').addEventListener('click', () => A.step(-1));
$('next').addEventListener('click', () => A.step(1));
$('dir').addEventListener('keydown', (e) => { if (e.key === 'Enter') { A.setDir($('dir').value); $('dir').blur(); } });

$('pick').addEventListener('click', async () => {
  const p = $('picker');
  if (p.classList.contains('open')) { p.classList.remove('open'); return; }
  p.textContent = '불러오는 중...'; p.classList.add('open');
  let list = [];
  try { list = await A.listWindows(); } catch (e) { list = { error: String(e) }; }
  if (list.error) { p.textContent = '창 목록을 가져오지 못했습니다: ' + list.error; return; }
  p.textContent = '';
  for (const w of list) {
    const d = document.createElement('div');
    d.className = 'win';
    d.textContent = w.title;
    const small = document.createElement('small');
    small.textContent = w.size;
    d.appendChild(small);
    d.addEventListener('click', () => { A.selectWindow(w.hwnd); p.classList.remove('open'); });
    p.appendChild(d);
  }
  if (!list.length) p.textContent = '열린 창이 없습니다.';
});

// 이 창이 앞에 있을 때의 키. (에뮬레이터 창이 앞일 때는 main.cjs의 전역 단축키가 처리한다)
document.addEventListener('keydown', (e) => {
  const tag = e.target && e.target.tagName;
  const typing = tag === 'INPUT' && e.target.type === 'text';
  if (e.key === 'F4') { e.preventDefault(); A.toggleView(); return; }
  if (e.key === 'F5') { e.preventDefault(); A.compareNow(); return; }
  if (e.key === 'F6') { e.preventDefault(); A.setClickThrough(!$('click').checked); return; }
  if (e.ctrlKey && e.altKey) {
    const step = e.shiftKey ? 10 : 1;
    const m = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (m) { e.preventDefault(); A.nudge(m[0], m[1]); return; }
    if (e.key === '0') { e.preventDefault(); A.resetOffset(); }
    return;
  }
  if (!typing && !(tag === 'INPUT' && e.target.type === 'range')) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); A.step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); A.step(1); }
  }
});

A.getState();

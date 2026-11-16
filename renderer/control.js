const $ = (id) => document.getElementById(id);
const A = window.api;
let dragging = false;

A.onState((s) => {
  if (!dragging) { $('op').value = s.opacity; $('split').value = s.split; $('thr').value = s.threshold; }
  $('opv').textContent = s.opacity; $('spv').textContent = s.split; $('thv').textContent = s.threshold;
  $('ver').textContent = 'v' + s.version;
  $('match').textContent = (s.match == null ? '--' : s.match) + '%';
  $('regions').textContent = s.regions ? `상 ${s.regions[0]}% · 중 ${s.regions[1]}% · 하 ${s.regions[2]}%` : '';
  for (const b of document.querySelectorAll('#modes button')) b.classList.toggle('on', b.dataset.mode === s.mode);
  $('splitRow').classList.toggle('hide', s.mode !== 'split');
  $('thrRow').classList.toggle('hide', s.mode !== 'diff');
  $('autofit').checked = s.autoFit; $('click').checked = s.clickThrough; $('autocmp').checked = s.autoCompare;
  $('dock').checked = s.docked; $('side').value = s.dockSide; $('rulers').checked = s.rulers;
  $('toggle').classList.toggle('on', s.mode !== 'emu');
  $('auto').classList.toggle('on', s.autoMatch);
  $('link').textContent = s.links ? `화면↔사진 연결 (${s.links})` : '화면↔사진 연결';
  $('tMeasure').classList.toggle('on', s.tool === 'measure');
  $('tGuide').classList.toggle('on', s.tool === 'guide');
  $('tPick').classList.toggle('on', s.tool === 'pick');
  $('target').textContent = s.targetTitle ? '연결: ' + s.targetTitle : '선택된 창 없음';
  if (document.activeElement !== $('dir')) $('dir').value = s.dir || '';
  if (document.activeElement !== $('exTop')) $('exTop').value = s.excludeTop;
  if (document.activeElement !== $('exBot')) $('exBot').value = s.excludeBottom;
  $('photoName').textContent = s.photoName ? `${s.photoName}${s.count ? `  (${s.index + 1}/${s.count})` : ''}` : '-';
  $('readout').innerHTML = '';
  if (s.readout.length) for (const t of s.readout) { const d = document.createElement('div'); d.textContent = t; $('readout').appendChild(d); }
  else $('readout').textContent = '도구를 켠 뒤 사진 위를 클릭/드래그하세요.';
  $('upd').textContent = s.update.text || '-';
  $('updInstall').classList.toggle('hide', s.update.state !== 'ready');
  $('status').textContent = s.status;
});

const bind = (id, ev, fn) => $(id).addEventListener(ev, fn);
bind('op', 'input', (e) => { dragging = true; $('opv').textContent = e.target.value; A.setOpacity(Number(e.target.value)); });
bind('op', 'change', () => { dragging = false; });
bind('split', 'input', (e) => { dragging = true; $('spv').textContent = e.target.value; A.setSplit(Number(e.target.value)); });
bind('split', 'change', () => { dragging = false; });
bind('thr', 'input', (e) => { dragging = true; $('thv').textContent = e.target.value; });
bind('thr', 'change', (e) => { dragging = false; A.setThreshold(Number(e.target.value)); });
for (const b of document.querySelectorAll('#modes button')) b.addEventListener('click', () => A.setMode(b.dataset.mode));
bind('autofit', 'change', (e) => A.setAutoFit(e.target.checked));
bind('click', 'change', (e) => A.setClickThrough(e.target.checked));
bind('autocmp', 'change', (e) => A.setAutoCompare(e.target.checked));
bind('dock', 'change', (e) => A.setDock(e.target.checked));
bind('side', 'change', (e) => A.setDockSide(e.target.value));
bind('rulers', 'change', (e) => A.setRulers(e.target.checked));
bind('photo', 'click', () => A.pickPhoto());
bind('toggle', 'click', () => A.toggleView());
bind('fit', 'click', () => A.fitNow());
bind('calib', 'click', () => A.calibrate());
bind('cmp', 'click', () => A.compareNow());
bind('adb', 'click', () => A.pickAdb());
bind('dirpick', 'click', () => A.pickDir());
bind('prev', 'click', () => A.step(-1));
bind('next', 'click', () => A.step(1));
bind('auto', 'click', () => A.setAutoMatch(!$('auto').classList.contains('on')));
bind('link', 'click', () => A.linkCurrent());
bind('tMeasure', 'click', () => A.setTool('measure'));
bind('tGuide', 'click', () => A.setTool('guide'));
bind('tPick', 'click', () => A.setTool('pick'));
bind('clearGuides', 'click', () => A.clearGuides());
bind('updCheck', 'click', () => A.checkUpdate());
bind('updInstall', 'click', () => A.installUpdate());
bind('exTop', 'change', () => A.setExclude($('exTop').value, $('exBot').value));
bind('exBot', 'change', () => A.setExclude($('exTop').value, $('exBot').value));
bind('exPreset', 'click', () => A.setExclude(3, 3));
bind('dir', 'keydown', (e) => { if (e.key === 'Enter') { A.setDir($('dir').value); $('dir').blur(); } });

bind('pick', 'click', async () => {
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
// F4는 전역 단축키가 먼저 받으므로 보통 여기까지 오지 않는다(등록 실패 시의 대비). 중복 전환은 메인에서 300ms로 막는다.
document.addEventListener('keydown', (e) => {
  const tag = e.target && e.target.tagName;
  const typing = tag === 'INPUT' && (e.target.type === 'text' || e.target.type === 'number');
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
  if (!typing && !(tag === 'INPUT' && e.target.type === 'range') && tag !== 'SELECT') {
    if (e.key === 'ArrowLeft') { e.preventDefault(); A.step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); A.step(1); }
  }
});

A.getState();

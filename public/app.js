'use strict';

const els = {
  pagesInput: document.getElementById('pagesInput'),
  generateBtn: document.getElementById('generateBtn'),
  resetBtn: document.getElementById('resetBtn'),
  exportBtn: document.getElementById('exportBtn'),
  proofBtn: document.getElementById('proofBtn'),
  singleModeBtn: document.getElementById('singleModeBtn'),
  multiModeBtn: document.getElementById('multiModeBtn'),
  sigCapLabel: document.getElementById('sigCapLabel'),
  sigCapInput: document.getElementById('sigCapInput'),
  creepEnable: document.getElementById('creepEnable'),
  thicknessLabel: document.getElementById('thicknessLabel'),
  thicknessInput: document.getElementById('thicknessInput'),
  creepCapLabel: document.getElementById('creepCapLabel'),
  creepCapInput: document.getElementById('creepCapInput'),
  swapModeBtn: document.getElementById('swapModeBtn'),
  editModeBtn: document.getElementById('editModeBtn'),
  modeHint: document.getElementById('modeHint'),
  repairPlanBtn: document.getElementById('repairPlanBtn'),
  repairCard: document.getElementById('repairCard'),
  repairInfo: document.getElementById('repairInfo'),
  repairSteps: document.getElementById('repairSteps'),
  applyRepairBtn: document.getElementById('applyRepairBtn'),
  discardRepairBtn: document.getElementById('discardRepairBtn'),
  summary: document.getElementById('summary'),
  sheets: document.getElementById('sheets'),
  errors: document.getElementById('errors'),
  emptyTip: document.getElementById('emptyTip'),
  nestTip: document.getElementById('nestTip'),
};

const SIDE_LABEL = { front: '正面', back: '反面' };
const POS_LABEL = { left: '左版', right: '右版' };
const MAX_SHEETS_PER_SIGNATURE = 8;
const MODE_HINT = {
  swap: '交换模式：依次点击两个版位，即可交换它们的页码（再次点击已选中的版位可取消选择）。',
  edit: '编辑模式：点击任意版位，可直接输入页码或设为空白。',
};

let state = null; // 当前拼版状态（单帖 {sheets} / 分帖 {signatures}）
let original = null; // 初始标准拼版（用于重置）
let layout = 'single'; // 拼版模式：'single' | 'multi'
let mode = 'swap'; // 操作模式：'swap' | 'edit'
let selected = null; // 交换模式下已选中的版位 { sig, sheet, side, pos }
let validateTimer = null;
let repairPlan = null; // 当前修复方案 { steps, fingerprint, baseJson, stale }

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `请求失败（HTTP ${res.status}）`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** 当前状态下的全部帖（统一为 { sig, sheets }，单帖 sig 为 null） */
function groups() {
  if (!state) return [];
  if (layout === 'multi') return state.signatures;
  return [{ sig: null, sheets: state.sheets }];
}

function findSheet(ref) {
  if (layout === 'multi') {
    return state.signatures.find((g) => g.sig === ref.sig)
      .sheets.find((s) => s.index === ref.sheet);
  }
  return state.sheets[ref.sheet - 1];
}

function getSlot(ref) {
  return findSheet(ref)[ref.side][ref.pos];
}

function setSlot(ref, value) {
  findSheet(ref)[ref.side][ref.pos] = value;
}

/* ---------- 模式切换 / 生成 / 重置 ---------- */

function setLayout(next) {
  if (layout === next) return;
  layout = next;
  els.singleModeBtn.classList.toggle('active', layout === 'single');
  els.multiModeBtn.classList.toggle('active', layout === 'multi');
  els.sigCapLabel.hidden = layout !== 'multi';
  els.sigCapInput.hidden = layout !== 'multi';

  // 已生成的拼版属于另一种模式，清空工作区以避免结构不一致
  if (state) {
    state = null;
    original = null;
    selected = null;
    discardRepairPlan();
    els.sheets.innerHTML = '';
    els.emptyTip.hidden = false;
    els.nestTip.hidden = true;
    els.summary.textContent = '';
    els.resetBtn.disabled = true;
    els.repairPlanBtn.disabled = true;
    els.exportBtn.disabled = true;
    els.proofBtn.disabled = true;
    els.errors.innerHTML = '<p class="muted">已切换拼版模式，请重新点击「生成拼版」。</p>';
  }
}

async function generate() {
  const pages = Number(els.pagesInput.value);
  const body = { pages };
  if (layout === 'multi') {
    const m = Number(els.sigCapInput.value);
    if (!Number.isInteger(m) || m < 1 || m > MAX_SHEETS_PER_SIGNATURE) {
      alert(`每帖最多纸张数必须是 1~${MAX_SHEETS_PER_SIGNATURE} 的整数`);
      return;
    }
    body.sheetsPerSignature = m;
  }
  if (els.creepEnable.checked) {
    const thickness = Number(els.thicknessInput.value);
    const cap = Number(els.creepCapInput.value);
    if (!Number.isFinite(thickness) || thickness < 0.01 || thickness > 0.5) {
      alert('单张纸厚度必须是 0.01~0.50 mm 的数值（0.01 mm 精度）');
      return;
    }
    if (!Number.isFinite(cap) || cap < 0 || cap > 10) {
      alert('补偿上限必须是 0~10 mm 的数值（0 表示不补偿）');
      return;
    }
    body.creep = { thickness, cap };
  }
  try {
    const data = await api('/api/generate', body);
    state = data;
    original = structuredClone(data);
    selected = null;
    discardRepairPlan();
    render();
    scheduleValidate();
  } catch (e) {
    alert(e.message);
  }
}

function reset() {
  if (!original) return;
  state = structuredClone(original);
  selected = null;
  discardRepairPlan();
  render();
  scheduleValidate();
}

/* ---------- 渲染 ---------- */

function render() {
  if (!state) return;
  els.emptyTip.hidden = true;
  els.nestTip.hidden = false;

  if (layout === 'multi') {
    els.summary.textContent =
      `成品 ${state.pages} 页 → 补齐至 ${state.totalPages} 页` +
      `（空白 ${state.totalPages - state.pages} 页） · 共 ${state.signatureCount} 帖、${state.sheetCount} 张纸` +
      ` · 每帖最多 ${state.sheetsPerSignature} 张（${state.sheetsPerSignature * 4} 个成品页），仅末帖补空白`;
  } else {
    els.summary.textContent =
      `成品 ${state.pages} 页 → 补齐至 ${state.totalPages} 页` +
      `（空白 ${state.totalPages - state.pages} 页） · 共 ${state.sheetCount} 张纸 · 每张正反 2 面、每面左右 2 版`;
  }
  if (state.creep) {
    els.summary.textContent +=
      ` · 爬移补偿：纸厚 ${state.creep.thickness.toFixed(2)} mm、上限 ${state.creep.cap.toFixed(2)} mm`;
  }

  els.sheets.innerHTML = '';
  for (const g of groups()) {
    if (layout === 'multi') {
      els.sheets.appendChild(renderSignature(g));
    } else {
      g.sheets.forEach((sheet, idx) =>
        els.sheets.appendChild(renderSheetCard(g.sig, sheet, idx, g.sheets.length))
      );
    }
  }

  els.resetBtn.disabled = false;
  els.repairPlanBtn.disabled = false;
  updateModeUI();
}

function renderSignature(g) {
  const wrap = document.createElement('section');
  wrap.className = 'signature';
  wrap.dataset.sig = g.sig;

  const lastSig = state.signatures[state.signatures.length - 1].sig;
  let tag = '';
  if (g.sig === lastSig) {
    if (state.totalPages > state.pages) {
      tag = '<span class="sig-tag last">末帖 · 补空白</span>';
    } else if (state.signatures.length > 1) {
      tag = '<span class="sig-tag">末帖</span>';
    }
  }
  const header = document.createElement('header');
  header.className = 'sig-header';
  header.innerHTML =
    `<strong>第 ${g.sig} 帖</strong>` +
    `<span class="sig-range">成品页 第 ${g.startPage}～${g.endPage} 页</span>` +
    `<span class="sig-range">${g.sheetCount} 张纸</span>` +
    tag;
  wrap.appendChild(header);

  const body = document.createElement('div');
  body.className = 'sig-body';
  g.sheets.forEach((sheet, idx) =>
    body.appendChild(renderSheetCard(g.sig, sheet, idx, g.sheets.length))
  );
  wrap.appendChild(body);
  return wrap;
}

function renderSheetCard(sig, sheet, idx, groupSheetTotal) {
  const card = document.createElement('section');
  card.className = 'sheet';
  card.style.setProperty('--indent', idx);
  card.dataset.sheet = sheet.index;
  if (sig != null) card.dataset.sig = sig;

  const nestLabel =
    idx === 0 ? '最外层' : idx === groupSheetTotal - 1 && idx > 0 ? '最内层' : '';
  const header = document.createElement('header');
  header.innerHTML = `<strong>第 ${sheet.index} 张纸</strong>` +
    (nestLabel ? `<span class="nest">${nestLabel}</span>` : '');
  // 爬移补偿：每张纸正反面共用同一补偿量，左版向右、右版向左（朝折线）
  if (state.creep && typeof sheet.creep === 'number') {
    const c = sheet.creep;
    const badge = document.createElement('span');
    badge.className = 'creep';
    badge.textContent = c === 0
      ? '爬移 0.00 mm（本张不补偿）'
      : `爬移 ${c.toFixed(2)} mm｜左版 +${c.toFixed(2)} 向右 · 右版 −${c.toFixed(2)} 向左（朝折线）`;
    header.appendChild(badge);
  }
  card.appendChild(header);

  for (const side of ['front', 'back']) {
    const row = document.createElement('div');
    row.className = 'side';
    const label = document.createElement('span');
    label.className = 'side-label';
    label.textContent = SIDE_LABEL[side];
    row.appendChild(label);
    for (const pos of ['left', 'right']) {
      row.appendChild(renderSlot(sig, sheet.index, side, pos, sheet[side][pos]));
    }
    card.appendChild(row);
  }
  return card;
}

function renderSlot(sig, sheetIndex, side, pos, value) {
  const slot = document.createElement('div');
  slot.className = 'slot' + (value === null ? ' blank' : '');
  slot.dataset.sheet = sheetIndex;
  if (sig != null) slot.dataset.sig = sig;
  slot.dataset.side = side;
  slot.dataset.pos = pos;
  slot.setAttribute('role', 'button');
  slot.tabIndex = 0;

  const posEl = document.createElement('span');
  posEl.className = 'pos';
  posEl.textContent = POS_LABEL[pos];
  const pageEl = document.createElement('span');
  pageEl.className = 'page';
  pageEl.textContent = value === null ? '空白' : `第 ${value} 页`;
  slot.append(posEl, pageEl);

  if (
    selected &&
    selected.sig === sig &&
    selected.sheet === sheetIndex &&
    selected.side === side &&
    selected.pos === pos
  ) {
    slot.classList.add('selected');
  }
  slot.addEventListener('click', () => onSlotClick({ sig, sheet: sheetIndex, side, pos }, slot));
  return slot;
}

/* ---------- 交互：交换 / 编辑 ---------- */

function sameRef(a, b) {
  return a.sig === b.sig && a.sheet === b.sheet && a.side === b.side && a.pos === b.pos;
}

function onSlotClick(ref, el) {
  if (el.classList.contains('editing')) return;

  if (mode === 'edit') {
    openEditor(ref, el);
    return;
  }

  // 交换模式
  if (!selected) {
    selected = ref;
    el.classList.add('selected');
    return;
  }
  if (sameRef(selected, ref)) {
    selected = null;
    el.classList.remove('selected');
    return;
  }
  const tmp = getSlot(selected);
  setSlot(selected, getSlot(ref));
  setSlot(ref, tmp);
  selected = null;
  render();
  scheduleValidate();
  markRepairStaleIfChanged();
}

function openEditor(ref, el) {
  const current = getSlot(ref);
  el.classList.add('editing');
  el.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.className = 'slot-editor';
  wrap.addEventListener('click', (e) => e.stopPropagation());

  const input = document.createElement('input');
  input.type = 'number';
  input.min = 1;
  input.max = state.pages;
  input.placeholder = `1~${state.pages}`;
  if (current !== null) input.value = current;

  const btns = document.createElement('div');
  btns.className = 'btns';
  const okBtn = document.createElement('button');
  okBtn.textContent = '确定';
  const blankBtn = document.createElement('button');
  blankBtn.textContent = '空白';
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '取消';
  btns.append(okBtn, blankBtn, cancelBtn);
  wrap.append(input, btns);
  el.appendChild(wrap);
  input.focus();
  input.select();

  const commit = (value) => {
    setSlot(ref, value);
    render();
    scheduleValidate();
    markRepairStaleIfChanged();
  };
  okBtn.addEventListener('click', () => {
    const raw = input.value.trim();
    if (raw === '') {
      commit(null);
      return;
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > state.pages) {
      alert(`页码须为 1~${state.pages} 的整数，或留空表示空白版位`);
      return;
    }
    commit(n);
  });
  blankBtn.addEventListener('click', () => commit(null));
  cancelBtn.addEventListener('click', () => render());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') okBtn.click();
    if (e.key === 'Escape') cancelBtn.click();
  });
}

function updateModeUI() {
  els.swapModeBtn.classList.toggle('active', mode === 'swap');
  els.editModeBtn.classList.toggle('active', mode === 'edit');
  els.modeHint.textContent = MODE_HINT[mode];
}

/* ---------- 校验 ---------- */

function scheduleValidate() {
  clearTimeout(validateTimer);
  validateTimer = setTimeout(validateNow, 200);
}

async function validateNow() {
  if (!state) return;
  try {
    const result = await api('/api/validate', state);
    renderErrors(result);
    markSlotErrors(result.slotErrors || []);
    els.exportBtn.disabled = !result.valid;
    els.proofBtn.disabled = !result.valid;
  } catch (e) {
    els.errors.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = `校验请求失败：${e.message}`;
    els.errors.appendChild(p);
    els.exportBtn.disabled = true;
    els.proofBtn.disabled = true;
  }
}

function renderErrors(result) {
  els.errors.innerHTML = '';
  if (result.valid) {
    const p = document.createElement('p');
    p.className = 'ok';
    p.textContent = layout === 'multi'
      ? '✓ 校验通过：各帖页码连续、无重复、无缺失，帖内正反配对正确，可以导出 CSV 或下载双面打样。'
      : '✓ 校验通过：页码无重复、无缺失，各纸张正反配对正确，可以导出 CSV 或下载双面打样。';
    els.errors.appendChild(p);
    return;
  }
  const e = result.errors;
  if (e.duplicates.length) {
    addErrGroup(`重复页：${e.duplicates.map((p) => `第 ${p} 页`).join('、')}`);
  }
  if (e.missing.length) {
    addErrGroup(`缺页：${e.missing.map((p) => `第 ${p} 页`).join('、')}`);
  }
  if (e.outOfRange.length) {
    addErrGroup(`页码超出范围：${e.outOfRange.map((p) => `第 ${p} 页`).join('、')}`);
  }
  if (e.crossSignature) {
    for (const c of e.crossSignature) {
      addErrGroup(`第 ${c.sig} 帖跨帖异常：${c.message}`);
    }
  }
  for (const p of e.pairing) {
    const div = document.createElement('div');
    div.className = 'err-group';
    const title = document.createElement('strong');
    title.textContent = p.sig != null
      ? `第 ${p.sig} 帖 · 第 ${p.sheet} 张纸配对异常：`
      : `第 ${p.sheet} 张纸配对异常：`;
    const ul = document.createElement('ul');
    for (const m of p.messages) {
      const li = document.createElement('li');
      li.textContent = m;
      ul.appendChild(li);
    }
    div.append(title, ul);
    els.errors.appendChild(div);
  }
}

function addErrGroup(text) {
  const div = document.createElement('div');
  div.className = 'err-group';
  const strong = document.createElement('strong');
  strong.textContent = text;
  div.appendChild(strong);
  els.errors.appendChild(div);
}

function markSlotErrors(slotErrors) {
  els.sheets.querySelectorAll('.slot.error').forEach((el) => {
    el.classList.remove('error');
    el.removeAttribute('title');
  });
  els.sheets.querySelectorAll('.sheet.has-error').forEach((el) => el.classList.remove('has-error'));
  els.sheets.querySelectorAll('.signature.has-error').forEach((el) => el.classList.remove('has-error'));

  const byKey = new Map();
  for (const se of slotErrors) {
    const key = `${se.sig ?? ''}|${se.sheet}|${se.side}|${se.pos}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(se.message);
  }
  for (const [key, messages] of byKey) {
    const [sig, sheet, side, pos] = key.split('|');
    const selector = sig
      ? `.slot[data-sig="${sig}"][data-sheet="${sheet}"][data-side="${side}"][data-pos="${pos}"]`
      : `.slot:not([data-sig])[data-sheet="${sheet}"][data-side="${side}"][data-pos="${pos}"]`;
    const el = els.sheets.querySelector(selector);
    if (!el) continue;
    el.classList.add('error');
    el.title = [...new Set(messages)].join('\n');
    const card = el.closest('.sheet');
    if (card) card.classList.add('has-error');
    const sigCard = el.closest('.signature');
    if (sigCard) sigCard.classList.add('has-error');
  }
}

/* ---------- 修复方案 ---------- */

/** 版位标签：单帖「第 N 张纸 · 正面左版」，分帖「第 S 帖 · 第 N 张纸 · 正面左版」 */
function slotLabel(ref) {
  const where = ref.sig == null ? `第 ${ref.sheet} 张纸` : `第 ${ref.sig} 帖 · 第 ${ref.sheet} 张纸`;
  return `${where} · ${SIDE_LABEL[ref.side]}${POS_LABEL[ref.pos]}`;
}

function valueLabel(v) {
  return v === null ? '空白' : `第 ${v} 页`;
}

/** 生成修复方案：以服务端标准拼版为目标，返回按顺序执行的交换 / 改值步骤 */
async function generateRepairPlan() {
  if (!state) return;
  try {
    const data = await api('/api/repair/plan', state);
    repairPlan = {
      steps: data.steps,
      fingerprint: data.fingerprint,
      baseJson: JSON.stringify(state), // 生成方案时的状态快照，用于检测后续改动
      stale: false,
    };
    renderRepairPlan();
  } catch (e) {
    alert(e.message);
  }
}

function renderRepairPlan() {
  if (!repairPlan) {
    els.repairCard.hidden = true;
    return;
  }
  els.repairCard.hidden = false;
  els.repairInfo.innerHTML = '';
  els.repairSteps.innerHTML = '';

  if (repairPlan.stale) {
    const warn = document.createElement('p');
    warn.className = 'repair-stale';
    warn.textContent = '拼版已在生成方案后被改动，本方案已失效，请重新生成修复方案。';
    els.repairInfo.appendChild(warn);
  } else if (repairPlan.steps.length === 0) {
    const ok = document.createElement('p');
    ok.className = 'repair-ok';
    ok.textContent = '当前拼版已通过校验，无需修复。';
    els.repairInfo.appendChild(ok);
  } else {
    const swaps = repairPlan.steps.filter((s) => s.type === 'swap').length;
    const sets = repairPlan.steps.length - swaps;
    const p = document.createElement('p');
    p.className = 'repair-summary';
    p.textContent =
      `以服务端标准拼版为目标，共 ${repairPlan.steps.length} 步` +
      `（交换 ${swaps} 步、改值 ${sets} 步），按顺序执行；修复保留分帖结构与爬移参数。`;
    els.repairInfo.appendChild(p);
  }

  repairPlan.steps.forEach((step) => {
    const li = document.createElement('li');
    li.className = `repair-step ${step.type}`;
    const badge = document.createElement('span');
    badge.className = 'step-badge';
    badge.textContent = step.type === 'swap' ? '交换' : '改值';
    const changes = document.createElement('div');
    changes.className = 'step-changes';
    for (const ch of step.changes) {
      const line = document.createElement('div');
      line.className = 'step-change';
      line.textContent = `${slotLabel(ch.slot)}：${valueLabel(ch.from)} → ${valueLabel(ch.to)}`;
      changes.appendChild(line);
    }
    li.append(badge, changes);
    els.repairSteps.appendChild(li);
  });

  els.applyRepairBtn.disabled = repairPlan.steps.length === 0;
}

/** 拼版被交换 / 编辑改动后，若已有修复方案则标记失效（拒绝应用旧方案） */
function markRepairStaleIfChanged() {
  if (!repairPlan || !state) return;
  if (JSON.stringify(state) !== repairPlan.baseJson) {
    repairPlan.stale = true;
    renderRepairPlan();
  }
}

function discardRepairPlan() {
  repairPlan = null;
  renderRepairPlan();
}

/** 一键应用修复方案；生成方案后拼版又被改动时拒绝应用并提示重新生成 */
async function applyRepairPlan() {
  if (!repairPlan || !state) return;
  if (repairPlan.stale || JSON.stringify(state) !== repairPlan.baseJson) {
    repairPlan.stale = true;
    renderRepairPlan();
    alert('拼版已在生成修复方案后被改动，请重新生成修复方案。');
    return;
  }
  try {
    const data = await api('/api/repair/apply', { state, fingerprint: repairPlan.fingerprint });
    state = data.state;
    selected = null;
    discardRepairPlan();
    render();
    validateNow();
  } catch (e) {
    if (e.status === 409 && repairPlan) {
      repairPlan.stale = true;
      renderRepairPlan();
    }
    alert(e.message);
  }
}

/* ---------- 导出 ---------- */

/** 下载结果文件（CSV / 打样 HTML）的通用逻辑 */
async function downloadResult(path, filename, errorLabel) {
  if (!state) return;
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    alert(data.error || errorLabel);
    return;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportCsv() {
  const filename = layout === 'multi'
    ? `imposition-${state.totalPages}p-${state.signatureCount}sig.csv`
    : `imposition-${state.totalPages}p.csv`;
  return downloadResult('/api/export', filename, '导出失败');
}

function downloadProof() {
  const filename = layout === 'multi'
    ? `imposition-proof-${state.totalPages}p-${state.signatureCount}sig.html`
    : `imposition-proof-${state.totalPages}p.html`;
  return downloadResult('/api/export/proof', filename, '打样下载失败');
}

/* ---------- 事件绑定 ---------- */

els.generateBtn.addEventListener('click', generate);
els.resetBtn.addEventListener('click', reset);
els.repairPlanBtn.addEventListener('click', generateRepairPlan);
els.applyRepairBtn.addEventListener('click', applyRepairPlan);
els.discardRepairBtn.addEventListener('click', discardRepairPlan);
els.exportBtn.addEventListener('click', exportCsv);
els.proofBtn.addEventListener('click', downloadProof);
els.pagesInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') generate();
});
els.sigCapInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') generate();
});
els.singleModeBtn.addEventListener('click', () => setLayout('single'));
els.multiModeBtn.addEventListener('click', () => setLayout('multi'));
els.creepEnable.addEventListener('change', () => {
  const on = els.creepEnable.checked;
  els.thicknessLabel.hidden = !on;
  els.thicknessInput.hidden = !on;
  els.creepCapLabel.hidden = !on;
  els.creepCapInput.hidden = !on;
});
els.swapModeBtn.addEventListener('click', () => {
  mode = 'swap';
  selected = null;
  render();
});
els.editModeBtn.addEventListener('click', () => {
  mode = 'edit';
  selected = null;
  render();
});

setLayout('single');
updateModeUI();

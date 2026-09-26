'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  generateImposition,
  validateImposition,
  planRepair,
  applyRepair,
  buildCsv,
  buildProofHtml,
} = require('../src/imposition');

/** 模拟客户端按顺序执行方案步骤（swap / set 均按 changes 写入目标值），返回新状态 */
function applySteps(raw, steps) {
  const next = JSON.parse(JSON.stringify(raw));
  const write = (ref, value) => {
    const sheets = ref.sig == null ? next.sheets : next.signatures[ref.sig - 1].sheets;
    sheets[ref.sheet - 1][ref.side][ref.pos] = value;
  };
  for (const step of steps) {
    for (const ch of step.changes) write(ch.slot, ch.to);
  }
  return next;
}

/** 版位读取辅助（sig 为 null 表示单帖） */
function getSlot(state, ref) {
  const sheets = ref.sig == null ? state.sheets : state.signatures[ref.sig - 1].sheets;
  return sheets[ref.sheet - 1][ref.side][ref.pos];
}

test('修复方案：标准拼版无需修复（单帖 / 分帖）', () => {
  for (const imp of [generateImposition(8), generateImposition(10, 2)]) {
    const plan = planRepair(imp);
    assert.equal(plan.valid, true);
    assert.equal(plan.stepCount, 0);
    assert.deepEqual(plan.steps, []);
    assert.ok(typeof plan.fingerprint === 'string' && plan.fingerprint.length > 0);
  }
});

test('修复方案：结构非法返回 null', () => {
  assert.equal(planRepair(null), null);
  assert.equal(planRepair({ pages: 3, totalPages: 8, sheets: [] }), null);
  assert.equal(applyRepair(null, 'x'), null);
  assert.equal(applyRepair({ pages: 8, totalPages: 8, sheets: [{}] }, 'x'), null);
});

test('修复方案：两个版位交换错位 → 一步交换归位', () => {
  const imp = generateImposition(8);
  // 第 1 张正面左版 8 ↔ 第 2 张反面右版 5
  [imp.sheets[0].front.left, imp.sheets[1].back.right] = [
    imp.sheets[1].back.right,
    imp.sheets[0].front.left,
  ];
  const plan = planRepair(imp);
  assert.equal(plan.valid, false);
  assert.equal(plan.stepCount, 1);
  const [step] = plan.steps;
  assert.equal(step.type, 'swap');
  assert.deepEqual(step.changes, [
    { slot: { sig: null, sheet: 1, side: 'front', pos: 'left' }, from: 5, to: 8 },
    { slot: { sig: null, sheet: 2, side: 'back', pos: 'right' }, from: 8, to: 5 },
  ]);
  const repaired = applySteps(imp, plan.steps);
  assert.equal(validateImposition(repaired).valid, true);
});

test('修复方案：三环交换按固定版位顺序拆解为两步交换', () => {
  const imp = generateImposition(8);
  // 第 1 张 正面左 8 / 正面右 1 / 反面左 2 三环错位：8→反面左、1→正面左、2→正面右
  imp.sheets[0].front.left = 1;
  imp.sheets[0].front.right = 2;
  imp.sheets[0].back.left = 8;
  const plan = planRepair(imp);
  assert.equal(plan.stepCount, 2);
  assert.ok(plan.steps.every((s) => s.type === 'swap'));
  // 固定版位顺序：先归位正面左版，再归位正面右版
  assert.deepEqual(plan.steps[0].changes[0].slot, { sig: null, sheet: 1, side: 'front', pos: 'left' });
  assert.deepEqual(plan.steps[1].changes[0].slot, { sig: null, sheet: 1, side: 'front', pos: 'right' });
  const repaired = applySteps(imp, plan.steps);
  assert.equal(validateImposition(repaired).valid, true);
});

test('修复方案：重复页 + 缺页 → 改值补齐', () => {
  const imp = generateImposition(8);
  imp.sheets[1].back.right = 1; // 第 5 页被改为第 1 页（1 重复、5 缺失）
  const plan = planRepair(imp);
  assert.equal(plan.stepCount, 1);
  assert.deepEqual(plan.steps[0], {
    type: 'set',
    changes: [{ slot: { sig: null, sheet: 2, side: 'back', pos: 'right' }, from: 1, to: 5 }],
  });
  const repaired = applySteps(imp, plan.steps);
  assert.equal(validateImposition(repaired).valid, true);
});

test('修复方案：越界页 → 改值', () => {
  const imp = generateImposition(8);
  imp.sheets[0].front.left = 99;
  const plan = planRepair(imp);
  assert.equal(plan.stepCount, 1);
  assert.deepEqual(plan.steps[0], {
    type: 'set',
    changes: [{ slot: { sig: null, sheet: 1, side: 'front', pos: 'left' }, from: 99, to: 8 }],
  });
  assert.equal(validateImposition(applySteps(imp, plan.steps)).valid, true);
});

test('修复方案：应有内容的版位被置空白 → 改值', () => {
  const imp = generateImposition(8);
  imp.sheets[0].front.right = null; // 第 1 页消失
  const plan = planRepair(imp);
  assert.equal(plan.stepCount, 1);
  assert.deepEqual(plan.steps[0], {
    type: 'set',
    changes: [{ slot: { sig: null, sheet: 1, side: 'front', pos: 'right' }, from: null, to: 1 }],
  });
  assert.equal(validateImposition(applySteps(imp, plan.steps)).valid, true);
});

test('修复方案：空白版位被填页、原版位留空 → 交换归位', () => {
  const imp = generateImposition(6); // 第 1 张正面左版应为空白
  imp.sheets[0].front.left = 5; // 第 5 页挪入空白版位
  imp.sheets[1].back.right = null; // 第 5 页原版位留空
  const plan = planRepair(imp);
  assert.equal(plan.stepCount, 1);
  assert.equal(plan.steps[0].type, 'swap');
  assert.deepEqual(plan.steps[0].changes, [
    { slot: { sig: null, sheet: 2, side: 'back', pos: 'right' }, from: null, to: 5 },
    { slot: { sig: null, sheet: 1, side: 'front', pos: 'left' }, from: 5, to: null },
  ]);
  assert.equal(validateImposition(applySteps(imp, plan.steps)).valid, true);
});

test('修复方案：交换步骤先于改值步骤（混合错误）', () => {
  const imp = generateImposition(8);
  // 交换错位：正面左 8 ↔ 正面右 1（交换环）
  [imp.sheets[0].front.left, imp.sheets[0].front.right] = [
    imp.sheets[0].front.right,
    imp.sheets[0].front.left,
  ];
  imp.sheets[1].back.right = 1; // 另有重复页 + 缺页
  const plan = planRepair(imp);
  assert.equal(plan.stepCount, 2);
  assert.equal(plan.steps[0].type, 'swap');
  assert.equal(plan.steps[1].type, 'set');
  assert.equal(validateImposition(applySteps(imp, plan.steps)).valid, true);
});

test('修复方案：整纸交换（套帖顺序异常）→ 交换修复', () => {
  const imp = generateImposition(8);
  for (const side of ['front', 'back']) {
    for (const pos of ['left', 'right']) {
      [imp.sheets[0][side][pos], imp.sheets[1][side][pos]] = [
        imp.sheets[1][side][pos],
        imp.sheets[0][side][pos],
      ];
    }
  }
  const plan = planRepair(imp);
  assert.equal(plan.stepCount, 4); // 4 个版位各自成二环
  assert.ok(plan.steps.every((s) => s.type === 'swap'));
  assert.equal(validateImposition(applySteps(imp, plan.steps)).valid, true);
});

test('修复方案：分帖跨帖交换 → 一步交换，保留分帖结构', () => {
  const imp = generateImposition(16, 2); // 第 1 帖 1~8，第 2 帖 9~16
  const s1 = imp.signatures[0].sheets[0];
  const s2 = imp.signatures[1].sheets[0];
  [s1.front.left, s2.front.left] = [s2.front.left, s1.front.left]; // 8 ↔ 16
  const plan = planRepair(imp);
  assert.equal(plan.stepCount, 1);
  assert.equal(plan.steps[0].type, 'swap');
  assert.deepEqual(plan.steps[0].changes, [
    { slot: { sig: 1, sheet: 1, side: 'front', pos: 'left' }, from: 16, to: 8 },
    { slot: { sig: 2, sheet: 1, side: 'front', pos: 'left' }, from: 8, to: 16 },
  ]);
  const repaired = applySteps(imp, plan.steps);
  assert.equal(validateImposition(repaired).valid, true);
  assert.equal(repaired.signatures.length, 2);
  assert.equal(repaired.sheetsPerSignature, 2);
});

test('修复方案：分帖末帖缺页 → 改值', () => {
  const imp = generateImposition(10, 2);
  imp.signatures[1].sheets[0].back.left = null; // 第 10 页消失
  const plan = planRepair(imp);
  assert.equal(plan.stepCount, 1);
  assert.deepEqual(plan.steps[0], {
    type: 'set',
    changes: [{ slot: { sig: 2, sheet: 1, side: 'back', pos: 'left' }, from: null, to: 10 }],
  });
  assert.equal(validateImposition(applySteps(imp, plan.steps)).valid, true);
});

test('修复方案：同一状态生成方案是确定性的', () => {
  const imp = generateImposition(12);
  [imp.sheets[0].front.left, imp.sheets[2].back.right] = [
    imp.sheets[2].back.right,
    imp.sheets[0].front.left,
  ];
  imp.sheets[1].front.right = null;
  assert.deepEqual(planRepair(imp), planRepair(imp));
});

test('应用修复：指纹核对通过则修复并通过校验，可继续导出', () => {
  const imp = generateImposition(8);
  [imp.sheets[0].front.left, imp.sheets[1].back.right] = [
    imp.sheets[1].back.right,
    imp.sheets[0].front.left,
  ];
  imp.sheets[1].front.right = 2; // 额外制造重复 + 缺页
  const plan = planRepair(imp);
  const result = applyRepair(imp, plan.fingerprint);
  assert.ok(!result.stale && !result.error);
  assert.equal(validateImposition(result.state).valid, true);
  assert.deepEqual(result.steps, plan.steps); // 服务端重推导与方案一致
  // 既有导出继续可用
  assert.ok(buildCsv(result.state).includes('纸张序号'));
  assert.ok(buildProofHtml(result.state).includes('sheet-page'));
  // 修复后的状态再次生成方案 → 无需修复
  assert.equal(planRepair(result.state).stepCount, 0);
});

test('应用修复：生成方案后拼版被改动 → 拒绝应用（stale）', () => {
  const imp = generateImposition(8);
  [imp.sheets[0].front.left, imp.sheets[1].back.right] = [
    imp.sheets[1].back.right,
    imp.sheets[0].front.left,
  ];
  const plan = planRepair(imp);

  // 生成方案后又改动拼版 → 指纹不符
  [imp.sheets[0].front.right, imp.sheets[0].back.left] = [
    imp.sheets[0].back.left,
    imp.sheets[0].front.right,
  ];
  const stale = applyRepair(imp, plan.fingerprint);
  assert.equal(stale.stale, true);
  assert.notEqual(stale.fingerprint, plan.fingerprint);

  // 改动后再重新生成方案 → 可正常应用
  const plan2 = planRepair(imp);
  const ok = applyRepair(imp, plan2.fingerprint);
  assert.ok(!ok.stale);
  assert.equal(validateImposition(ok.state).valid, true);
});

test('应用修复：保留分帖结构与爬移参数', () => {
  const imp = generateImposition(10, 2, { thickness: 0.1, cap: 2 });
  const s1 = imp.signatures[0].sheets[0];
  const s2 = imp.signatures[1].sheets[0];
  [s1.front.left, s2.front.left] = [s2.front.left, s1.front.left]; // 第 8 页 ↔ 末帖空白版位
  const plan = planRepair(imp);
  const result = applyRepair(imp, plan.fingerprint);
  assert.ok(!result.stale && !result.error);
  // 分帖结构与爬移参数原样保留
  assert.deepEqual(result.state.creep, { thickness: 0.1, cap: 2 });
  assert.equal(result.state.signatures.length, 2);
  assert.equal(result.state.signatures[0].sheets[1].creep, 0.2);
  assert.equal(result.state.signatures[1].sheets[0].creep, 0); // 每帖独立从 0 起算
  assert.equal(validateImposition(result.state).valid, true);
  // 既有 CSV（含爬移补偿列）与打样导出继续可用
  const csv = buildCsv(result.state);
  assert.ok(csv.includes('左版爬移补偿(mm)'));
  assert.ok(buildProofHtml(result.state).includes('爬移补偿'));
});

test('应用修复：单帖爬移补偿数据不被修复改动', () => {
  const imp = generateImposition(8, null, { thickness: 0.1, cap: 2 });
  [imp.sheets[0].front.left, imp.sheets[1].back.right] = [
    imp.sheets[1].back.right,
    imp.sheets[0].front.left,
  ];
  const plan = planRepair(imp);
  const result = applyRepair(imp, plan.fingerprint);
  assert.equal(result.state.sheets[0].creep, 0);
  assert.equal(result.state.sheets[1].creep, 0.2);
  assert.equal(validateImposition(result.state).valid, true);
});

test('修复方案：步骤中的版位值与当前状态一致（from 字段准确）', () => {
  const imp = generateImposition(8);
  [imp.sheets[0].front.left, imp.sheets[1].back.right] = [
    imp.sheets[1].back.right,
    imp.sheets[0].front.left,
  ];
  imp.sheets[1].front.right = null;
  const plan = planRepair(imp);
  // 逐步执行并核对每步的 from 与执行前状态一致
  const next = JSON.parse(JSON.stringify(imp));
  const write = (ref, value) => {
    const sheets = ref.sig == null ? next.sheets : next.signatures[ref.sig - 1].sheets;
    sheets[ref.sheet - 1][ref.side][ref.pos] = value;
  };
  for (const step of plan.steps) {
    for (const ch of step.changes) {
      assert.equal(getSlot(next, ch.slot), ch.from, `步骤执行前 ${JSON.stringify(ch.slot)} 的原值`);
      write(ch.slot, ch.to);
    }
  }
  assert.equal(validateImposition(next).valid, true);
});

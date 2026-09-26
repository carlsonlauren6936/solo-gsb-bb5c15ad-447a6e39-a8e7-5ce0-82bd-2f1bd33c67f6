'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  generateImposition,
  validateImposition,
  planRepair,
  applyRepair,
  buildCsv,
} = require('../src/imposition');

const clone = (x) => JSON.parse(JSON.stringify(x));

/** 在状态副本上按顺序重放修复步骤，并校验每步记录的原值 / 目标值与实际一致 */
function replay(raw, steps) {
  const s = clone(raw);
  const find = (ref) => (ref.sig != null
    ? s.signatures.find((g) => g.sig === ref.sig).sheets.find((x) => x.index === ref.sheet)
    : s.sheets[ref.sheet - 1]);
  for (const step of steps) {
    if (step.type === 'swap') {
      const a = find(step.a);
      const b = find(step.b);
      assert.equal(a[step.a.side][step.a.pos], step.aFrom, '交换前 a 版位原值');
      assert.equal(b[step.b.side][step.b.pos], step.bFrom, '交换前 b 版位原值');
      const tmp = a[step.a.side][step.a.pos];
      a[step.a.side][step.a.pos] = b[step.b.side][step.b.pos];
      b[step.b.side][step.b.pos] = tmp;
      assert.equal(a[step.a.side][step.a.pos], step.aTo, '交换后 a 版位目标值');
      assert.equal(b[step.b.side][step.b.pos], step.bTo, '交换后 b 版位目标值');
    } else {
      const x = find(step.slot);
      assert.equal(x[step.slot.side][step.slot.pos], step.from, '改值前原值');
      x[step.slot.side][step.slot.pos] = step.to;
    }
  }
  return s;
}

test('修复方案：标准拼版无需修复（单帖 / 分帖）', () => {
  for (const raw of [generateImposition(8), generateImposition(10, 2)]) {
    const plan = planRepair(raw);
    assert.equal(plan.valid, true);
    assert.deepEqual(plan.steps, []);
    assert.ok(plan.fingerprint);
  }
});

test('修复方案：两个版位互换 → 一步交换归位', () => {
  const imp = generateImposition(8);
  const f = imp.sheets[0].front;
  [f.left, f.right] = [f.right, f.left]; // [8,1] → [1,8]
  const plan = planRepair(imp);
  assert.equal(plan.valid, false);
  assert.equal(plan.steps.length, 1);
  const step = plan.steps[0];
  assert.equal(step.type, 'swap');
  assert.deepEqual(step.a, { sheet: 1, side: 'front', pos: 'left' });
  assert.deepEqual(step.b, { sheet: 1, side: 'front', pos: 'right' });
  assert.equal(step.aFrom, 1);
  assert.equal(step.aTo, 8);
  assert.equal(step.bFrom, 8);
  assert.equal(step.bTo, 1);
  // 重放后即为标准拼版且通过校验
  const repaired = replay(imp, plan.steps);
  assert.deepEqual(repaired, generateImposition(8));
  assert.equal(validateImposition(repaired).valid, true);
});

test('修复方案：三页轮换的交换环按固定版位顺序拆解', () => {
  const imp = generateImposition(8);
  // 第 1 张：正面左 8、正面右 1、反面左 2 → 轮换为 2、8、1
  imp.sheets[0].front.left = 2;
  imp.sheets[0].front.right = 8;
  imp.sheets[0].back.left = 1;
  const plan = planRepair(imp);
  assert.equal(plan.steps.length, 2);
  assert.ok(plan.steps.every((s) => s.type === 'swap'));
  // 固定版位顺序：正面左版 → 正面右版 → 反面左版
  assert.deepEqual(plan.steps[0].a, { sheet: 1, side: 'front', pos: 'left' });
  assert.deepEqual(plan.steps[0].b, { sheet: 1, side: 'front', pos: 'right' });
  assert.deepEqual(plan.steps[1].a, { sheet: 1, side: 'front', pos: 'right' });
  assert.deepEqual(plan.steps[1].b, { sheet: 1, side: 'back', pos: 'left' });
  const repaired = replay(imp, plan.steps);
  assert.deepEqual(repaired, generateImposition(8));
  assert.equal(validateImposition(repaired).valid, true);
});

test('修复方案：重复页与缺页用改值补齐', () => {
  const imp = generateImposition(8);
  imp.sheets[1].back.right = 1; // 第 5 页被改为第 1 页（1 重复、5 缺失）
  const plan = planRepair(imp);
  assert.deepEqual(plan.steps, [
    { type: 'set', slot: { sheet: 2, side: 'back', pos: 'right' }, from: 1, to: 5 },
  ]);
  assert.equal(validateImposition(replay(imp, plan.steps)).valid, true);
});

test('修复方案：越界页改值替换', () => {
  const imp = generateImposition(8);
  imp.sheets[0].front.left = 99;
  const plan = planRepair(imp);
  assert.deepEqual(plan.steps, [
    { type: 'set', slot: { sheet: 1, side: 'front', pos: 'left' }, from: 99, to: 8 },
  ]);
  assert.equal(validateImposition(replay(imp, plan.steps)).valid, true);
});

test('修复方案：空白错位且目标页有唯一来源 → 交换归位', () => {
  const imp = generateImposition(6); // 第 1 张 正面[空白,1] 反面[2,空白]
  imp.sheets[0].front.left = 1;
  imp.sheets[0].front.right = null;
  const plan = planRepair(imp);
  assert.equal(plan.steps.length, 1);
  const step = plan.steps[0];
  assert.equal(step.type, 'swap');
  assert.deepEqual(step.a, { sheet: 1, side: 'front', pos: 'right' });
  assert.deepEqual(step.b, { sheet: 1, side: 'front', pos: 'left' });
  assert.equal(step.aFrom, null);
  assert.equal(step.aTo, 1);
  assert.equal(step.bFrom, 1);
  assert.equal(step.bTo, null);
  assert.equal(validateImposition(replay(imp, plan.steps)).valid, true);
});

test('修复方案：有内容版位被置为空白 → 改值补齐缺页', () => {
  const imp = generateImposition(8);
  imp.sheets[0].front.right = null; // 第 1 页消失
  const plan = planRepair(imp);
  assert.deepEqual(plan.steps, [
    { type: 'set', slot: { sheet: 1, side: 'front', pos: 'right' }, from: null, to: 1 },
  ]);
  assert.equal(validateImposition(replay(imp, plan.steps)).valid, true);
});

test('修复方案：重复页占位的版位直接改值，正确副本不受影响', () => {
  const imp = generateImposition(8);
  imp.sheets[0].front.right = 5; // 应为 1；5 在第 2 张反面右版已存在
  const plan = planRepair(imp);
  assert.deepEqual(plan.steps, [
    { type: 'set', slot: { sheet: 1, side: 'front', pos: 'right' }, from: 5, to: 1 },
  ]);
  assert.equal(validateImposition(replay(imp, plan.steps)).valid, true);
});

test('修复方案：混合错误（交换环 + 重复 + 越界）全部修复并通过校验', () => {
  const imp = generateImposition(12); // 3 张纸
  // 交换环：第 2 张 正面左 10、正面右 3、反面左 4 → 轮换为 4、10、3
  imp.sheets[1].front.left = 4;
  imp.sheets[1].front.right = 10;
  imp.sheets[1].back.left = 3;
  // 重复 + 缺页：第 3 张反面右 7 → 5
  imp.sheets[2].back.right = 5;
  // 越界：第 1 张正面左 12 → 99
  imp.sheets[0].front.left = 99;
  const plan = planRepair(imp);
  // 交换在前、改值在后
  assert.deepEqual(plan.steps.map((s) => s.type), ['swap', 'swap', 'set', 'set']);
  const repaired = replay(imp, plan.steps);
  assert.deepEqual(repaired, generateImposition(12));
  assert.equal(validateImposition(repaired).valid, true);
});

test('修复方案：分帖跨帖交换 → 交换步骤带帖号，重放后通过校验', () => {
  const imp = generateImposition(16, 2); // 第 1 帖 1~8，第 2 帖 9~16
  const s1 = imp.signatures[0].sheets[0];
  const s2 = imp.signatures[1].sheets[0];
  [s1.front.left, s2.front.left] = [s2.front.left, s1.front.left]; // 8 ↔ 16
  const plan = planRepair(imp);
  assert.equal(plan.steps.length, 1);
  const step = plan.steps[0];
  assert.equal(step.type, 'swap');
  assert.deepEqual(step.a, { sheet: 1, side: 'front', pos: 'left', sig: 1 });
  assert.deepEqual(step.b, { sheet: 1, side: 'front', pos: 'left', sig: 2 });
  const repaired = replay(imp, plan.steps);
  assert.equal(validateImposition(repaired).valid, true);
  assert.equal(repaired.signatures.length, 2);
});

test('修复方案：分帖末帖空白错位 → 交换归位', () => {
  const imp = generateImposition(10, 2); // 第 2 帖 正面[空白,9] 反面[10,空白]
  const s = imp.signatures[1].sheets[0];
  s.front.left = 9;
  s.front.right = null;
  const plan = planRepair(imp);
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].type, 'swap');
  assert.equal(plan.steps[0].a.sig, 2);
  assert.equal(validateImposition(replay(imp, plan.steps)).valid, true);
});

test('应用修复：指纹匹配时修复成功，结果即标准拼版', () => {
  const imp = generateImposition(8);
  const f = imp.sheets[0].front;
  [f.left, f.right] = [f.right, f.left];
  const plan = planRepair(imp);
  const result = applyRepair(imp, plan.fingerprint);
  assert.equal(result.valid, true);
  assert.equal(result.steps, 1);
  assert.deepEqual(result.state, generateImposition(8));
  assert.equal(validateImposition(result.state).valid, true);
});

test('应用修复：生成方案后改动拼版 → 拒绝应用（stale）', () => {
  const imp = generateImposition(8);
  const f = imp.sheets[0].front;
  [f.left, f.right] = [f.right, f.left];
  const plan = planRepair(imp);

  // 拼版又被改动：指纹不符
  const changed = clone(imp);
  changed.sheets[1].front.left = 1;
  assert.equal(applyRepair(changed, plan.fingerprint).stale, true);
  // 指纹缺失 / 伪造同样拒绝
  assert.equal(applyRepair(imp, 'deadbeef').stale, true);
  assert.equal(applyRepair(imp, undefined).stale, true);
  // 原状态 + 原指纹仍可应用
  assert.equal(applyRepair(imp, plan.fingerprint).valid, true);
});

test('应用修复：保留分帖结构与爬移参数，CSV 可继续导出', () => {
  const imp = generateImposition(10, 2, { thickness: 0.1, cap: 2 });
  // 跨帖交换 + 帖内重复
  const a = imp.signatures[0].sheets[0];
  const b = imp.signatures[1].sheets[0];
  [a.front.left, b.front.left] = [b.front.left, a.front.left]; // 8 ↔ 空白
  imp.signatures[0].sheets[1].back.right = 1; // 5 缺失、1 重复
  const plan = planRepair(imp);
  assert.equal(plan.steps.length, 2);

  const result = applyRepair(imp, plan.fingerprint);
  assert.equal(result.valid, true);
  // 分帖结构与爬移参数保留
  assert.equal(result.state.signatureCount, 2);
  assert.equal(result.state.signatures.length, 2);
  assert.deepEqual(result.state.creep, { thickness: 0.1, cap: 2 });
  assert.equal(result.state.signatures[1].sheets[0].creep, 0); // 每帖独立从 0 起算
  assert.deepEqual(result.state, generateImposition(10, 2, { thickness: 0.1, cap: 2 }));
  // 既有校验与 CSV 导出继续可用
  assert.equal(validateImposition(result.state).valid, true);
  assert.match(buildCsv(result.state), /左版爬移补偿\(mm\)/);
});

test('应用修复：单帖爬移参数保留', () => {
  const imp = generateImposition(12, null, { thickness: 0.1, cap: 2 });
  const f = imp.sheets[0].front;
  [f.left, f.right] = [f.right, f.left];
  const plan = planRepair(imp);
  const result = applyRepair(imp, plan.fingerprint);
  assert.equal(result.valid, true);
  assert.deepEqual(result.state.creep, { thickness: 0.1, cap: 2 });
  assert.equal(result.state.sheets[1].creep, 0.2);
  assert.equal(validateImposition(result.state).valid, true);
});

test('修复方案：非法结构返回 null', () => {
  assert.equal(planRepair(null), null);
  assert.equal(planRepair({ pages: 3, totalPages: 8, sheets: [] }), null);
  assert.equal(planRepair({ pages: 8, totalPages: 8, sheets: [{}] }), null);
  assert.equal(applyRepair(null, 'x'), null);
  assert.equal(applyRepair({ pages: 8, totalPages: 8, sheets: [] }, 'x'), null);
});

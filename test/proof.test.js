'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateImposition, buildProofHtml } = require('../src/imposition');

/** 取出第 n 个打样页（1 起）的 section 子串，顺序为正面、反面交替 */
function pageSection(html, n) {
  const parts = html.split('<section class="sheet-page">');
  assert.ok(parts[n], `只有 ${parts.length - 1} 个打样页，取不到第 ${n} 个`);
  return parts[n];
}

/** 打样页某一半版（left/right）内部 HTML：左半位于两个 half 之间，右半到折线为止 */
function halfContent(section, pos) {
  const start = section.indexOf(`class="half ${pos}"`);
  assert.notEqual(start, -1, `缺少 ${pos} 半版`);
  const rest = section.slice(start);
  const end = pos === 'left'
    ? rest.indexOf('class="half right"')
    : rest.indexOf('class="fold"');
  return rest.slice(0, end);
}

test('打样 HTML：非法结构返回 null', () => {
  assert.equal(buildProofHtml(null), null);
  assert.equal(buildProofHtml({ pages: 3, totalPages: 8, sheets: [] }), null);
  assert.equal(buildProofHtml({ pages: 8, totalPages: 8, sheets: [{}] }), null);
});

test('打样 HTML：每张纸正反各一页，A4 横向并带打印分页', () => {
  const html = buildProofHtml(generateImposition(8));
  assert.equal((html.match(/class="sheet-page"/g) || []).length, 4); // 2 张纸 × 正反 2 页
  assert.match(html, /@page\s*{[^}]*size:\s*A4 landscape/);
  assert.match(html, /page-break-after:\s*always/);
  assert.match(html, /width:\s*297mm;\s*height:\s*210mm/);
});

test('打样 HTML：正面、反面按纸张顺序交替排列', () => {
  const html = buildProofHtml(generateImposition(8));
  const titles = [...html.matchAll(/第 (\d) 张纸（共 2 张） · (正面|反面（左右镜像）)/g)].map(
    (m) => `${m[1]}-${m[2]}`
  );
  assert.deepEqual(titles, ['1-正面', '1-反面（左右镜像）', '2-正面', '2-反面（左右镜像）']);
});

test('打样 HTML：正面页标出左右页码与空白版位', () => {
  // 6 页：第 1 张 正面[空白, 1] / 反面[2, 空白]
  const front = pageSection(buildProofHtml(generateImposition(6)), 1);
  const left = halfContent(front, 'left');
  const right = halfContent(front, 'right');
  assert.match(left, /blank-label">空白</);
  assert.doesNotMatch(left, /translateX/); // 空白版位不平移
  assert.match(right, /page-num[^>]*>1</);
  assert.match(left, /左版/);
  assert.match(right, /右版/);
});

test('打样 HTML：背面页左右版位相对正面镜像（左=反面右版，右=反面左版），文字正向', () => {
  // 8 页第 1 张：正面[8, 1]，反面[2, 7]；镜像后背面页 左 7 / 右 2
  const back = pageSection(buildProofHtml(generateImposition(8)), 2);
  const left = halfContent(back, 'left');
  const right = halfContent(back, 'right');
  assert.match(left, /page-num[^>]*>7</);
  assert.match(right, /page-num[^>]*>2</);
  // 不做旋转，文字保持正向
  assert.doesNotMatch(back, /rotate/);
});

test('打样 HTML：每面含中央折线与四角对位标', () => {
  const html = buildProofHtml(generateImposition(4)); // 1 张纸 2 面
  const front = pageSection(html, 1);
  const back = pageSection(html, 2);
  for (const section of [front, back]) {
    assert.equal((section.match(/class="fold"/g) || []).length, 1);
    assert.equal((section.match(/class="reg"/g) || []).length, 4);
    for (const pos of ['top:3mm;left:3mm', 'top:3mm;right:3mm', 'bottom:3mm;left:3mm', 'bottom:3mm;right:3mm']) {
      assert.ok(section.includes(pos), `缺少四角对位标：${pos}`);
    }
  }
});

test('打样 HTML：启用爬移时仅页码内容朝折线平移，折线与对位标不动', () => {
  // 8 页、纸厚 0.10、上限 2：第 1 张 c=0，第 2 张 c=0.20
  const html = buildProofHtml(generateImposition(8, null, { thickness: 0.1, cap: 2 }));

  const sheet1Front = pageSection(html, 1);
  assert.match(halfContent(sheet1Front, 'left'), /translateX\(0\.00mm\)/);
  assert.match(halfContent(sheet1Front, 'right'), /translateX\(-0\.00mm\)|translateX\(0\.00mm\)/);

  // 第 2 张正面 [6, 3]：左半页码 6 向右 +0.20，右半页码 3 向左 -0.20
  const sheet2Front = pageSection(html, 3);
  assert.match(halfContent(sheet2Front, 'left'), /page-num[^>]*translateX\(0\.20mm\)[^>]*>6</);
  assert.match(halfContent(sheet2Front, 'right'), /page-num[^>]*translateX\(-0\.20mm\)[^>]*>3</);
  assert.match(sheet2Front, /爬移补偿 0\.20 mm/);

  // 对位标与折线不带任何平移
  assert.doesNotMatch(html, /class="reg"[^>]*transform/);
  assert.doesNotMatch(html, /class="fold"[^>]*transform/);
});

test('打样 HTML：背面镜像后爬移仍按打样页左右朝折线（左 +c、右 −c）', () => {
  // 第 2 张反面 [4, 5]：镜像后背面页 左 5 / 右 4，左半 +0.20、右半 -0.20
  const html = buildProofHtml(generateImposition(8, null, { thickness: 0.1, cap: 2 }));
  const sheet2Back = pageSection(html, 4);
  assert.match(halfContent(sheet2Back, 'left'), /page-num[^>]*translateX\(0\.20mm\)[^>]*>5</);
  assert.match(halfContent(sheet2Back, 'right'), /page-num[^>]*translateX\(-0\.20mm\)[^>]*>4</);
});

test('打样 HTML：未启用爬移时不输出任何平移', () => {
  const html = buildProofHtml(generateImposition(8));
  assert.doesNotMatch(html, /translateX/);
  assert.doesNotMatch(html, /爬移补偿/);
});

test('打样 HTML：分帖按帖号与帖内纸张顺序排列', () => {
  // 10 页 M=2：第 1 帖 2 张、第 2 帖 1 张，共 6 个打样页
  const html = buildProofHtml(generateImposition(10, 2));
  assert.equal((html.match(/class="sheet-page"/g) || []).length, 6);
  const titles = [...html.matchAll(/第 (\d) 帖 · 第 (\d) 张纸（帖内共 \d 张） · (正面|反面（左右镜像）)/g)].map(
    (m) => `${m[1]}-${m[2]}-${m[3]}`
  );
  assert.deepEqual(titles, [
    '1-1-正面', '1-1-反面（左右镜像）',
    '1-2-正面', '1-2-反面（左右镜像）',
    '2-1-正面', '2-1-反面（左右镜像）',
  ]);
});

test('打样 HTML：末帖空白版位正常标出', () => {
  // 10 页 M=2：第 2 帖 正面[空白, 9] / 反面[10, 空白]
  const html = buildProofHtml(generateImposition(10, 2));
  const sig2Front = pageSection(html, 5); // 帖 1 占 4 页，第 5 页为帖 2 正面
  assert.match(halfContent(sig2Front, 'left'), /blank-label">空白</);
  assert.match(halfContent(sig2Front, 'right'), /page-num[^>]*>9</);
});

test('打样 HTML：篡改爬移补偿数据被拒绝', () => {
  const imp = generateImposition(8, null, { thickness: 0.1, cap: 2 });
  const bad = JSON.parse(JSON.stringify(imp));
  bad.sheets[1].creep = 0.9;
  assert.equal(buildProofHtml(bad), null);
});

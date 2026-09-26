'use strict';

const crypto = require('crypto');

/**
 * 骑马钉（saddle-stitch）小册子拼版核心逻辑。
 *
 * 单帖模式：总页数 N 必须为 4 的倍数，共 N/4 张纸，每张纸正反两面、每面左右两版。
 * 第 i 张纸（1 起，最外层为第 1 张）的标准拼版为：
 *   正面：左版 = N - 2(i-1)，右版 = 2i - 1
 *   反面：左版 = 2i，        右版 = N - 2i + 1
 * 特性：每面左右页码之和 = N + 1；左版恒为偶数页、右版恒为奇数页；
 *       正面左版与反面右版同属一张书叶（连续页），正面右版与反面左版同理。
 *
 * 分帖模式：用户设置每帖最多纸张数 M（1~8），每帖容量为 4M 个成品页，
 * 成品页按顺序切成容量 4M 的连续区间（最后一帖取剩余页）；
 * 每个区间即一帖，帖内按上述骑马钉公式独立拼版（局部页码映射到全局页码），
 * 仅最后一帖把剩余页补空白至 4 的倍数。跨帖页码必须连续、无重复、无缺失。
 *
 * 爬移补偿（可选，单帖/分帖通用）：提供单张纸厚度 t（0.01~0.50 mm）与补偿上限
 * cap（0~10 mm）后，每帖独立按由外到内的纸张序号 k（1 起）计算
 *   c = min(2 × t × (k−1), cap)   （首张 k=1 时 c=0）
 * 每张纸正反面共用同一 c：左版向右（+c）、右版向左（−c），均朝折线移动。
 * 未启用或上限为 0 时不产生任何补偿数据，结果与启用前完全一致；
 * 校验/导出时服务端按参数重算每张纸的补偿值，与提交数据不符即拒绝。
 */

const SIDES = ['front', 'back'];
const POSITIONS = ['left', 'right'];
const SIDE_LABEL = { front: '正面', back: '反面' };
const POS_LABEL = { left: '左版', right: '右版' };

const MAX_PAGES = 500;
const MAX_SHEETS_PER_SIGNATURE = 8;
const MIN_PAPER_THICKNESS = 0.01; // 单张纸厚度下限（mm）
const MAX_PAPER_THICKNESS = 0.5; // 单张纸厚度上限（mm）
const MAX_CREEP_CAP = 10; // 爬移补偿上限的最大值（mm）

/** 将页数补齐到 4 的倍数 */
function padToMultipleOf4(n) {
  const r = n % 4;
  return r === 0 ? n : n + (4 - r);
}

/** 保留两位小数（0.01 mm 精度），消除浮点误差 */
function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * 规范化爬移补偿参数；返回 null 表示未启用（未提供参数，或补偿上限为 0）。
 * thickness：单张纸厚度 0.01~0.50 mm；cap：补偿上限 0~10 mm；均按 0.01 mm 精度。
 * 参数非法时抛出 RangeError。
 */
function normalizeCreepParams(raw) {
  if (raw === undefined || raw === null) return null;
  const thickness = Number(raw && raw.thickness);
  const cap = Number(raw && raw.cap);
  const is2dp = (n) => Number.isFinite(n) && Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
  if (!is2dp(thickness) || thickness < MIN_PAPER_THICKNESS || thickness > MAX_PAPER_THICKNESS) {
    throw new RangeError(
      `单张纸厚度必须是 ${MIN_PAPER_THICKNESS}~${MAX_PAPER_THICKNESS} mm 的数值（0.01 mm 精度）`
    );
  }
  if (!is2dp(cap) || cap < 0 || cap > MAX_CREEP_CAP) {
    throw new RangeError(`补偿上限必须是 0~${MAX_CREEP_CAP} mm 的数值（0.01 mm 精度）`);
  }
  if (cap === 0) return null; // 上限为 0：等同未启用
  return { thickness: round2(thickness), cap: round2(cap) };
}

/** 第 k 张纸（1 起，由外到内）的爬移补偿量（mm）：c = min(2 × 纸厚 × (k−1), 上限)，首张为 0 */
function creepForSheet(k, thickness, cap) {
  return Math.min(round2(2 * thickness * (k - 1)), cap);
}

/** 带符号的毫米值（CSV 用），如 +0.20 / -0.20；0 记作 +0.00 */
function formatSignedMm(v) {
  return (v < 0 ? '-' : '+') + round2(Math.abs(v)).toFixed(2);
}

/** 第 sheetIndex 张纸（1 起）某面某版位在「帖内局部页码」下的标准页码 */
function expectedPage(sheetIndex, side, position, totalPages) {
  const N = totalPages;
  const i = sheetIndex;
  if (side === 'front') {
    return position === 'left' ? N - 2 * (i - 1) : 2 * i - 1;
  }
  return position === 'left' ? 2 * i : N - 2 * i + 1;
}

/**
 * 分帖方案：按成品页顺序切分为容量 4M 的连续区间，仅最后一帖补空白至 4 的倍数。
 * 返回 [{ sig, sheetCount, startPage, endPage, contentEndPage }]：
 *   sig            帖号（1 起）
 *   sheetCount     本帖纸张数（补齐至 4 的倍数后）
 *   startPage      本帖起始成品页（全局页码）
 *   endPage        本帖补齐后的末页页码（含空白页位）
 *   contentEndPage 本帖最后一张有内容成品页的页码
 */
function planSignatures(pages, maxSheetsPerSignature) {
  const capacity = 4 * maxSheetsPerSignature;
  const plan = [];
  let remaining = pages;
  let start = 1;
  let sig = 1;
  while (remaining > 0) {
    const take = Math.min(remaining, capacity); // 本帖承载的成品页数
    const padded = padToMultipleOf4(take); // 非末帖 take=capacity 必为 4 的倍数
    plan.push({
      sig,
      sheetCount: padded / 4,
      startPage: start,
      endPage: start + padded - 1,
      contentEndPage: start + take - 1,
    });
    start += take;
    remaining -= take;
    sig += 1;
  }
  return plan;
}

/**
 * 构建一帖的纸张拼版（局部页码按骑马钉公式生成后映射为全局页码）。
 * startPage 本帖起始全局页码；localN 本帖补齐后总页数；contentCount 本帖有内容页数。
 * sigIndex 为 null 时构建旧单帖结构（纸张不带 sig 字段，保持 API 兼容）。
 * creepParams 非 null 时每张纸附带 creep 字段（按帖内序号 k 计算的补偿量 mm）。
 */
function buildSheets(startPage, localN, contentCount, sigIndex, creepParams) {
  const sheets = [];
  for (let i = 1; i <= localN / 4; i++) {
    const sheet = sigIndex == null
      ? { index: i, front: {}, back: {} }
      : { sig: sigIndex, index: i, front: {}, back: {} };
    for (const side of SIDES) {
      for (const pos of POSITIONS) {
        const localPage = expectedPage(i, side, pos, localN);
        const globalPage = startPage - 1 + localPage;
        sheet[side][pos] = localPage <= contentCount ? globalPage : null;
      }
    }
    if (creepParams) sheet.creep = creepForSheet(i, creepParams.thickness, creepParams.cap);
    sheets.push(sheet);
  }
  return sheets;
}

/**
 * 生成标准拼版。
 *  - generateImposition(pages)：单帖模式（兼容旧调用），
 *    版位内容为页码（1..pages）或 null（空白版位）。
 *  - generateImposition(pages, maxSheetsPerSignature)：分帖模式，
 *    返回 signatures 分组，每帖纸张带 sig / index，区间外版位为 null。
 *  - 第三参数 creep：{ thickness, cap } 启用爬移补偿（上限为 0 等同未启用），
 *    启用时响应顶层带 creep 参数、每张纸带 creep 补偿量（mm）。
 */
function generateImposition(pages, maxSheetsPerSignature, creep) {
  const totalPages = padToMultipleOf4(pages);
  const creepParams = normalizeCreepParams(creep);

  if (maxSheetsPerSignature === undefined || maxSheetsPerSignature === null) {
    const sheets = buildSheets(1, totalPages, pages, null, creepParams);
    const result = { pages, totalPages, sheetCount: totalPages / 4, sheets };
    if (creepParams) result.creep = creepParams;
    return result;
  }

  const M = Number(maxSheetsPerSignature);
  if (!Number.isInteger(M) || M < 1 || M > MAX_SHEETS_PER_SIGNATURE) {
    throw new RangeError(`每帖最多纸张数必须是 1~${MAX_SHEETS_PER_SIGNATURE} 的整数`);
  }

  const plan = planSignatures(pages, M);
  const signatures = plan.map((p) => ({
    sig: p.sig,
    sheetCount: p.sheetCount,
    startPage: p.startPage,
    endPage: p.endPage,
    sheets: buildSheets(
      p.startPage,
      p.endPage - p.startPage + 1,
      p.contentEndPage - p.startPage + 1,
      p.sig,
      creepParams
    ),
  }));

  const result = {
    pages,
    totalPages,
    sheetCount: totalPages / 4,
    signatureCount: plan.length,
    sheetsPerSignature: M,
    signatures,
  };
  if (creepParams) result.creep = creepParams;
  return result;
}

/** 读取并规范化一张纸；结构不合法（含爬移补偿数据被篡改）返回 null */
function readSheet(rawSheet, sig, index, creepParams) {
  if (!rawSheet || typeof rawSheet !== 'object') return null;
  if (sig != null) {
    if (Number(rawSheet.sig) !== sig || Number(rawSheet.index) !== index) return null;
  }
  const sheet = sig == null
    ? { index, front: {}, back: {} }
    : { sig, index, front: {}, back: {} };
  // 爬移补偿：启用时按参数重算并逐张核对；未启用时不允许携带补偿数据
  if (creepParams) {
    const expected = creepForSheet(index, creepParams.thickness, creepParams.cap);
    const v = Number(rawSheet.creep);
    if (!Number.isFinite(v) || Math.abs(round2(v) - expected) > 1e-9) return null;
    sheet.creep = expected;
  } else if (rawSheet.creep !== undefined && rawSheet.creep !== null) {
    return null;
  }
  for (const side of SIDES) {
    if (!rawSheet[side] || typeof rawSheet[side] !== 'object') return null;
    for (const pos of POSITIONS) {
      const v = rawSheet[side][pos];
      if (v === null || v === undefined) {
        sheet[side][pos] = null;
        continue;
      }
      const n = Number(v);
      if (!Number.isInteger(n)) return null;
      sheet[side][pos] = n;
    }
  }
  return sheet;
}

/** 校验并规范化前端提交的状态；结构不合法时返回 null */
function normalizeState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const pages = Number(raw.pages);
  if (!Number.isInteger(pages) || pages < 1 || pages > MAX_PAGES) return null;
  const totalPages = Number(raw.totalPages);
  if (!Number.isInteger(totalPages) || totalPages !== padToMultipleOf4(pages)) return null;

  // 爬移补偿参数：非法参数一律拒绝（纸张上的补偿值在 readSheet 中逐张核对）
  let creepParams;
  try {
    creepParams = normalizeCreepParams(raw.creep);
  } catch {
    return null;
  }

  // 分帖模式
  if (Array.isArray(raw.signatures)) {
    const M = Number(raw.sheetsPerSignature);
    if (!Number.isInteger(M) || M < 1 || M > MAX_SHEETS_PER_SIGNATURE) return null;
    if (!Number.isInteger(raw.signatureCount) || !Number.isInteger(raw.sheetCount)) return null;
    if (raw.sheetCount !== totalPages / 4) return null;

    const plan = planSignatures(pages, M);
    if (raw.signatureCount !== plan.length) return null;
    if (raw.signatures.length !== plan.length) return null;

    const signatures = [];
    const flatSheets = [];
    for (let k = 0; k < plan.length; k++) {
      const piece = plan[k];
      const rawSig = raw.signatures[k];
      if (!rawSig || typeof rawSig !== 'object') return null;
      if (Number(rawSig.sig) !== piece.sig) return null;
      if (Number(rawSig.sheetCount) !== piece.sheetCount) return null;
      if (Number(rawSig.startPage) !== piece.startPage) return null;
      if (Number(rawSig.endPage) !== piece.endPage) return null;
      if (!Array.isArray(rawSig.sheets) || rawSig.sheets.length !== piece.sheetCount) return null;

      const sheets = [];
      for (let i = 0; i < piece.sheetCount; i++) {
        const sheet = readSheet(rawSig.sheets[i], piece.sig, i + 1, creepParams);
        if (!sheet) return null;
        sheets.push(sheet);
        flatSheets.push(sheet);
      }
      signatures.push({
        sig: piece.sig,
        sheetCount: piece.sheetCount,
        startPage: piece.startPage,
        endPage: piece.endPage,
        sheets,
      });
    }

    return {
      pages,
      totalPages,
      sheetCount: totalPages / 4,
      mode: 'multi',
      sheetsPerSignature: M,
      signatureCount: plan.length,
      signatures,
      sheets: flatSheets,
      creep: creepParams,
    };
  }

  // 单帖模式（兼容旧状态结构）
  if (!Array.isArray(raw.sheets) || raw.sheets.length !== totalPages / 4) return null;
  const sheets = [];
  for (let k = 0; k < raw.sheets.length; k++) {
    const sheet = readSheet(raw.sheets[k], null, k + 1, creepParams);
    if (!sheet) return null;
    sheets.push(sheet);
  }
  return { pages, totalPages, sheetCount: totalPages / 4, mode: 'single', sheets, creep: creepParams };
}

/**
 * 实时校验：
 *  - duplicates：重复出现的有内容页
 *  - missing：缺失的有内容页
 *  - outOfRange：超出 1..N 的页码
 *  - crossSignature（仅分帖模式）：页码出现在错误的帖区间，跨帖页码不连续
 *  - pairing：每张纸的正反配对异常（空白错位、奇偶、页码和、书叶配对、套帖顺序）
 * 单帖错误定位到纸张/面/版位；分帖错误额外定位到帖。
 * 返回 { valid, errors, slotErrors }；结构非法返回 null。
 */
function validateImposition(raw) {
  const state = normalizeState(raw);
  if (!state) return null;
  const { pages: P, totalPages: N, mode, sheets } = state;
  const multi = mode === 'multi';

  const errors = { duplicates: [], missing: [], outOfRange: [] };
  if (multi) errors.crossSignature = [];
  errors.pairing = [];
  const slotErrors = [];
  const addSlot = (sig, sheet, side, pos, message) => {
    const entry = { sheet, side, pos, message };
    if (multi) entry.sig = sig;
    slotErrors.push(entry);
  };

  // 统计每个页码出现的位置
  const occurrences = new Map();
  for (const s of sheets) {
    for (const side of SIDES) {
      for (const pos of POSITIONS) {
        const v = s[side][pos];
        if (v === null) continue;
        if (!occurrences.has(v)) occurrences.set(v, []);
        occurrences.get(v).push({ sig: s.sig ?? null, sheet: s.index, side, pos });
      }
    }
  }

  // 页码超范围
  const out = [...occurrences.keys()].filter((p) => p < 1 || p > N).sort((a, b) => a - b);
  errors.outOfRange = out;
  for (const p of out) {
    for (const ref of occurrences.get(p)) {
      addSlot(ref.sig, ref.sheet, ref.side, ref.pos, `页码 ${p} 超出有效范围 1~${N}`);
    }
  }

  // 重复页（仅统计有内容页 1..P）
  for (const [p, refs] of occurrences) {
    if (p >= 1 && p <= P && refs.length > 1) {
      errors.duplicates.push(p);
      for (const ref of refs) {
        addSlot(ref.sig, ref.sheet, ref.side, ref.pos, `第 ${p} 页重复出现 ${refs.length} 次`);
      }
    }
  }
  errors.duplicates.sort((a, b) => a - b);

  // 缺页
  for (let p = 1; p <= P; p++) {
    if (!occurrences.has(p)) errors.missing.push(p);
  }

  // 待校验的帖：单帖视为起始页为 1 的唯一一帖
  const groups = multi
    ? state.signatures
    : [{ sig: null, startPage: 1, endPage: N, sheets }];

  // 分帖模式：为缺页定位到应排该页的帖/纸张/版位（标准位置若为空白，配对检查已覆盖）
  if (multi) {
    for (const p of errors.missing) {
      const g = state.signatures.find((sg) => p >= sg.startPage && p <= sg.endPage);
      if (!g) continue;
      const localN = g.endPage - g.startPage + 1;
      const base = g.startPage - 1;
      for (const s of g.sheets) {
        let hit = false;
        for (const side of SIDES) {
          for (const pos of POSITIONS) {
            if (s[side][pos] !== null) continue;
            if (base + expectedPage(s.index, side, pos, localN) === p) {
              addSlot(g.sig, s.index, side, pos, `缺失第 ${p} 页：此版位应排第 ${p} 页`);
              hit = true;
              break;
            }
          }
          if (hit) break;
        }
        if (hit) break;
      }
    }
  }

  // 每帖内部拼版规则检查
  for (const g of groups) {
    const base = g.startPage - 1;
    const localN = g.endPage - g.startPage + 1;
    const contentEnd = Math.min(P, g.endPage); // 本帖最后一张有内容页（全局页码）

    for (const s of g.sheets) {
      const i = s.index;
      const msgs = [];
      const exp = {
        front: { left: expectedPage(i, 'front', 'left', localN), right: expectedPage(i, 'front', 'right', localN) },
        back: { left: expectedPage(i, 'back', 'left', localN), right: expectedPage(i, 'back', 'right', localN) },
      };

      // 空白/实页错位检查，并计算用于规则校验的有效页码（空白版位按其应有页码参与）
      const eff = { front: {}, back: {} };
      let usable = true;
      for (const side of SIDES) {
        for (const pos of POSITIONS) {
          const v = s[side][pos];
          const eGlobal = base + exp[side][pos];
          const label = `${SIDE_LABEL[side]}${POS_LABEL[pos]}`;
          if (v === null) {
            if (eGlobal <= P) {
              msgs.push(`${label}应排第 ${eGlobal} 页，当前为空白`);
              addSlot(g.sig, i, side, pos, `应排第 ${eGlobal} 页，当前为空白`);
              usable = false;
            } else {
              eff[side][pos] = eGlobal;
            }
          } else {
            if (eGlobal > P) {
              msgs.push(`${label}应为空白版位，当前排了第 ${v} 页`);
              addSlot(g.sig, i, side, pos, '此版位应为空白');
            }
            eff[side][pos] = v;
          }
        }
      }

      if (usable) {
        const FL = eff.front.left;
        const FR = eff.front.right;
        const BL = eff.back.left;
        const BR = eff.back.right;
        const targetSum = g.startPage + g.endPage;

        // 奇偶规则：左版为偶数页，右版为奇数页（帖起点偏移为 4 的倍数，奇偶性与帖内一致）
        for (const side of SIDES) {
          const L = eff[side].left;
          const R = eff[side].right;
          if (L % 2 !== 0) {
            msgs.push(`${SIDE_LABEL[side]}左版应为偶数页，当前为第 ${L} 页`);
            addSlot(g.sig, i, side, 'left', '左版应为偶数页');
          }
          if (R % 2 !== 1) {
            msgs.push(`${SIDE_LABEL[side]}右版应为奇数页，当前为第 ${R} 页`);
            addSlot(g.sig, i, side, 'right', '右版应为奇数页');
          }
        }

        // 每面左右页码之和 = 帖起点 + 帖末页
        for (const side of SIDES) {
          const sum = eff[side].left + eff[side].right;
          if (sum !== targetSum) {
            msgs.push(`${SIDE_LABEL[side]}左右页码之和应为 ${targetSum}，当前为 ${sum}`);
            addSlot(g.sig, i, side, 'left', `左右页码之和应为 ${targetSum}`);
            addSlot(g.sig, i, side, 'right', `左右页码之和应为 ${targetSum}`);
          }
        }

        // 书叶配对：正面左↔反面右、正面右↔反面左 应为连续页（同一张书叶的正反）
        const mates = (a, b) => Math.abs(a - b) === 1 && Math.min(a, b) % 2 === 1;
        if (!mates(FL, BR)) {
          msgs.push(`正面左版（第 ${FL} 页）与反面右版（第 ${BR} 页）应同属一张书叶（连续页）`);
          addSlot(g.sig, i, 'front', 'left', '与反面右版书叶配对异常');
          addSlot(g.sig, i, 'back', 'right', '与正面左版书叶配对异常');
        }
        if (!mates(FR, BL)) {
          msgs.push(`正面右版（第 ${FR} 页）与反面左版（第 ${BL} 页）应同属一张书叶（连续页）`);
          addSlot(g.sig, i, 'front', 'right', '与反面左版书叶配对异常');
          addSlot(g.sig, i, 'back', 'left', '与正面右版书叶配对异常');
        }

        // 套帖顺序：本张纸的页码组合应与其在帖内的嵌套位置一致
        const want = [exp.front.left, exp.front.right, exp.back.left, exp.back.right]
          .map((x) => base + x)
          .sort((a, b) => a - b);
        const got = [FL, FR, BL, BR].slice().sort((a, b) => a - b);
        if (want.some((w, k) => got[k] !== w)) {
          msgs.push(`本张纸页码组合应为 {${want.join(', ')}}，当前为 {${got.join(', ')}}（套帖顺序异常）`);
          for (const side of SIDES) {
            for (const pos of POSITIONS) addSlot(g.sig, i, side, pos, '纸张页码组合与套帖顺序不符');
          }
        }
      }

      if (msgs.length) {
        const entry = { sheet: i, messages: msgs };
        if (multi) entry.sig = g.sig;
        errors.pairing.push(entry);
      }
    }

    // 跨帖连续性：本帖所有有内容版位必须落在本帖连续区间内
    if (multi) {
      const reported = new Set();
      for (const s of g.sheets) {
        for (const side of SIDES) {
          for (const pos of POSITIONS) {
            const v = s[side][pos];
            if (v === null) continue;
            if (v < g.startPage || v > contentEnd) {
              addSlot(
                g.sig,
                s.index,
                side,
                pos,
                `第 ${v} 页不属于第 ${g.sig} 帖区间（第 ${g.startPage}～${contentEnd} 页），跨帖页码不连续`
              );
              if (!reported.has(v)) {
                reported.add(v);
                errors.crossSignature.push({
                  sig: g.sig,
                  page: v,
                  message: `第 ${v} 页出现在第 ${g.sig} 帖，但本帖应为第 ${g.startPage}～${contentEnd} 页的连续区间`,
                });
              }
            }
          }
        }
      }
    }
  }

  if (multi) errors.crossSignature.sort((a, b) => a.sig - b.sig || a.page - b.page);

  const valid =
    errors.duplicates.length === 0 &&
    errors.missing.length === 0 &&
    errors.outOfRange.length === 0 &&
    (!multi || errors.crossSignature.length === 0) &&
    errors.pairing.length === 0;

  return { valid, errors, slotErrors };
}

/* ---------- 修复方案 ---------- */

/** 稳定序列化（对象键名排序后拼接），用于计算状态指纹 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** 规范化状态的内容指纹：页码、空白、分帖结构或爬移参数的任何改动都会改变指纹 */
function stateFingerprint(state) {
  return crypto.createHash('sha256').update(stableStringify(state), 'utf8').digest('hex');
}

/** 按版位引用（sig 为 null 表示单帖）在原始状态上写入页码；调用前结构已通过 normalizeState 校验 */
function writeRawSlot(raw, ref, value) {
  const sheets = ref.sig == null ? raw.sheets : raw.signatures[ref.sig - 1].sheets;
  sheets[ref.sheet - 1][ref.side][ref.pos] = value;
}

/**
 * 生成修复方案：以服务端标准拼版为目标，给出把当前状态修复为标准拼版的有序步骤。
 *
 * 版位按固定顺序处理：帖号（单帖视为唯一一帖）→ 帖内纸张序号 → 面（正/反）→ 版位（左/右）。
 * 步骤分两类，先交换后改值：
 *  - swap 交换：目标页在当前状态中恰好出现一次（唯一来源）时，与来源版位交换归位；
 *    交换不改变各页码的出现次数，交换环按固定版位顺序逐步拆解，每步归位当前版位；
 *  - set 改值：缺页、重复页、越界页与空白错位等无法交换归位的版位，直接改为目标值。
 *
 * 按顺序执行全部步骤后状态即为标准拼版（必通过 validateImposition）。
 * 每个步骤用 changes 列出受影响版位及其原值 / 目标值（swap 为两个版位，set 为一个）。
 * fingerprint 为当前状态指纹：生成方案后拼版再被改动时，applyRepair 将拒绝应用旧方案。
 * 结构非法返回 null。
 */
function planRepair(raw) {
  const state = normalizeState(raw);
  if (!state) return null;
  const multi = state.mode === 'multi';

  // 服务端标准拼版：参数（页数 / 每帖纸张数 / 爬移补偿）与当前状态一致
  const target = generateImposition(
    state.pages,
    multi ? state.sheetsPerSignature : null,
    state.creep
  );

  // 固定版位顺序展开当前值与目标值
  const groups = multi ? state.signatures : [{ sig: null, sheets: state.sheets }];
  const targetGroups = multi ? target.signatures : [{ sheets: target.sheets }];
  const slots = [];
  for (let gi = 0; gi < groups.length; gi++) {
    for (let si = 0; si < groups[gi].sheets.length; si++) {
      const sheet = groups[gi].sheets[si];
      const targetSheet = targetGroups[gi].sheets[si];
      for (const side of SIDES) {
        for (const pos of POSITIONS) {
          slots.push({
            ref: { sig: multi ? sheet.sig : null, sheet: sheet.index, side, pos },
            cur: sheet[side][pos],
            tgt: targetSheet[side][pos],
          });
        }
      }
    }
  }

  const cur = slots.map((s) => s.cur);
  const tgt = slots.map((s) => s.tgt);
  const steps = [];

  // 各页码出现次数（交换不改变多重集合，交换阶段内计数恒定）与唯一来源页码的位置
  const count = new Map();
  for (const v of cur) count.set(v, (count.get(v) || 0) + 1);
  const posOf = new Map();
  cur.forEach((v, i) => {
    if (count.get(v) === 1) posOf.set(v, i);
  });

  // 第一阶段：目标页有唯一来源的版位，通过交换归位（交换环按固定版位顺序拆解）
  for (let i = 0; i < slots.length; i++) {
    if (cur[i] === tgt[i]) continue;
    const v = tgt[i];
    if (v === null || count.get(v) !== 1) continue; // 目标空白 / 缺页 / 重复页：改值阶段处理
    const j = posOf.get(v); // 来源版位必然也未归位（已归位的版位不会再被交换触碰）
    steps.push({
      type: 'swap',
      changes: [
        { slot: slots[i].ref, from: cur[i], to: v },
        { slot: slots[j].ref, from: v, to: cur[i] },
      ],
    });
    const w = cur[i];
    cur[i] = v;
    cur[j] = w;
    posOf.set(v, i);
    if (count.get(w) === 1) posOf.set(w, j);
  }

  // 第二阶段：剩余版位（缺页、重复页、越界页、空白错位）直接改为目标值
  for (let i = 0; i < slots.length; i++) {
    if (cur[i] === tgt[i]) continue;
    steps.push({
      type: 'set',
      changes: [{ slot: slots[i].ref, from: cur[i], to: tgt[i] }],
    });
    cur[i] = tgt[i];
  }

  return {
    valid: validateImposition(raw).valid,
    stepCount: steps.length,
    steps,
    fingerprint: stateFingerprint(state),
  };
}

/**
 * 应用修复方案：核对状态指纹（生成方案后拼版被改动则拒绝），重新推导确定性步骤并应用。
 * 返回 null：结构非法；{ stale, fingerprint }：指纹不符（拼版已改动，需重新生成方案）；
 * 成功：{ state, validation, steps }，state 为修复后的完整状态（保留提交时的分帖结构与爬移参数）。
 */
function applyRepair(raw, fingerprint) {
  const state = normalizeState(raw);
  if (!state) return null;
  const actual = stateFingerprint(state);
  if (fingerprint !== actual) {
    return { stale: true, fingerprint: actual };
  }
  const plan = planRepair(raw); // 确定性推导：与生成方案时的步骤一致
  const next = JSON.parse(JSON.stringify(raw));
  for (const step of plan.steps) {
    for (const change of step.changes) {
      writeRawSlot(next, change.slot, change.to);
    }
  }
  const validation = validateImposition(next);
  if (!validation || !validation.valid) return { error: '修复结果未通过校验' };
  return { state: next, validation, steps: plan.steps };
}

/* ---------- 双面打样 HTML ---------- */

/** 四角对位标（十字套圆）：正背面画在同一物理位置，双面打印透光应重合，用于套准检查 */
function registrationMark(posStyle) {
  return (
    `<svg class="reg" style="${posStyle}" viewBox="0 0 10 10" aria-hidden="true">` +
    '<circle cx="5" cy="5" r="2.4" fill="none" stroke="#000" stroke-width="0.3"/>' +
    '<path d="M5 0.5V9.5M0.5 5H9.5" fill="none" stroke="#000" stroke-width="0.3"/>' +
    '</svg>'
  );
}

/**
 * 打样半版：pos 左/右；page 页码或 null（空白版位）。
 * creepMm 为 null 表示未启用爬移补偿；否则仅页码内容朝中央折线平移
 * （左半 +c 向右、右半 −c 向左），空白版位与版位标签不动。
 */
function proofHalf(pos, page, creepMm) {
  const posTag = `<span class="pos-tag">${POS_LABEL[pos]}</span>`;
  if (page === null) {
    return `<div class="half ${pos}">${posTag}<span class="blank-label">空白</span></div>`;
  }
  let style = '';
  if (creepMm !== null) {
    const shift = pos === 'left' ? creepMm : -creepMm;
    style = ` style="transform:translateX(${shift.toFixed(2)}mm)"`;
  }
  return `<div class="half ${pos}">${posTag}<span class="page-num"${style}>${page}</span></div>`;
}

/** 打样单页（一张纸的一面）：A4 横向，左右两半版 + 中央折线 + 四角对位标 */
function proofPage(headLeft, headMid, leftPage, rightPage, creepMm) {
  return (
    '<section class="sheet-page">' +
    '<header class="page-head">' +
    `<span>${headLeft}</span>` +
    `<span>${headMid}</span>` +
    '<span>A4 横向 · 请按 100% 比例打印 · 双面请选择「短边翻转」</span>' +
    '</header>' +
    proofHalf('left', leftPage, creepMm) +
    proofHalf('right', rightPage, creepMm) +
    '<div class="fold"></div>' +
    '<span class="fold-label">折线</span>' +
    registrationMark('top:3mm;left:3mm') +
    registrationMark('top:3mm;right:3mm') +
    registrationMark('bottom:3mm;left:3mm') +
    registrationMark('bottom:3mm;right:3mm') +
    '</section>'
  );
}

const PROOF_CSS = `
@page { size: A4 landscape; margin: 0; }
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
  background: #e5e7eb;
  color: #111;
}
.sheet-page {
  position: relative;
  width: 297mm;
  height: 210mm;
  overflow: hidden;
  background: #fff;
  page-break-after: always;
  break-after: page;
}
.sheet-page:last-child { page-break-after: auto; break-after: auto; }
@media screen {
  body { padding: 16px 0; }
  .sheet-page { margin: 0 auto 16px; box-shadow: 0 2px 14px rgba(15, 23, 42, .25); }
}
@media print {
  body { background: none; }
}
.page-head {
  position: absolute; top: 3.5mm; left: 13mm; right: 13mm;
  display: flex; justify-content: space-between; gap: 8mm;
  font-size: 8.5pt; color: #555; white-space: nowrap;
}
.half {
  position: absolute; top: 0; bottom: 0; width: 50%;
  display: flex; align-items: center; justify-content: center;
}
.half.left { left: 0; }
.half.right { right: 0; }
.pos-tag {
  position: absolute; top: 11mm; left: 0; right: 0;
  text-align: center; font-size: 9pt; color: #9ca3af; letter-spacing: .2em;
}
.page-num { font-size: 64pt; font-weight: 700; line-height: 1; }
.blank-label {
  font-size: 20pt; color: #b6bcc7; letter-spacing: .3em;
  border: 0.4mm dashed #c9cfda; border-radius: 2mm; padding: 3mm 9mm;
}
.fold { position: absolute; left: 50%; top: 0; bottom: 0; border-left: 0.35mm dashed #dc2626; }
.fold-label { position: absolute; left: calc(50% + 1.5mm); bottom: 3mm; font-size: 8pt; color: #dc2626; }
.reg { position: absolute; width: 7mm; height: 7mm; }
`;

/**
 * 生成双面打样独立 HTML；结构非法返回 null。
 * 固定 A4 横向，每张纸正反各一页，按帖号与帖内纸张顺序排列（正面页后紧跟背面页）。
 * 正面页：左半 = 正面左版、右半 = 正面右版；
 * 背面页按短边翻转镜像排布：左半 = 反面右版、右半 = 反面左版，文字均保持正向
 * （正背面同一物理半区的页码画在打样页同一侧，透光对照即为同一张书叶的正反）。
 * 每面标出左右页码 / 空白版位、中央折线与四角对位标。
 * 启用爬移补偿时，仅页码内容按该纸张补偿量朝折线平移，折线与对位标保持原位。
 */
function buildProofHtml(raw) {
  const state = normalizeState(raw);
  if (!state) return null;

  const groups = state.mode === 'multi'
    ? state.signatures
    : [{ sig: null, sheets: state.sheets }];

  const pagesHtml = [];
  for (const g of groups) {
    for (const s of g.sheets) {
      const where = g.sig == null
        ? `第 ${s.index} 张纸（共 ${g.sheets.length} 张）`
        : `第 ${g.sig} 帖 · 第 ${s.index} 张纸（帖内共 ${g.sheets.length} 张）`;
      const creepMm = state.creep ? s.creep : null;
      const creepNote = state.creep
        ? `爬移补偿 ${s.creep.toFixed(2)} mm：仅页码内容朝折线平移，折线与对位标不动`
        : '';
      // 正面：左半左版、右半右版
      pagesHtml.push(proofPage(`${where} · 正面`, creepNote, s.front.left, s.front.right, creepMm));
      // 背面：短边翻转，左右版位相对正面镜像（左半 = 反面右版、右半 = 反面左版），文字正向
      pagesHtml.push(proofPage(`${where} · 反面（左右镜像）`, creepNote, s.back.right, s.back.left, creepMm));
    }
  }

  const title = state.mode === 'multi'
    ? `双面打样 · 成品 ${state.pages} 页 · ${state.signatureCount} 帖 ${state.sheetCount} 张纸`
    : `双面打样 · 成品 ${state.pages} 页 · ${state.sheetCount} 张纸`;

  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="UTF-8">',
    `<title>${title}</title>`,
    `<style>${PROOF_CSS}</style>`,
    '</head>',
    '<body>',
    ...pagesHtml,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** 生成 CSV（带 BOM，Excel 友好）；结构非法返回 null */
function buildCsv(raw) {
  const state = normalizeState(raw);
  if (!state) return null;
  const cell = (v) => (v === null ? '空白' : String(v));
  // 爬移补偿：每面追加左右版带符号补偿列（左版 +c 向右、右版 −c 向左，均朝折线）
  const creepCols = (sheet) =>
    state.creep ? [formatSignedMm(sheet.creep), formatSignedMm(-sheet.creep)] : [];

  // 单帖模式：保持旧 CSV 格式（启用爬移补偿时追加补偿列）
  if (state.mode === 'single') {
    const rows = [
      state.creep
        ? ['纸张序号', '面别', '左版页码', '右版页码', '左版爬移补偿(mm)', '右版爬移补偿(mm)']
        : ['纸张序号', '面别', '左版页码', '右版页码'],
    ];
    for (const s of state.sheets) {
      for (const side of SIDES) {
        rows.push([
          String(s.index),
          SIDE_LABEL[side],
          cell(s[side].left),
          cell(s[side].right),
          ...creepCols(s),
        ]);
      }
    }
    return '﻿' + rows.map((r) => r.join(',')).join('\r\n') + '\r\n';
  }

  // 分帖模式：新增帖号与帖内纸张序号
  const rows = [
    state.creep
      ? ['帖号', '帖内纸张序号', '面别', '左版页码', '右版页码', '左版爬移补偿(mm)', '右版爬移补偿(mm)']
      : ['帖号', '帖内纸张序号', '面别', '左版页码', '右版页码'],
  ];
  for (const g of state.signatures) {
    for (const s of g.sheets) {
      for (const side of SIDES) {
        rows.push([
          String(g.sig),
          String(s.index),
          SIDE_LABEL[side],
          cell(s[side].left),
          cell(s[side].right),
          ...creepCols(s),
        ]);
      }
    }
  }
  return '﻿' + rows.map((r) => r.join(',')).join('\r\n') + '\r\n';
}

module.exports = {
  MAX_PAGES,
  MAX_SHEETS_PER_SIGNATURE,
  MIN_PAPER_THICKNESS,
  MAX_PAPER_THICKNESS,
  MAX_CREEP_CAP,
  padToMultipleOf4,
  expectedPage,
  planSignatures,
  normalizeCreepParams,
  creepForSheet,
  formatSignedMm,
  generateImposition,
  normalizeState,
  validateImposition,
  planRepair,
  applyRepair,
  buildCsv,
  buildProofHtml,
};

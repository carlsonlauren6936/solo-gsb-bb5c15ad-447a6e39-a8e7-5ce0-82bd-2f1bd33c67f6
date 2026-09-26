'use strict';

const path = require('path');
const express = require('express');
const {
  MAX_PAGES,
  MAX_SHEETS_PER_SIGNATURE,
  generateImposition,
  validateImposition,
  planRepair,
  applyRepair,
  buildCsv,
  buildProofHtml,
} = require('./src/imposition');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/** 生成标准拼版（单帖模式；传入 sheetsPerSignature 时为分帖模式；可带 creep 爬移补偿参数） */
app.post('/api/generate', (req, res) => {
  const pages = Number(req.body && req.body.pages);
  if (!Number.isInteger(pages) || pages < 1 || pages > MAX_PAGES) {
    return res.status(400).json({ error: `成品页数必须是 1~${MAX_PAGES} 的整数` });
  }
  const rawM = req.body && req.body.sheetsPerSignature;
  let m = null;
  if (rawM !== undefined && rawM !== null) {
    m = Number(rawM);
    if (!Number.isInteger(m) || m < 1 || m > MAX_SHEETS_PER_SIGNATURE) {
      return res.status(400).json({
        error: `每帖最多纸张数必须是 1~${MAX_SHEETS_PER_SIGNATURE} 的整数`,
      });
    }
  }
  try {
    // creep 为可选参数：{ thickness, cap }；缺省或 cap 为 0 时结果与旧版一致
    res.json(generateImposition(pages, m, req.body && req.body.creep));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

/** 实时校验当前拼版状态 */
app.post('/api/validate', (req, res) => {
  const result = validateImposition(req.body);
  if (!result) {
    return res.status(400).json({ error: '拼版数据格式不正确' });
  }
  res.json(result);
});

/** 生成修复方案：以服务端标准拼版为目标，返回按顺序执行的交换 / 改值步骤与状态指纹 */
app.post('/api/repair/plan', (req, res) => {
  const plan = planRepair(req.body);
  if (!plan) {
    return res.status(400).json({ error: '拼版数据格式不正确' });
  }
  res.json(plan);
});

/** 应用修复方案：指纹不符（生成方案后拼版又被改动）时拒绝并返回 409 */
app.post('/api/repair/apply', (req, res) => {
  const body = req.body || {};
  const result = applyRepair(body.state, body.fingerprint);
  if (!result) {
    return res.status(400).json({ error: '拼版数据格式不正确' });
  }
  if (result.stale) {
    return res.status(409).json({ error: '拼版已在生成修复方案后被改动，请重新生成修复方案' });
  }
  if (result.error) {
    return res.status(500).json({ error: result.error });
  }
  res.json(result);
});

/** 校验通过后导出 CSV；存在错误时拒绝导出 */
app.post('/api/export', (req, res) => {
  const result = validateImposition(req.body);
  if (!result) {
    return res.status(400).json({ error: '拼版数据格式不正确' });
  }
  if (!result.valid) {
    return res.status(400).json({ error: '存在拼版错误，已禁止导出', errors: result.errors });
  }
  const csv = buildCsv(req.body);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  const filename = req.body.signatures
    ? `imposition-${req.body.totalPages}p-${req.body.signatureCount}sig.csv`
    : `imposition-${req.body.totalPages}p.csv`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
});

/** 校验通过后导出双面打样独立 HTML（A4 横向，每张纸正反各一页，短边翻转镜像）；存在错误时拒绝导出 */
app.post('/api/export/proof', (req, res) => {
  const result = validateImposition(req.body);
  if (!result) {
    return res.status(400).json({ error: '拼版数据格式不正确' });
  }
  if (!result.valid) {
    return res.status(400).json({ error: '存在拼版错误，已禁止导出', errors: result.errors });
  }
  const html = buildProofHtml(req.body);
  if (!html) {
    return res.status(400).json({ error: '拼版数据格式不正确' });
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const filename = req.body.signatures
    ? `imposition-proof-${req.body.totalPages}p-${req.body.signatureCount}sig.html`
    : `imposition-proof-${req.body.totalPages}p.html`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(html);
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`骑马钉拼版检查工具已启动: http://localhost:${PORT}`);
});

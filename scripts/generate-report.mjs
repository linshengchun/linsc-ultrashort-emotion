import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const date = arg('--date', new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }));
const rawPath = arg('--input', path.join('data', 'raw', `${date}.json`));
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error('缺少 OPENAI_API_KEY。请在 GitHub Actions Secrets 中配置。');

const raw = JSON.parse(await readFile(rawPath, 'utf8'));

const listFrom = (payload) => {
  if (Array.isArray(payload)) return payload.flatMap(listFrom);
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['records', 'data', 'items', 'list', 'results', 'rows']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
};
const pick = (row, names) => {
  for (const name of names) if (row?.[name] !== undefined && row[name] !== null) return row[name];
  return null;
};
const num = (value) => {
  const parsed = Number(String(value ?? '').replace('%', '').replaceAll(',', ''));
  return Number.isFinite(parsed) ? parsed : null;
};
const codeOf = (row) => String(pick(row, ['symbol', 'code', 'stock_code', '证券代码', '股票代码']) ?? '');
const nameOf = (row) => String(pick(row, ['name', 'stock_name', 'sec_name', '证券简称', '股票简称', '名称']) ?? '');
const eligible = (row) => {
  const code = codeOf(row).replace(/\D/g, '').slice(-6);
  const name = nameOf(row).toUpperCase();
  return !name.includes('ST') && !/^(4|8|92)/.test(code);
};

const latestTradeDateText = String(pick(listFrom(raw.latestTradeDate)[0], ['nth_trade_date', 'trade_date', 'date']) ?? '').replaceAll('/', '-');
const normalizedLatestTradeDate = latestTradeDateText?.includes('-') ? latestTradeDateText : latestTradeDateText?.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
const allStockRows = listFrom(raw.stocks);
const stockByCode = new Map(allStockRows.map((row) => [codeOf(row), row]));
const enrichName = (row) => ({ ...row, name: nameOf(row) || nameOf(stockByCode.get(codeOf(row))) });
const quoteRows = normalizedLatestTradeDate === date ? allStockRows.filter(eligible) : [];
const limitRows = listFrom(raw.limitUp).map(enrichName).filter((row) => eligible(row) && String(pick(row, ['status']) ?? 'limit_up') === 'limit_up');
const downRows = listFrom(raw.limitDown).map(enrichName).filter(eligible);
const brokenRows = listFrom(raw.brokenLimit).map(enrichName).filter(eligible);
const yesterdayRows = listFrom(raw.yesterdayLimit).map(enrichName).filter(eligible);
const limitedCodes = new Set(limitRows.map(codeOf));

let up = 0;
let down = 0;
let flat = 0;
for (const row of quoteRows) {
  const pct = num(pick(row, ['change_rate', 'change_percent', 'change_pct', 'pct_chg', 'percent', '涨跌幅']));
  if (pct === null || pct === 0) flat += 1;
  else if (pct > 0) up += 1;
  else down += 1;
}

const yesterdayFeedback = yesterdayRows.map((row) => {
  const code = codeOf(row);
  const quote = quoteRows.find((item) => codeOf(item) === code) ?? row;
  const prev = num(pick(quote, ['prev_close', 'pre_close', '昨收', '昨收价']));
  const open = num(pick(quote, ['open', 'open_price', '今开', '开盘价']));
  const close = num(pick(quote, ['close', 'price', 'last', '最新价', '收盘价']));
  return {
    code,
    name: nameOf(row) || nameOf(quote),
    openPct: prev && open !== null ? Number((((open - prev) / prev) * 100).toFixed(2)) : null,
    closePct: prev && close !== null ? Number((((close - prev) / prev) * 100).toFixed(2)) : null,
    continuedLimit: limitedCodes.has(code),
  };
});

const average = (values) => {
  const valid = values.filter((value) => value !== null);
  return valid.length ? Number((valid.reduce((sum, value) => sum + value, 0) / valid.length).toFixed(2)) : null;
};
const rate = (count, sample) => (sample ? Number(((count / sample) * 100).toFixed(2)) : null);
const feedbackSummary = (tradeDate, rows) => ({
  date: tradeDate.slice(5),
  label: new Intl.DateTimeFormat('zh-CN', { weekday: 'short', timeZone: 'Asia/Shanghai' }).format(new Date(`${tradeDate}T12:00:00+08:00`)),
  sample: rows.length,
  redOpen: rows.filter((row) => row.openPct !== null && row.openPct > 0).length,
  redOpenRate: rate(rows.filter((row) => row.openPct !== null && row.openPct > 0).length, rows.length),
  averageOpen: average(rows.map((row) => row.openPct)),
  redClose: rows.filter((row) => row.closePct !== null && row.closePct > 0).length,
  redCloseRate: rate(rows.filter((row) => row.closePct !== null && row.closePct > 0).length, rows.length),
  averageClose: average(rows.map((row) => row.closePct)),
  continuedLimit: rows.filter((row) => row.continuedLimit).length,
  continuedLimitRate: rate(rows.filter((row) => row.continuedLimit).length, rows.length),
});

const storedReportDir = path.join('data', 'reports');
let priorFeedback = [];
try {
  const priorFiles = (await readdir(storedReportDir))
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name) && name.slice(0, 10) < date)
    .sort()
    .slice(-4);
  priorFeedback = await Promise.all(priorFiles.map(async (name) => {
    const stored = JSON.parse(await readFile(path.join(storedReportDir, name), 'utf8'));
    const feedback = stored.yesterdayFeedback ?? {};
    const tradeDate = stored.date ?? name.slice(0, 10);
    return {
      date: tradeDate.slice(5),
      label: new Intl.DateTimeFormat('zh-CN', { weekday: 'short', timeZone: 'Asia/Shanghai' }).format(new Date(`${tradeDate}T12:00:00+08:00`)),
      sample: feedback.sample ?? null,
      redOpen: feedback.redOpen ?? null,
      redOpenRate: feedback.redOpenRate ?? null,
      averageOpen: feedback.averageOpen ?? null,
      redClose: feedback.redClose ?? null,
      redCloseRate: feedback.redCloseRate ?? null,
      averageClose: feedback.averageClose ?? null,
      continuedLimit: feedback.continuedLimit ?? null,
      continuedLimitRate: feedback.continuedLimitRate ?? null,
    };
  }));
} catch {
  priorFeedback = [];
}

const objective = {
  tradeDate: date,
  latestTradeDate: normalizedLatestTradeDate ?? null,
  historicalMode: normalizedLatestTradeDate !== date,
  universe: raw.universe,
  marketSnapshot: normalizedLatestTradeDate === date ? raw.marketSnapshot : null,
  breadth: { sample: quoteRows.length, up, down, flat },
  limitUp: limitRows,
  limitDown: downRows,
  brokenLimit: brokenRows,
  yesterdayFeedback,
  yesterdayFeedbackFiveDaySeed: [...priorFeedback, feedbackSummary(date, yesterdayFeedback)],
};

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['meta', 'markdown'],
  properties: {
    meta: {
      type: 'object',
      additionalProperties: false,
      required: ['date', 'displayDate', 'generatedAt', 'title', 'conclusion', 'market', 'yesterdayFeedback', 'effects', 'sources'],
      properties: {
        date: { type: 'string' },
        displayDate: { type: 'string' },
        generatedAt: { type: 'string' },
        title: { type: 'string' },
        conclusion: {
          type: 'object', additionalProperties: false,
          required: ['cycle', 'substate', 'temperature', 'summary'],
          properties: { cycle: { type: 'string' }, substate: { type: 'string' }, temperature: { type: 'integer' }, summary: { type: 'string' } },
        },
        market: {
          type: 'object', additionalProperties: false,
          required: ['turnoverYi', 'turnoverChangeYi', 'indexSummary', 'up', 'down', 'limitUp', 'limitDown', 'connected', 'highestBoard', 'fiveDays'],
          properties: {
            turnoverYi: { type: 'number' }, turnoverChangeYi: { type: 'number' }, indexSummary: { type: 'string' },
            up: { type: 'integer' }, down: { type: 'integer' }, limitUp: { type: 'integer' }, limitDown: { type: 'integer' }, connected: { type: 'integer' }, highestBoard: { type: 'integer' },
            fiveDays: {
              type: 'array', minItems: 5, maxItems: 5,
              items: {
                type: 'object', additionalProperties: false,
                required: ['date', 'label', 'turnoverYi', 'up', 'down', 'limitUp', 'limitDown', 'connected', 'highestBoard', 'state'],
                properties: {
                  date: { type: 'string' },
                  label: { type: 'string' },
                  turnoverYi: { type: ['number', 'null'] },
                  up: { type: ['integer', 'null'] },
                  down: { type: ['integer', 'null'] },
                  limitUp: { type: ['integer', 'null'] },
                  limitDown: { type: ['integer', 'null'] },
                  connected: { type: ['integer', 'null'] },
                  highestBoard: { type: ['integer', 'null'] },
                  state: { type: 'string' },
                },
              },
            },
          },
        },
        yesterdayFeedback: {
          type: 'object', additionalProperties: false,
          required: ['redOpenRate', 'continuedLimitRate', 'fiveDays'],
          properties: {
            redOpenRate: { type: 'number' },
            continuedLimitRate: { type: 'number' },
            fiveDays: {
              type: 'array', minItems: 5, maxItems: 5,
              items: {
                type: 'object', additionalProperties: false,
                required: ['date', 'label', 'sample', 'redOpen', 'redOpenRate', 'averageOpen', 'redClose', 'redCloseRate', 'averageClose', 'continuedLimit', 'continuedLimitRate'],
                properties: {
                  date: { type: 'string' },
                  label: { type: 'string' },
                  sample: { type: ['integer', 'null'] },
                  redOpen: { type: ['integer', 'null'] },
                  redOpenRate: { type: ['number', 'null'] },
                  averageOpen: { type: ['number', 'null'] },
                  redClose: { type: ['integer', 'null'] },
                  redCloseRate: { type: ['number', 'null'] },
                  averageClose: { type: ['number', 'null'] },
                  continuedLimit: { type: ['integer', 'null'] },
                  continuedLimitRate: { type: ['number', 'null'] },
                },
              },
            },
          },
        },
        effects: {
          type: 'object', additionalProperties: false, required: ['relayDifficulty'],
          properties: { relayDifficulty: { type: 'string' } },
        },
        sources: {
          type: 'object', additionalProperties: false, required: ['objective', 'themes', 'narratives', 'note'],
          properties: {
            objective: { type: 'array', items: { type: 'string' } },
            themes: { type: 'array', items: { type: 'string' } },
            narratives: { type: 'array', items: { type: 'string' } },
            note: { type: 'string' },
          },
        },
      },
    },
    markdown: { type: 'string' },
  },
};

const instructions = `你是LINSC的A股超短情绪复盘分析员。用户只做多，持股2—3日。请基于客观行情输入并使用网页搜索补充${date}及此前4个交易日的同花顺问财题材、韭研公社小作文和公开市场叙事。题材消息不与公告核验，必须称为“市场叙事”或“小作文”，评价传播强度、预期差、想象空间与价格反馈。股票池排除名称含ST或*ST、北交所，保留主板、创业板和科创板。昨日涨停反馈只保留一张GFM近5日综合表，逐日同时展示样本数、红开数、红开率、平均开盘、收红数、收红率、平均收盘、晋级涨停数和晋级率，不再另写当日明细表或第二张对比表。题材部分必须按题材一次性写清市场触发／消息面、扩散路径、涨停映射、逻辑面、预期与想象空间、持续情况和核心个股；消息面每个题材写2—4条带来源的市场叙事，优先同时覆盖同花顺问财与韭研公社，不得杜撰，不得拆成两个重复模块。近期题材持续情况必须逐日列出发酵表现和当日领涨核心票，没有可靠核心票时写“—”。不要出现数据完整性章节，不要出现异动或绕异动模块，不要写泛化的次日操作建议。第九节的一进二候选先由客观涨停时间、封板力度、题材地位和股性筛选，但“炒作逻辑”必须逐只搜索韭研公社，不得由题材名称或封板表现反推。数据源首先使用对应交易日的韭研公社个股异动解析；无论是否找到异动解析，都必须继续检索韭研公社的板块文章和其他帖子作为补充，把事件催化、资金传播路径、个股映射、市场小作文、预期差及已经定价的程度融合成一段完整、连贯的炒作逻辑，不再分项展示。若找不到对应的个股异动解析，直接使用韭研公社的板块文章和其他帖子补充，不要在报告中标注任何缺失提示；不得用其他网站替代，也不要在报告正文展示文章标题、链接或发布时间。若韭研公社的异动解析、板块文章和其他帖子都没有有效线索，则不把该标的列入候选，不得补猜。接力预判必须说明相关逻辑是否已被充分定价，并与竞价、同题材助攻及核心反馈结合。未知精确值在meta中写null、Markdown中写“—”，不得编造。Markdown必须使用标准标题、列表、引用和GFM表格。`;
const input = `生成${date}《LINSC超短情绪复盘》。Markdown必须按顺序完整包含以下9个正式模块和最后的数据来源说明：\n## 一、当日结论\n## 二、大盘基础行情、近5日与周期定位\n## 三、昨日涨停股次日反馈与近5日对比\n## 四、连板梯队与接力结构\n## 五、高标、情绪锚与题材影响\n## 六、涨停题材事件树与结构分析\n## 七、近期题材持续情况\n## 八、赚钱效应、亏钱效应与接力难度\n## 九、次日1进2预期标的\n## 数据来源与使用边界\n\n客观输入：\n${JSON.stringify(objective)}`;

const response = await fetch('https://api.openai.com/v1/responses', {
  method: 'POST',
  headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    model: process.env.OPENAI_MODEL ?? 'gpt-5.4',
    store: false,
    reasoning: { effort: 'high' },
    tools: [{ type: 'web_search' }],
    max_tool_calls: 20,
    instructions,
    input,
    text: { format: { type: 'json_schema', name: 'linsc_report', strict: true, schema } },
  }),
});
if (!response.ok) throw new Error(`OpenAI生成失败：HTTP ${response.status} ${await response.text()}`);
const payload = await response.json();
const outputText = payload.output_text ?? payload.output?.flatMap((item) => item.content ?? []).find((item) => item.type === 'output_text')?.text;
if (!outputText) throw new Error(`OpenAI未返回报告文本：${JSON.stringify(payload.error ?? payload.incomplete_details ?? {})}`);
const generated = JSON.parse(outputText);
if (generated.meta.date !== date) throw new Error(`报告日期不一致：${generated.meta.date} != ${date}`);

const reportDir = path.join('data', 'reports');
const publicDir = path.join('public', 'reports');
await mkdir(reportDir, { recursive: true });
await mkdir(publicDir, { recursive: true });
await writeFile(path.join(reportDir, `${date}.json`), `${JSON.stringify(generated.meta, null, 2)}\n`, 'utf8');
await writeFile(path.join(reportDir, `${date}.md`), `${generated.markdown.trim()}\n`, 'utf8');
await writeFile(path.join(publicDir, `${date}.json`), `${JSON.stringify(generated.meta, null, 2)}\n`, 'utf8');
await writeFile(path.join(publicDir, `${date}.md`), `${generated.markdown.trim()}\n`, 'utf8');
console.log(`Generated static report: ${date}`);

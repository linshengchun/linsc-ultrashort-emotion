import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_CACHE_ROOT, completeManifest, derivedPaths, fileExists, ftsharePaths, intradayPaths,
  jiuyangPaths, readJson, wencaiPaths,
} from './data-cache-paths.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const date = arg('--date', new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }));
const cacheRoot = arg('--cache-root', DEFAULT_CACHE_ROOT);
const rawPath = arg('--input', ftsharePaths(date, cacheRoot).data);
const provider = arg('--provider', process.env.LLM_PROVIDER ?? 'openai');
const allowIncomplete = args.includes('--allow-incomplete');
const reportDir = arg('--report-dir', path.join('data', 'reports'));
const publicDir = arg('--public-dir', path.join('public', 'reports'));

const raw = JSON.parse(await readFile(rawPath, 'utf8'));
const derived = derivedPaths(date, cacheRoot);
const derivedManifest = await completeManifest(derived.manifest, date, { requireFinal: true });
if (!derivedManifest || !(await fileExists(derived.data))) {
  throw new Error(`${date}缺少收盘终态确定性指标。请先运行 data:prepare -- --date ${date} --for-report。`);
}
const deterministicMetrics = await readJson(derived.data, null);
const shortTermEvidence = await readJson(intradayPaths(date, cacheRoot).data, null);
if ((!allowIncomplete && !deterministicMetrics?.history?.ma60Ready)
  || deterministicMetrics?.market?.fiveDays?.length !== 5
  || deterministicMetrics?.yesterdayFeedback?.fiveDays?.length !== 5) {
  throw new Error(`${date}的${allowIncomplete ? '近5日表' : '61日指标窗口或近5日表'}不完整，停止报告生成。`);
}

let narrativeCache = null;
try {
  narrativeCache = JSON.parse(await readFile(jiuyangPaths(date, cacheRoot).data, 'utf8'));
} catch {
  try {
    narrativeCache = JSON.parse(await readFile(path.join('data', 'narratives', date, 'normalized.json'), 'utf8'));
  } catch {
    narrativeCache = null;
  }
}

let objectiveFallback = null;
try {
  objectiveFallback = JSON.parse(await readFile(wencaiPaths(date, cacheRoot).data, 'utf8'));
} catch {
  try {
    objectiveFallback = JSON.parse(await readFile(path.join('data', 'fallbacks', `${date}-wencai-limit-up.json`), 'utf8'));
  } catch {
    objectiveFallback = null;
  }
}

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
const quoteTradeDates = allStockRows.map((row) => {
  const rawDate = String(pick(row, ['trade_date', 'date', 'tradeDate']) ?? '');
  if (/^\d{8}$/.test(rawDate)) return rawDate.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
  if (/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) return rawDate;
  const timestamp = num(pick(row, ['ts_millis', 'timestamp', 'time']));
  return timestamp === null ? null : new Date(timestamp).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}).filter(Boolean);
const quoteTradeDate = quoteTradeDates.length ? quoteTradeDates.sort().at(-1) : null;
const stockByCode = new Map(allStockRows.map((row) => [codeOf(row), row]));
const enrichName = (row) => ({ ...row, name: nameOf(row) || nameOf(stockByCode.get(codeOf(row))) });
const quoteFields = (row) => row ? {
  open: pick(row, ['open', 'open_price', '今开', '开盘价']),
  close: pick(row, ['close', 'price', 'last', '最新价', '收盘价']),
  prevClose: pick(row, ['prev_close', 'pre_close', '昨收', '昨收价']),
  changeRate: pick(row, ['change_rate', 'change_percent', 'change_pct', 'pct_chg', 'percent', '涨跌幅']),
  high: pick(row, ['high', '最高价']),
  low: pick(row, ['low', '最低价']),
  turnover: pick(row, ['turnover', '成交额']),
} : null;
const enrichWithQuote = (row) => ({ ...enrichName(row), quote: quoteFields(stockByCode.get(codeOf(row))) });
const quoteRows = quoteTradeDate === date ? allStockRows.filter(eligible) : [];
const limitRows = listFrom(raw.limitUp).map(enrichName).filter((row) => eligible(row) && String(pick(row, ['status']) ?? 'limit_up') === 'limit_up');
const downRows = listFrom(raw.limitDown)
  .map(enrichWithQuote)
  .filter((row) => eligible(row) && String(pick(row, ['status']) ?? 'limit_down') === 'limit_down');
const brokenRows = listFrom(raw.brokenLimit).map(enrichName).filter(eligible);
const yesterdayRows = listFrom(raw.yesterdayLimit)
  .map(enrichName)
  .filter((row) => eligible(row) && String(pick(row, ['status']) ?? 'limit_up') === 'limit_up');
const limitedCodes = new Set(limitRows.map(codeOf));
const painCandidates = downRows.map((row) => ({
  code: codeOf(row),
  name: nameOf(row),
  firstLimitDownTime: pick(row, ['limit_down_enter', 'last_limit_down_time']) ?? null,
  limitDownBreakCount: pick(row, ['limit_down_break_count']) ?? null,
  sealValue: pick(row, ['limit_down_seal_value']) ?? null,
  quote: row.quote,
}));

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
  bigLoss: rows.filter((row) => row.closePct !== null && row.closePct <= -5).length,
  bigLossRate: rate(rows.filter((row) => row.closePct !== null && row.closePct <= -5).length, rows.length),
  limitDown: rows.filter((row) => row.closePct !== null && row.closePct <= -9.5).length,
  pain: rows.some((row) => row.closePct !== null && row.closePct <= -9.5) ? '存在昨日涨停次日跌停' : rows.some((row) => row.closePct !== null && row.closePct <= -5) ? '存在收盘大面' : '低痛感',
});

const storedReportDir = reportDir;
let priorFeedback = [];
let priorReports = [];
try {
  const priorFiles = (await readdir(storedReportDir))
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name) && name.slice(0, 10) < date)
    .sort()
    .slice(-4);
  priorReports = await Promise.all(priorFiles.map(async (name) => ({
    name,
    stored: JSON.parse(await readFile(path.join(storedReportDir, name), 'utf8')),
  })));
  priorFeedback = priorReports.map(({ name, stored }) => {
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
  });
} catch {
  priorFeedback = [];
  priorReports = [];
}

const priorReportsContext = priorReports.map(({ name, stored }) => ({
  date: stored.date ?? name.slice(0, 10),
  conclusion: stored.conclusion ?? null,
  market: stored.market ? {
    turnoverYi: stored.market.turnoverYi ?? null,
    turnoverChangeYi: stored.market.turnoverChangeYi ?? null,
    indexSummary: stored.market.indexSummary ?? '',
    up: stored.market.up ?? null,
    down: stored.market.down ?? null,
    limitUp: stored.market.limitUp ?? null,
    limitDown: stored.market.limitDown ?? null,
    connected: stored.market.connected ?? null,
    highestBoard: stored.market.highestBoard ?? null,
  } : null,
  yesterdayFeedback: stored.yesterdayFeedback ? {
    sample: stored.yesterdayFeedback.sample ?? null,
    redOpenRate: stored.yesterdayFeedback.redOpenRate ?? null,
    averageOpen: stored.yesterdayFeedback.averageOpen ?? null,
    redCloseRate: stored.yesterdayFeedback.redCloseRate ?? null,
    averageClose: stored.yesterdayFeedback.averageClose ?? null,
    continuedLimitRate: stored.yesterdayFeedback.continuedLimitRate ?? null,
    reading: stored.yesterdayFeedback.reading ?? '',
  } : null,
  pain: stored.pain ? {
    level: stored.pain.level ?? '',
    score: stored.pain.score ?? null,
    summary: stored.pain.summary ?? '',
    spread: stored.pain.spread ?? '',
    stocks: stored.pain.stocks ?? [],
  } : null,
  themes: (stored.themes ?? []).map((theme) => ({
    name: theme.name,
    strength: theme.strength,
    stage: theme.stage,
    persistence: theme.persistence,
    coreStocks: theme.coreStocks,
  })),
  themeTimeline: stored.themeTimeline ?? [],
}));

const objective = {
  tradeDate: date,
  latestTradeDate: quoteTradeDate ?? normalizedLatestTradeDate ?? null,
  historicalMode: quoteTradeDate !== date,
  universe: raw.universe,
  marketSnapshot: deterministicMetrics?.market ?? null,
  breadth: {
    sample: deterministicMetrics?.market?.sample ?? quoteRows.length,
    up: deterministicMetrics?.market?.up ?? up,
    down: deterministicMetrics?.market?.down ?? down,
    flat: deterministicMetrics?.market?.flat ?? flat,
    limitUp: deterministicMetrics?.market?.limitUp ?? limitRows.length,
    limitDown: deterministicMetrics?.market?.limitDown ?? downRows.length,
    brokenLimit: deterministicMetrics?.market?.brokenLimit ?? brokenRows.length,
  },
  limitUp: limitRows,
  limitDown: downRows,
  brokenLimit: brokenRows,
  painCandidates,
  yesterdayFeedback: deterministicMetrics?.yesterdayFeedback?.rows ?? yesterdayFeedback,
  yesterdayFeedbackFiveDaySeed: deterministicMetrics?.yesterdayFeedback?.fiveDays ?? [...priorFeedback, feedbackSummary(date, yesterdayFeedback)],
  deterministicMetrics,
  shortTermEvidence,
  priorReportsContext,
  narrativeCache: narrativeCache ? {
    tradeDate: narrativeCache.tradeDate ?? date,
    priorityStocks: narrativeCache.priorityStocks ?? [],
    extractionStatus: narrativeCache.extractionStatus ?? 'unknown',
    eventCards: narrativeCache.eventCards ?? [],
    propagation: narrativeCache.propagation ?? [],
    currentPages: (narrativeCache.currentPages ?? []).map((page) => ({
      kind: page.kind,
      url: page.url,
      title: page.title,
      text: String(page.text ?? '').slice(0, 12000),
    })),
  } : null,
  objectiveFallback,
};

const string = { type: 'string' };
const numberOrNull = { type: ['number', 'null'] };
const integerOrNull = { type: ['integer', 'null'] };
const strings = { type: 'array', items: string };
const object = (properties) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const arrayOf = (items, limits = {}) => ({ type: 'array', items, ...limits });

const marketDaySchema = object({
  date: string, label: string, turnoverYi: numberOrNull, turnoverChangeYi: numberOrNull,
  turnoverChangePct: numberOrNull, up: integerOrNull, down: integerOrNull,
  limitUp: integerOrNull, limitDown: integerOrNull, connected: integerOrNull,
  highestBoard: integerOrNull, coreEarlyLimitDown: integerOrNull, coreBigLoss: integerOrNull,
  killScore: numberOrNull, pain: string, marketEnvironment: string, relayState: string, state: string,
});
const feedbackDaySchema = object({
  date: string, label: string, sample: integerOrNull, redOpen: integerOrNull,
  redOpenRate: numberOrNull, averageOpen: numberOrNull, redClose: integerOrNull,
  redCloseRate: numberOrNull, averageClose: numberOrNull, continuedLimit: integerOrNull,
  continuedLimitRate: numberOrNull, bigLoss: integerOrNull, bigLossRate: numberOrNull,
  limitDown: integerOrNull, pain: string,
});
const painStockSchema = object({
  name: string, role: string, auction: string, earlySession: string,
  close: string, damage: string, impact: string,
});
const themeSchema = object({
  name: string,
  strength: string,
  stage: string,
  messages: arrayOf(object({ source: string, content: string }), { minItems: 2 }),
  branches: strings,
  limitStocks: strings,
  logic: string,
  expectationSpace: string,
  persistence: string,
  coreStocks: arrayOf(object({ name: string, role: string, performance: string })),
});
const reportSchema = object({
  date: string,
  displayDate: string,
  generatedAt: string,
  title: string,
  conclusion: object({ cycle: string, substate: string, temperature: { type: 'integer' }, summary: string, evidence: strings }),
  market: object({
    turnoverYi: numberOrNull, turnoverPrevYi: numberOrNull, turnoverChangeYi: numberOrNull,
    turnoverChangePct: numberOrNull, turnoverMA60Yi: numberOrNull, turnoverVsMA60Yi: numberOrNull,
    turnoverVsMA60Pct: numberOrNull, indexSummary: string,
    up: integerOrNull, down: integerOrNull, limitUp: integerOrNull, limitDown: integerOrNull,
    connected: integerOrNull, highestBoard: integerOrNull,
    fiveDays: arrayOf(marketDaySchema, { minItems: 5, maxItems: 5 }),
  }),
  pain: object({ level: string, score: numberOrNull, summary: string, stocks: arrayOf(painStockSchema), spread: string }),
  yesterdayFeedback: object({
    sample: integerOrNull, redOpen: integerOrNull, redOpenRate: numberOrNull,
    averageOpen: numberOrNull, redClose: integerOrNull, redCloseRate: numberOrNull,
    averageClose: numberOrNull, continuedLimit: integerOrNull, continuedLimitRate: numberOrNull,
    reading: string,
    fiveDays: arrayOf(feedbackDaySchema, { minItems: 5, maxItems: 5 }),
  }),
  ladder: arrayOf(object({ board: { type: 'integer' }, stocks: strings })),
  anchors: arrayOf(object({ name: string, board: string, role: string, influence: string })),
  themes: arrayOf(themeSchema, { minItems: 3, maxItems: 5 }),
  themeTimeline: arrayOf(object({
    theme: string,
    days: arrayOf(object({ date: string, performance: string, leaders: strings })),
  }), { minItems: 3, maxItems: 5 }),
  effects: object({
    relayDifficulty: string,
    profit: strings,
    loss: strings,
    styles: arrayOf(object({ style: string, result: string, reading: string })),
  }),
  cycle: object({ main: string, substate: string, signals: strings, risk: string }),
  oneToTwo: arrayOf(object({
    rank: string, name: string, firstLimitTime: string, seal: string, theme: string,
    speculationLogic: string, forecast: string,
  }), { maxItems: 3 }),
  sources: object({ objective: strings, themes: strings, narratives: strings, note: string }),
});
const schema = object({ meta: reportSchema, markdown: string });

const instructions = `你是LINSC的A股超短情绪复盘分析员。用户只做多，持股2—3日。请基于客观行情输入并使用网页搜索补充${date}及此前4个交易日的同花顺问财题材、韭研公社小作文和公开市场叙事。deterministicMetrics是程序从收盘终态缓存计算出的唯一数值口径：成交额、前日对比、60日均值、近5日行情、连板高度和昨日涨停反馈均必须逐字段照用，不得自行重算、补猜或被网页数字覆盖。若history.ma60Ready=false，表示61日任务暂未补齐；60日均值及其增减额、增幅只能写null/“—”，严禁用5日或不足60日数据替代。shortTermEvidence是竞价与9:25—10:00证据边界：只可陈述其中实际存在的auctionPct、涨跌停事件时间和早盘成交占比；其capabilities标记不支持的历史分钟价格路径必须写“—”，不得用日线最低价推断发生时刻。生成前必须先阅读客观输入中的objectiveFallback：若存在，代表FTShare字段缺失或截断后的同花顺问财逐字段回退结果；仅用于对应缺失字段及口径核对，不得覆盖FTShare已经完整可靠的字段，并在数据来源说明中写清实际使用关系。生成前还必须阅读客观输入中的narrativeCache：优先使用其中的原始页面文本、priorityStocks、eventCards和propagation；若eventCards为空，只能从currentPages原文提取可确认的事件，不得把泛化行业词补写成具体异动。还必须阅读priorReportsContext：前几日报告用于提供周期判断、题材阶段和核心股的连续性上下文，但只是待验证判断；${date}重新获取的客观数据优先，不能为了延续旧结论而忽略当天反证。第二节只保留一张全市场近5日表，并在表后集中写“前日判断验证”和“情绪连续性判断”，明确最近几日路径属于延续、加强、分歧、修复、弱修复、转弱或反转；不要另建情绪连续性表。第二节当日成交额说明必须同时写当日、前一交易日和前60个完整交易日均值的增减额及百分比；客观输入没有可靠值时对应meta写null、Markdown写“—”，不得用5日均值或相邻日期倒填，近5日表不得增加60日均值列。第三节只分析昨日涨停样本的接力反馈及近5日变化，作为第二节周期定位的证据，不再重复周期结论。整个任务最多进行12轮有针对性的网页搜索，不做无边界扩展；只分析当日强度和持续性最重要的3—5个题材，并最多保留3只次日1进2候选。题材消息不与公告核验，必须称为“市场叙事”或“小作文”，评价传播强度、预期差、想象空间与价格反馈。股票池排除名称含ST或*ST、北交所，保留主板、创业板和科创板；当日上涨、下跌、涨停、跌停和炸板数量必须使用客观输入中的breadth字段，不得改用未过滤的网页全市场统计。昨日涨停反馈只保留一张GFM近5日综合表，逐日同时展示样本数、红开数、红开率、平均开盘、收红数、收红率、平均收盘、晋级涨停数和晋级率，不再另写当日明细表或第二张对比表。题材部分必须按题材一次性写清市场触发／消息面、扩散路径、涨停映射、逻辑面、预期与想象空间、持续情况和核心个股；消息面每个题材写2—4条带来源的市场叙事，优先同时覆盖同花顺问财与韭研公社，不得杜撰，不得拆成两个重复模块。近期题材持续情况必须结合priorReportsContext逐日验证，列出发酵表现和当日领涨核心票，没有可靠核心票时写“—”。不要出现数据完整性章节，不要出现异动或绕异动模块，不要写泛化的次日操作建议。第九节的一进二候选先由客观涨停时间、封板力度、题材地位和股性筛选，但“炒作逻辑”必须逐只搜索韭研公社，不得由题材名称或封板表现反推。每只候选的炒作逻辑固定分成两个自然段：第一段以“异动解析：”开头，归纳对应交易日韭研公社个股异动解析；第二段以“帖子吹票逻辑：”开头，结合韭研公社板块文章和其他帖子，写清事件催化、资金传播路径、个股映射、市场小作文、预期差及已经定价的程度。若找不到对应的个股异动解析，不要标注缺失，第一段直接归纳板块文章和其他帖子中可确认的个股映射；不得用其他网站替代，也不要在报告正文展示文章标题、链接或发布时间。若韭研公社的异动解析、板块文章和其他帖子都没有有效线索，则不把该标的列入候选，不得补猜。接力预判必须说明相关逻辑是否已被充分定价，并与竞价、同题材助攻及核心反馈结合。未知精确值在meta中写null、Markdown中写“—”，不得编造。Markdown必须使用标准标题、列表、引用和GFM表格。`;
const markdownRules = '题材分析中的合并标签固定写为“- **预期与想象空间：**”；一进二模块及其后的数据来源说明不得出现“未取得”三个字；第二节和第三节的近5日对比表必须按交易日期倒序排列，最新交易日在第一行、最早交易日在最后一行，禁止按正序输出；第二节近5日表不得增加60日均值列，但必须保留底稿既定的高位核心早盘跌停、核心收盘大面、杀伤分、情绪痛感、大盘环境和超短接力字段；当日成交额说明必须写前一交易日和近60日均值的增减额及百分比，取不到时写“—”；第二节必须单独写“情绪痛感与杀伤清单”，逐只说明核心负反馈个股的前一日角色、竞价或9:25—10:00表现、收盘表现、是否跌停或大面以及对接力的影响，客观输入没有可靠值时写“—”；第三节近5日表必须包含收盘大面数/率、跌停数和接力痛感，收盘大面按收盘跌幅≤-5%计算；近期题材持续情况必须同时覆盖当日强题材和仍影响接力的前期主线或退潮题材，并逐日列出当日领涨核心票，没有可靠核心票写“—”。';
const finalInstructions = `${instructions}\n${markdownRules}`;
const input = `生成${date}《LINSC超短情绪复盘》。Markdown必须按顺序完整包含以下9个正式模块和最后的数据来源说明：\n## 一、当日结论\n## 二、大盘基础行情、近5日与周期定位\n## 三、昨日涨停股次日反馈与近5日对比\n## 四、连板梯队与接力结构\n## 五、高标、情绪锚与题材影响\n## 六、涨停题材事件树与结构分析\n## 七、近期题材持续情况\n## 八、赚钱效应、亏钱效应与接力难度\n## 九、次日1进2预期标的\n## 数据来源与使用边界\n\n客观输入：\n${JSON.stringify(objective)}`;

const parseGenerated = (text) => JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
const reportDateKey = (value) => String(value ?? '').replace(/\D/g, '').slice(-4);

const validateGenerated = (generated) => {
  const errors = [];
  if (generated?.meta?.date !== date) errors.push(`报告日期不一致：${generated?.meta?.date ?? '—'} != ${date}`);
  if (generated?.meta?.market?.fiveDays?.length !== 5) errors.push('大盘近5日数据必须恰好5条');
  if (generated?.meta?.yesterdayFeedback?.fiveDays?.length !== 5) errors.push('昨日涨停反馈近5日数据必须恰好5条');
  const expectedMarketDates = deterministicMetrics.market.fiveDays.map((day) => reportDateKey(day.date));
  const actualMarketDates = (generated?.meta?.market?.fiveDays ?? []).map((day) => reportDateKey(day.date));
  if (JSON.stringify(actualMarketDates) !== JSON.stringify(expectedMarketDates)) errors.push('大盘近5日日期或倒序顺序不一致');
  const expectedFeedbackDates = deterministicMetrics.yesterdayFeedback.fiveDays.map((day) => reportDateKey(day.date));
  const actualFeedbackDates = (generated?.meta?.yesterdayFeedback?.fiveDays ?? []).map((day) => reportDateKey(day.date));
  if (JSON.stringify(actualFeedbackDates) !== JSON.stringify(expectedFeedbackDates)) errors.push('昨日涨停反馈近5日日期或倒序顺序不一致');
  if (!generated?.meta?.pain?.level || !generated?.meta?.pain?.summary || !Array.isArray(generated?.meta?.pain?.stocks)) errors.push('必须输出情绪痛感与杀伤清单');
  const headings = [
    '## 一、当日结论',
    '## 二、大盘基础行情、近5日与周期定位',
    '## 三、昨日涨停股次日反馈与近5日对比',
    '## 四、连板梯队与接力结构',
    '## 五、高标、情绪锚与题材影响',
    '## 六、涨停题材事件树与结构分析',
    '## 七、近期题材持续情况',
    '## 八、赚钱效应、亏钱效应与接力难度',
    '## 九、次日1进2预期标的',
  ];
  for (const heading of headings) if (!generated?.markdown?.includes(heading)) errors.push(`Markdown缺少“${heading}”`);
  if (!generated?.markdown?.includes('情绪痛感与杀伤清单')) errors.push('Markdown缺少“情绪痛感与杀伤清单”');
  if (!generated?.markdown?.includes('收盘大面数/率') && !generated?.markdown?.includes('收盘大面')) errors.push('Markdown缺少昨日涨停样本收盘大面指标');
  for (const column of ['高位核心早盘跌停', '核心收盘大面', '杀伤分', '情绪痛感', '大盘环境', '超短接力']) {
    if (!generated?.markdown?.includes(column)) errors.push(`Markdown近5日大盘表缺少“${column}”字段`);
  }
  if (errors.length) throw new Error(`报告结构校验失败：${errors.join('；')}`);
};

const applyDeterministicMetrics = (generated) => {
  const market = deterministicMetrics.market;
  Object.assign(generated.meta.market, {
    turnoverYi: market.turnoverYi,
    turnoverPrevYi: market.turnoverPrevYi,
    turnoverChangeYi: market.turnoverChangeYi,
    turnoverChangePct: market.turnoverChangePct,
    turnoverMA60Yi: market.turnoverMA60Yi,
    turnoverVsMA60Yi: market.turnoverVsMA60Yi,
    turnoverVsMA60Pct: market.turnoverVsMA60Pct,
    up: market.up,
    down: market.down,
    limitUp: market.limitUp,
    limitDown: market.limitDown,
    connected: market.connected,
    highestBoard: market.highestBoard,
  });
  for (const day of generated.meta.market.fiveDays) {
    const source = market.fiveDays.find((item) => reportDateKey(item.date) === reportDateKey(day.date));
    if (!source) continue;
    Object.assign(day, {
      turnoverYi: source.turnoverYi, turnoverChangeYi: source.turnoverChangeYi,
      turnoverChangePct: source.turnoverChangePct, up: source.up, down: source.down,
      limitUp: source.limitUp, limitDown: source.limitDown,
      connected: source.connected, highestBoard: source.highestBoard,
    });
  }
  const feedback = deterministicMetrics.yesterdayFeedback;
  Object.assign(generated.meta.yesterdayFeedback, {
    sample: feedback.sample, redOpen: feedback.redOpen, redOpenRate: feedback.redOpenRate,
    averageOpen: feedback.averageOpenPct, redClose: feedback.redClose, redCloseRate: feedback.redCloseRate,
    averageClose: feedback.averageClosePct, continuedLimit: feedback.continuedLimit,
    continuedLimitRate: feedback.continuedLimitRate,
  });
  for (const day of generated.meta.yesterdayFeedback.fiveDays) {
    const source = feedback.fiveDays.find((item) => reportDateKey(item.date) === reportDateKey(day.date));
    if (!source) continue;
    Object.assign(day, {
      sample: source.sample, redOpen: source.redOpen, redOpenRate: source.redOpenRate,
      averageOpen: source.averageOpenPct, redClose: source.redClose, redCloseRate: source.redCloseRate,
      averageClose: source.averageClosePct, continuedLimit: source.continuedLimit,
      continuedLimitRate: source.continuedLimitRate, bigLoss: source.bigLoss,
      bigLossRate: source.bigLossRate, limitDown: source.limitDown,
    });
  }
};

async function generateWithOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('缺少 OPENAI_API_KEY。请在服务端环境变量或 GitHub Actions Secrets 中配置。');
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL ?? 'gpt-5.4',
      store: false,
      reasoning: { effort: 'high' },
      tools: [{ type: 'web_search' }],
      max_tool_calls: 20,
      instructions: finalInstructions,
      input,
      text: { format: { type: 'json_schema', name: 'linsc_report', strict: true, schema } },
    }),
  });
  if (!response.ok) throw new Error(`OpenAI生成失败：HTTP ${response.status} ${await response.text()}`);
  const payload = await response.json();
  const outputText = payload.output_text ?? payload.output?.flatMap((item) => item.content ?? []).find((item) => item.type === 'output_text')?.text;
  if (!outputText) throw new Error(`OpenAI未返回报告文本：${JSON.stringify(payload.error ?? payload.incomplete_details ?? {})}`);
  return parseGenerated(outputText);
}

async function generateWithCodex() {
  const workDir = path.join('work', 'codex', `${date}-${Date.now()}`);
  const schemaPath = path.resolve(workDir, 'report-output.schema.json');
  const outputPath = path.resolve(workDir, 'report-output.json');
  await mkdir(workDir, { recursive: true });
  await writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');

  const codexCli = arg('--codex-cli', process.env.CODEX_CLI ?? (process.platform === 'win32' ? 'codex.exe' : 'codex'));
  const codexReasoning = arg('--codex-reasoning', process.env.CODEX_REASONING_EFFORT ?? 'high');
  const codexArgs = [
    'exec',
    '--ephemeral',
    '--sandbox', 'read-only',
    '--cd', process.cwd(),
    '--output-schema', schemaPath,
    '--output-last-message', outputPath,
    '--config', `model_reasoning_effort="${codexReasoning}"`,
  ];
  if (process.env.CODEX_MODEL) codexArgs.push('--model', process.env.CODEX_MODEL);
  codexArgs.push('-');

  const prompt = `${finalInstructions}\n\n${input}\n\n只返回符合输出Schema的JSON对象，不要修改项目文件。`;
  await new Promise((resolve, reject) => {
    let logs = '';
    const codexEnv = { ...process.env, PYTHONIOENCODING: 'utf-8' };
    if (process.platform === 'win32' && !codexEnv.HOME && codexEnv.USERPROFILE) codexEnv.HOME = codexEnv.USERPROFILE;
    if (process.platform === 'win32' && !codexEnv.CODEX_HOME && codexEnv.USERPROFILE) codexEnv.CODEX_HOME = path.join(codexEnv.USERPROFILE, '.codex');
    const child = spawn(codexCli, codexArgs, {
      cwd: process.cwd(),
      env: codexEnv,
      shell: process.platform === 'win32' && !codexCli.toLowerCase().endsWith('.exe'),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const collect = (chunk) => {
      logs = `${logs}${chunk.toString('utf8')}`.slice(-32_000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      } else {
        child.kill();
      }
      reject(new Error('Codex生成超时（25分钟）'));
    }, 25 * 60 * 1000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`无法启动Codex：${error.message}`));
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Codex生成失败，退出码 ${code}\n${logs.trim()}`));
    });
    child.stdin.end(prompt, 'utf8');
  });

  return parseGenerated(await readFile(outputPath, 'utf8'));
}

if (!['openai', 'codex'].includes(provider)) throw new Error(`暂不支持的模型供应方式：${provider}`);
const generated = provider === 'codex' ? await generateWithCodex() : await generateWithOpenAI();
applyDeterministicMetrics(generated);
validateGenerated(generated);

await mkdir(reportDir, { recursive: true });
await mkdir(publicDir, { recursive: true });
await writeFile(path.join(reportDir, `${date}.json`), `${JSON.stringify(generated.meta, null, 2)}\n`, 'utf8');
await writeFile(path.join(reportDir, `${date}.md`), `${generated.markdown.trim()}\n`, 'utf8');
await writeFile(path.join(publicDir, `${date}.json`), `${JSON.stringify(generated.meta, null, 2)}\n`, 'utf8');
await writeFile(path.join(publicDir, `${date}.md`), `${generated.markdown.trim()}\n`, 'utf8');
console.log(`Generated static report: ${date}`);

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_CACHE_ROOT, assertTradeDate, completeManifest, derivedPaths, fileExists,
  ftsharePaths, readJson, wencaiPaths, writeJsonAtomic,
} from './data-cache-paths.mjs';
import { createFtshareClient } from './ftshare-mcp-client.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const flag = (name) => args.includes(name);
const date = assertTradeDate(arg('--date', new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })));
const cacheRoot = arg('--cache-root', DEFAULT_CACHE_ROOT);
const output = derivedPaths(date, cacheRoot);
const forReport = flag('--for-report');

const listFrom = (payload) => {
  if (Array.isArray(payload)) return payload.flatMap(listFrom);
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['records', 'data', 'items', 'list', 'results', 'rows']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
};
const number = (value) => {
  const parsed = Number(String(value ?? '').replaceAll(',', '').replace('%', ''));
  return Number.isFinite(parsed) ? parsed : null;
};
const round = (value, digits = 2) => value === null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));
const pctValue = (value) => {
  const parsed = number(value);
  return parsed === null ? null : Math.abs(parsed) <= 1 ? parsed * 100 : parsed;
};
const codeOf = (row) => String(row?.symbol ?? row?.code ?? row?.ticker ?? '').replace(/\.(SH|SZ|XSHG|XSHE)$/i, '').match(/\d{6}/)?.[0] ?? '';
const eligible = (row) => {
  const code = codeOf(row);
  const name = String(row?.name ?? row?.stock_name ?? '').toUpperCase();
  return code && !/^(4|8|92)/.test(code) && !row?.st && !name.includes('ST') && row?.board !== 'bj';
};
const finalLimitRows = (raw, byCode) => listFrom(raw?.limitUp).filter((row) => byCode.has(codeOf(row)) && String(row?.status ?? 'limit_up') === 'limit_up');
const finalDownRows = (raw, byCode) => listFrom(raw?.limitDown).filter((row) => byCode.has(codeOf(row)) && String(row?.status ?? 'limit_down') === 'limit_down');
const brokenRows = (raw, byCode) => listFrom(raw?.brokenLimit).filter((row) => byCode.has(codeOf(row)));
const rate = (count, sample) => sample ? round(count / sample * 100) : null;
const average = (values) => {
  const valid = values.filter((value) => value !== null);
  return valid.length ? round(valid.reduce((sum, value) => sum + value, 0) / valid.length) : null;
};
const median = (values) => {
  const valid = values.filter((value) => value !== null).sort((a, b) => a - b);
  if (!valid.length) return null;
  const middle = Math.floor(valid.length / 2);
  return round(valid.length % 2 ? valid[middle] : (valid[middle - 1] + valid[middle]) / 2);
};

const root = path.join(cacheRoot, 'ftshare');
let candidates = [];
try {
  candidates = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name) && entry.name <= date)
    .map((entry) => entry.name).sort();
} catch {}
const dates = candidates.slice(-61);
const days = [];
for (const tradeDate of dates) {
  const paths = ftsharePaths(tradeDate, cacheRoot);
  const manifest = await completeManifest(paths.manifest, tradeDate, { requireFinal: forReport || tradeDate < date });
  if (!manifest || !(await fileExists(paths.data))) continue;
  const raw = await readJson(paths.data, null);
  if (!raw) continue;
  const quotes = listFrom(raw.stocks).filter(eligible);
  const byCode = new Map(quotes.map((row) => [codeOf(row), row]));
  const limits = finalLimitRows(raw, byCode);
  const downs = finalDownRows(raw, byCode);
  const broken = brokenRows(raw, byCode);
  let up = 0; let down = 0; let flat = 0;
  for (const row of quotes) {
    const pct = pctValue(row.change_rate ?? row.change_percent ?? row.pct_chg);
    if (pct === null || pct === 0) flat += 1;
    else if (pct > 0) up += 1;
    else down += 1;
  }
  const turnoverYuan = quotes.reduce((sum, row) => sum + (number(row.turnover) ?? 0), 0);
  days.push({ tradeDate, manifest, raw, quotes, byCode, limits, downs, broken, sample: quotes.length, up, down, flat, turnoverYuan });
}
if (!days.length || days.at(-1).tradeDate !== date) throw new Error(`${date}的FTShare终态缓存不可用。`);

const streaks = new Map();
let previousTradeDate = null;
for (const day of days) {
  const expectedPrior = String(day.raw?.priorTradeDate ?? day.manifest?.priorTradeDate ?? previousTradeDate ?? '').replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
  if (previousTradeDate !== null && expectedPrior !== previousTradeDate) streaks.clear();
  const today = new Set(day.limits.map(codeOf));
  const next = new Map();
  for (const code of today) next.set(code, (streaks.get(code) ?? 0) + 1);
  day.streaks = next;
  day.connected = [...next.values()].filter((value) => value >= 2).length;
  day.highestBoard = Math.max(0, ...next.values());
  streaks.clear();
  for (const [code, value] of next) streaks.set(code, value);
  previousTradeDate = day.tradeDate;
}

function feedbackFor(day) {
  const priorLimits = listFrom(day.raw?.yesterdayLimit).filter((row) => day.byCode.has(codeOf(row)) && String(row?.status ?? 'limit_up') === 'limit_up');
  const todayLimits = new Set(day.limits.map(codeOf));
  const todayDowns = new Set(day.downs.map(codeOf));
  const rows = priorLimits.map((prior) => {
    const code = codeOf(prior);
    const quote = day.byCode.get(code);
    const prev = number(quote?.prev_close);
    const open = number(quote?.open);
    const close = number(quote?.close);
    const openPct = prev && open !== null ? round((open - prev) / prev * 100) : null;
    const closePct = prev && close !== null ? round((close - prev) / prev * 100) : null;
    return {
      code,
      name: quote?.name ?? prior?.name ?? '',
      openPct,
      closePct,
      openToClosePct: open && close !== null ? round((close - open) / open * 100) : null,
      continuedLimit: todayLimits.has(code),
      limitDown: todayDowns.has(code),
    };
  });
  const redOpen = rows.filter((row) => row.openPct !== null && row.openPct > 0).length;
  const redClose = rows.filter((row) => row.closePct !== null && row.closePct > 0).length;
  const continued = rows.filter((row) => row.continuedLimit).length;
  const bigLoss = rows.filter((row) => row.closePct !== null && row.closePct <= -5).length;
  const limitDown = rows.filter((row) => row.limitDown).length;
  return {
    date: day.tradeDate,
    sample: rows.length,
    redOpen, redOpenRate: rate(redOpen, rows.length), averageOpenPct: average(rows.map((row) => row.openPct)), medianOpenPct: median(rows.map((row) => row.openPct)),
    redClose, redCloseRate: rate(redClose, rows.length), averageClosePct: average(rows.map((row) => row.closePct)), medianClosePct: median(rows.map((row) => row.closePct)),
    continuedLimit: continued, continuedLimitRate: rate(continued, rows.length),
    bigLoss, bigLossRate: rate(bigLoss, rows.length), limitDown,
    rows,
  };
}
for (const day of days) day.feedback = feedbackFor(day);

const target = days.at(-1);
const prior = days.at(-2) ?? null;
const ma60Days = days.slice(-61, -1);
const historyContinuous = days.length === 61 && days.slice(1).every((day, index) => {
  const expectedPrior = String(day.raw?.priorTradeDate ?? day.manifest?.priorTradeDate ?? days[index].tradeDate).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
  return expectedPrior === days[index].tradeDate;
});
const ma60Ready = ma60Days.length === 60 && historyContinuous;
const ma60Yuan = ma60Ready ? ma60Days.reduce((sum, day) => sum + day.turnoverYuan, 0) / 60 : null;
const marketFiveDays = days.slice(-5).reverse().map((day) => {
  const dayIndex = days.indexOf(day);
  const previousDay = dayIndex > 0 ? days[dayIndex - 1] : null;
  return {
    date: day.tradeDate,
    turnoverYi: round(day.turnoverYuan / 100_000_000),
    turnoverChangeYi: previousDay ? round((day.turnoverYuan - previousDay.turnoverYuan) / 100_000_000) : null,
    turnoverChangePct: previousDay?.turnoverYuan ? round((day.turnoverYuan - previousDay.turnoverYuan) / previousDay.turnoverYuan * 100) : null,
    up: day.up, down: day.down, flat: day.flat,
    limitUp: day.limits.length, limitDown: day.downs.length, brokenLimit: day.broken.length,
    connected: day.connected, highestBoard: day.highestBoard,
  };
});
const feedbackFiveDays = days.slice(-5).reverse().map((day) => ({ ...day.feedback, rows: undefined }));

let indexMarket = [];
try {
  const client = await createFtshareClient();
  const sinceDate = new Date(`${date}T00:00:00+08:00`);
  sinceDate.setDate(sinceDate.getDate() - 14);
  const since = sinceDate.getTime();
  const until = Date.parse(`${date}T23:59:59+08:00`);
  const indexDefinitions = [
    ['000001.SH', '上证指数'], ['399001.SZ', '深证成指'], ['399006.SZ', '创业板指'], ['000688.SH', '科创50'],
  ];
  for (const [symbol, name] of indexDefinitions) {
    const payload = await client.call('ft_v1_index_candlesticks', { symbol, interval_unit: 'Day', since_ts_millis: since, until_ts_millis: until, limit: 20 });
    const bars = listFrom(payload).sort((left, right) => Number(left.ts_millis) - Number(right.ts_millis));
    const barIndex = bars.findIndex((bar) => new Date(Number(bar.ts_millis)).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }) === date);
    const bar = bars[barIndex];
    const previousBar = barIndex > 0 ? bars[barIndex - 1] : null;
    const close = number(bar?.close);
    const previousClose = number(previousBar?.close);
    indexMarket.push({ symbol, name, close, changePct: close !== null && previousClose ? round((close - previousClose) / previousClose * 100) : null });
  }
} catch (error) {
  indexMarket = [{ status: 'unavailable', reason: error instanceof Error ? error.message : String(error) }];
}

const wencai = await readJson(wencaiPaths(date, cacheRoot).data, null);
const wencaiCodes = new Set(listFrom(wencai).filter(eligible).map(codeOf));
const ftCodes = new Set(target.limits.map(codeOf));
const onlyFtshare = [...ftCodes].filter((code) => !wencaiCodes.has(code));
const onlyWencai = [...wencaiCodes].filter((code) => !ftCodes.has(code));

const metrics = {
  schemaVersion: '1.0',
  formulaVersion: 'linsc-derived-v1',
  tradeDate: date,
  generatedAt: new Date().toISOString(),
  universe: target.raw.universe,
  history: { requiredTradingDays: 61, availableTradingDays: days.length, firstDate: days[0].tradeDate, lastDate: target.tradeDate, continuous: historyContinuous, ma60Ready },
  market: {
    sample: target.sample,
    turnoverYi: round(target.turnoverYuan / 100_000_000),
    turnoverPrevYi: prior ? round(prior.turnoverYuan / 100_000_000) : null,
    turnoverChangeYi: prior ? round((target.turnoverYuan - prior.turnoverYuan) / 100_000_000) : null,
    turnoverChangePct: prior?.turnoverYuan ? round((target.turnoverYuan - prior.turnoverYuan) / prior.turnoverYuan * 100) : null,
    turnoverMA60Yi: ma60Yuan === null ? null : round(ma60Yuan / 100_000_000),
    turnoverVsMA60Yi: ma60Yuan === null ? null : round((target.turnoverYuan - ma60Yuan) / 100_000_000),
    turnoverVsMA60Pct: ma60Yuan ? round((target.turnoverYuan - ma60Yuan) / ma60Yuan * 100) : null,
    up: target.up, down: target.down, flat: target.flat,
    limitUp: target.limits.length, limitDown: target.downs.length, brokenLimit: target.broken.length,
    connected: target.connected, highestBoard: target.highestBoard,
    indexes: indexMarket,
    fiveDays: marketFiveDays,
  },
  yesterdayFeedback: { ...target.feedback, fiveDays: feedbackFiveDays },
  limitStructure: {
    streaks: [...target.streaks].map(([code, board]) => ({ code, board })).sort((left, right) => right.board - left.board || left.code.localeCompare(right.code)),
  },
  reconciliation: {
    ftshareLimitUp: ftCodes.size,
    wencaiLimitUp: wencaiCodes.size || null,
    onlyFtshare,
    onlyWencai,
    status: !wencai ? 'wencai-missing' : onlyFtshare.length || onlyWencai.length ? 'difference' : 'matched',
  },
};
await writeJsonAtomic(output.data, metrics);
await writeJsonAtomic(output.manifest, {
  schemaVersion: '1.0', formulaVersion: metrics.formulaVersion, tradeDate: date, status: 'complete', marketPhase: target.manifest.marketPhase,
  finalizedAt: target.manifest.finalizedAt ?? null, generatedAt: metrics.generatedAt,
  historyDays: days.length, ma60Ready: metrics.history.ma60Ready,
});
console.log(`[确定性指标完成] ${date}：历史${days.length}/61日；MA60=${metrics.history.ma60Ready ? '可用' : '缺失'}；近5日=${marketFiveDays.length}日。`);

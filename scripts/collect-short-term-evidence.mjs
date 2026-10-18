import path from 'node:path';
import {
  DEFAULT_CACHE_ROOT, assertTradeDate, cacheMarketPhase, ftsharePaths, intradayPaths, readJson, writeJsonAtomic,
} from './data-cache-paths.mjs';
import { createFtshareClient } from './ftshare-mcp-client.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const date = assertTradeDate(arg('--date', new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })));
const cacheRoot = arg('--cache-root', DEFAULT_CACHE_ROOT);
const output = intradayPaths(date, cacheRoot);
const apiKey = process.env.HITHINK_FINANCE_API_KEY?.trim()
  ?? process.env.FUYAO_API_KEY?.trim()
  ?? process.env.FUYAO_TOKEN?.trim()
  ?? process.env.IWENCAI_API_KEY?.trim();
const apiBase = process.env.HITHINK_FINANCE_API_BASE_URL ?? 'https://fuyao.aicubes.cn';
const compactDate = date.replaceAll('-', '');
const marketPhase = cacheMarketPhase(date);
if (marketPhase === 'future') throw new Error(`不能采集未来交易日：${date}`);

const listFrom = (payload) => {
  if (Array.isArray(payload)) return payload.flatMap(listFrom);
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['records', 'data', 'items', 'item', 'list', 'results', 'rows']) if (Array.isArray(payload[key])) return payload[key];
  return [];
};
const number = (value) => {
  const parsed = Number(String(value ?? '').replaceAll(',', '').replace('%', ''));
  return Number.isFinite(parsed) ? parsed : null;
};
const round = (value, digits = 2) => value === null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));
const codeOf = (row) => String(row?.symbol ?? row?.code ?? row?.ticker ?? row?.thscode ?? '').match(/\d{6}/)?.[0] ?? '';
const symbolOf = (row) => {
  const raw = String(row?.symbol ?? row?.thscode ?? '');
  if (/^\d{6}\.(SH|SZ)$/i.test(raw)) return raw.toUpperCase();
  const code = codeOf(row);
  return code ? `${code}.${code.startsWith('6') || code.startsWith('68') ? 'SH' : 'SZ'}` : '';
};
const pct = (value) => {
  const parsed = number(value);
  return parsed === null ? null : Math.abs(parsed) <= 1 ? parsed * 100 : parsed;
};

async function apiGet(endpoint, params = {}) {
  if (!apiKey) throw new Error('缺少HITHINK_FINANCE_API_KEY');
  const url = new URL(endpoint, apiBase);
  for (const [name, value] of Object.entries(params)) if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { 'X-api-key': apiKey, accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  if (Number(payload.code) !== 0) throw new Error(`${payload.code}: ${payload.message ?? '调用失败'}`);
  return payload;
}

const raw = await readJson(ftsharePaths(date, cacheRoot).data, null);
if (!raw) throw new Error(`${date}缺少FTShare客观缓存。`);
const quotes = listFrom(raw.stocks);
const quoteByCode = new Map(quotes.map((row) => [codeOf(row), row]));
const limitDownByCode = new Map(listFrom(raw.limitDown).map((row) => [codeOf(row), row]));
const currentLimitByCode = new Map(listFrom(raw.limitUp).map((row) => [codeOf(row), row]));
const yesterdayLimits = listFrom(raw.yesterdayLimit);

let benchmark = [];
let benchmarkError = null;
try {
  const response = await apiGet('/api/a-share/auction/short-term-benchmark', { date });
  benchmark = response.data?.item ?? [];
  await writeJsonAtomic(path.join(output.raw, 'hithink-short-term-benchmark.json'), response);
} catch (error) {
  benchmarkError = error instanceof Error ? error.message : String(error);
}
const benchmarkByCode = new Map(benchmark.map((row) => [codeOf(row), row]));

const priorities = new Map();
const add = (row, reason) => {
  const code = codeOf(row);
  if (!code || /^(4|8|92)/.test(code)) return;
  const quote = quoteByCode.get(code);
  if (!quote || quote.st || String(quote.name ?? '').toUpperCase().includes('ST') || quote.board === 'bj') return;
  const entry = priorities.get(code) ?? { code, symbol: symbolOf(quote ?? row), name: quote?.name ?? row?.name ?? '', reasons: [] };
  if (!entry.reasons.includes(reason)) entry.reasons.push(reason);
  priorities.set(code, entry);
};
for (const row of benchmark) add(row, '同花顺短线风向标');
for (const row of yesterdayLimits) {
  const quote = quoteByCode.get(codeOf(row));
  const closePct = pct(quote?.change_rate);
  if (closePct !== null && closePct <= -5) add(row, '昨日涨停次日收盘大面');
  if (limitDownByCode.has(codeOf(row))) add(row, '昨日涨停次日跌停');
}
for (const row of listFrom(raw.limitDown)) add(row, '当日跌停');
for (const row of listFrom(raw.limitUp)) if ((currentLimitByCode.get(codeOf(row))?.limit_up_enter?.[0] ?? '') <= '10:00:00') add(row, '早盘涨停锚');

const selected = [...priorities.values()].slice(0, 40);
const snapshot = [];
let snapshotError = null;
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
if (date === today && selected.length) {
  try {
    for (let offset = 0; offset < selected.length; offset += 100) {
      const codes = selected.slice(offset, offset + 100).map((row) => row.symbol).join(',');
      const response = await apiGet('/api/a-share/auction/snapshot', { thscodes: codes, stage: 'final' });
      snapshot.push(...(response.data?.item ?? []));
      await writeJsonAtomic(path.join(output.raw, `hithink-auction-snapshot-${offset / 100 + 1}.json`), response);
    }
  } catch (error) {
    snapshotError = error instanceof Error ? error.message : String(error);
  }
}
const snapshotByCode = new Map(snapshot.map((row) => [codeOf(row), row]));

let ftshareClient = null;
let ftshareError = null;
try { ftshareClient = await createFtshareClient(); } catch (error) { ftshareError = error instanceof Error ? error.message : String(error); }
const stocks = [];
for (const item of selected) {
  const quote = quoteByCode.get(item.code);
  let minutes = [];
  let minuteError = null;
  if (ftshareClient && item.symbol) {
    try {
      const payload = await ftshareClient.call('ft_v1_intraday_auction_volume_symbol', {
        symbol: item.symbol, trade_date: compactDate, page: 1, page_size: 500,
      });
      minutes = listFrom(payload);
      await writeJsonAtomic(path.join(output.raw, `ftshare-minutes-${item.code}.json`), payload);
    } catch (error) {
      minuteError = error instanceof Error ? error.message : String(error);
    }
  }
  const early = minutes.filter((row) => {
    const time = new Date(Number(row.ts_millis)).toLocaleTimeString('en-GB', { timeZone: 'Asia/Shanghai', hour12: false });
    return time >= '09:30:00' && time <= '10:00:59';
  });
  const openingFive = early.filter((row) => new Date(Number(row.ts_millis)).toLocaleTimeString('en-GB', { timeZone: 'Asia/Shanghai', hour12: false }) <= '09:35:59');
  const downEvent = limitDownByCode.get(item.code);
  const upEvent = currentLimitByCode.get(item.code);
  const bench = benchmarkByCode.get(item.code);
  const snap = snapshotByCode.get(item.code);
  stocks.push({
    ...item,
    auctionPct: number(snap?.auction_pct ?? bench?.auction_pct),
    auctionAmount: number(snap?.auction_amount ?? snap?.amount),
    auctionTags: bench?.tags ?? [],
    openPct: pct(quote?.open && quote?.prev_close ? (number(quote.open) - number(quote.prev_close)) / number(quote.prev_close) : null),
    closePct: pct(quote?.change_rate),
    dailyLowPct: pct(quote?.low && quote?.prev_close ? (number(quote.low) - number(quote.prev_close)) / number(quote.prev_close) : null),
    limitDownEnter: downEvent?.limit_down_enter ?? [],
    limitDownBreak: downEvent?.limit_down_break ?? [],
    limitUpEnter: upEvent?.limit_up_enter ?? [],
    limitUpBreak: upEvent?.limit_up_break ?? [],
    earlySession: {
      minuteRows: early.length,
      openingFiveTurnoverPctOfDay: round(openingFive.reduce((sum, row) => sum + (number(row.turnover_ratio) ?? 0), 0) * 100),
      firstThirtyMinutesTurnoverPctOfDay: round(early.reduce((sum, row) => sum + (number(row.turnover_ratio) ?? 0), 0) * 100),
      firstMinuteAt: early[0]?.ts_millis ? new Date(Number(early[0].ts_millis)).toLocaleTimeString('en-GB', { timeZone: 'Asia/Shanghai', hour12: false }) : null,
    },
    minuteEvidenceStatus: minuteError ? 'unavailable' : minutes.length ? 'complete' : 'empty',
    minuteError,
  });
}

const minuteComplete = stocks.filter((stock) => stock.minuteEvidenceStatus === 'complete').length;
const yesterdayLimitStocks = stocks.filter((stock) => stock.reasons.some((reason) => reason.startsWith('昨日涨停')));
const payload = {
  schemaVersion: '1.0', tradeDate: date, generatedAt: new Date().toISOString(), marketPhase,
  capabilities: {
    historicalAuctionBenchmark: benchmarkError ? 'unavailable' : 'complete',
    allStockHistoricalAuctionSnapshot: date === today ? (snapshotError ? 'unavailable' : 'complete') : 'not-supported',
    historicalPriceMinuteReplay: 'not-supported',
    historicalTurnoverMinuteEvidence: ftshareError ? 'unavailable' : 'supported',
    note: '历史竞价基准仅覆盖同花顺选出的短线风向标；FTShare分钟数据为成交额/成交量占比，不含分钟价格，不据此反推早盘涨跌路径。',
  },
  benchmark,
  stocks,
  negativeFeedback: {
    auctionSevereCount: stocks.filter((stock) => stock.auctionPct !== null && stock.auctionPct <= -7).length,
    earlyLimitDownCount: stocks.filter((stock) => stock.limitDownEnter.some((time) => time >= '09:25:00' && time <= '10:00:00')).length,
    closeBigLossCount: stocks.filter((stock) => stock.closePct !== null && stock.closePct <= -5).length,
    yesterdayLimitSample: yesterdayLimitStocks.length,
    yesterdayLimitCloseBigLoss: yesterdayLimitStocks.filter((stock) => stock.closePct !== null && stock.closePct <= -5).length,
    note: '以上仅为重点股证据池计数，不等于冻结A/B核心池痛感指标。',
  },
  coverage: { priorityStocks: selected.length, minuteComplete, minuteCoveragePct: selected.length ? round(minuteComplete / selected.length * 100) : null },
  errors: { benchmark: benchmarkError, snapshot: snapshotError, ftshare: ftshareError },
};
await writeJsonAtomic(output.data, payload);
const evidenceComplete = selected.length > 0
  && minuteComplete === selected.length
  && !benchmarkError
  && (date !== today || !snapshotError);
await writeJsonAtomic(output.manifest, {
  schemaVersion: '1.0', tradeDate: date, status: evidenceComplete ? 'complete' : 'partial',
  marketPhase, finalizedAt: marketPhase === 'final' ? payload.generatedAt : null,
  priorityStocks: selected.length, minuteComplete, benchmarkRows: benchmark.length,
});
console.log(`[竞价/早盘证据完成] ${date}：优先股${selected.length}只，分钟覆盖${minuteComplete}只，竞价基准${benchmark.length}只。`);

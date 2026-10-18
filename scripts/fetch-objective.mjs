import { access, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_CACHE_ROOT,
  assertTradeDate,
  cacheMarketPhase,
  completeManifest,
  finalCacheRequired,
  fileExists,
  ftsharePaths,
  readJson,
  writeJsonAtomic,
} from './data-cache-paths.mjs';

const endpoint = process.env.FTSHARE_MCP_URL ?? 'https://market.ft.tech/gateway/mcp';
const apiKey = process.env.FTSHARE_API_KEY?.trim();

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const flag = (name) => args.includes(name);
const date = assertTradeDate(arg('--date', new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })));
const compactDate = date.replaceAll('-', '');
const cacheRoot = arg('--cache-root', DEFAULT_CACHE_ROOT);
const canonical = ftsharePaths(date, cacheRoot);
const output = arg('--output', canonical.data);
const partialPath = arg('--partial', output === canonical.data ? canonical.partial : `${output}.partial`);
const manifestPath = arg('--manifest', output === canonical.data ? canonical.manifest : path.join(path.dirname(output), 'manifest.json'));
const refresh = flag('--refresh');
const providedPriorTradeDate = arg('--prior-date', null);
const pageSize = 30;
const concurrency = Math.max(1, Math.min(3, Number(arg('--concurrency', '1')) || 1));
const requestedPhase = cacheMarketPhase(date);
const requireFinal = finalCacheRequired(date);
if (requestedPhase === 'future') throw new Error(`不能采集未来交易日：${date}`);

let requestId = 0;
let sessionId = '';
let protocolVersion = '2025-11-25';

function parseBody(text, contentType) {
  if (contentType.includes('application/json')) return JSON.parse(text);
  const messages = text.split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== '[DONE]')
    .map((line) => JSON.parse(line));
  if (!messages.length) throw new Error(`MCP返回无法解析：${text.slice(0, 200)}`);
  return messages.at(-1);
}

async function rpc(method, params, notification = false) {
  const response = await fetch(endpoint, {
    method: 'POST',
    signal: AbortSignal.timeout(60_000),
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      FTSHARE_API_KEY: apiKey,
      ...(sessionId ? { 'mcp-session-id': sessionId, 'MCP-Protocol-Version': protocolVersion } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', method, ...(notification ? {} : { id: ++requestId }), params }),
  });
  const text = notification || response.status === 202 ? '' : await response.text();
  if (!response.ok) throw new Error(`${method}失败：HTTP ${response.status} ${text.slice(0, 300)}`);
  sessionId = response.headers.get('mcp-session-id') ?? sessionId;
  if (notification || response.status === 202) return null;
  const message = parseBody(text, response.headers.get('content-type') ?? '');
  if (message.error) throw new Error(message.error.message ?? JSON.stringify(message.error));
  return message.result;
}

function decode(result) {
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
  if (!text) return result;
  try { return JSON.parse(text); } catch { return text; }
}

async function connectMcp() {
  sessionId = '';
  const initialized = await rpc('initialize', {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: 'linsc-data-cache', version: '1.0.0' },
  });
  protocolVersion = initialized?.protocolVersion ?? protocolVersion;
  await rpc('notifications/initialized', undefined, true);
}

async function call(name, toolArgs) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const payload = decode(await rpc('tools/call', { name, arguments: toolArgs }));
      if (payload?.error) throw new Error(`${payload.error.code ?? 'TOOL_ERROR'}: ${payload.error.message ?? '调用失败'}`);
      return payload;
    } catch (error) {
      lastError = error;
      if (/HTTP 404|session/i.test(error.message)) await connectMcp();
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
  throw lastError;
}

async function callPaged(name, toolArgs, pageSize = 100) {
  const first = await call(name, { ...toolArgs, page: 1, page_size: pageSize });
  const pagination = first?.metadata?.pagination ?? {};
  const pages = Math.max(1, Math.min(400, Number(pagination.pages) || 1));
  if (pages === 1 && pagination.supported !== true) return first;
  const payloads = [first];
  for (let page = 2; page <= pages; page += 1) {
    payloads.push(await call(name, { ...toolArgs, page, page_size: pageSize }));
  }
  const rows = payloads.flatMap((payload) => Array.isArray(payload?.data) ? payload.data : []);
  return {
    ...first,
    data: rows,
    metadata: {
      ...first.metadata,
      returned: rows.length,
      truncated: false,
      warnings: [],
      pagination: { ...pagination, page: pages, pages, has_more: false, supported: true },
    },
  };
}

const recordsInPage = (payload) => Array.isArray(payload?.data) ? payload.data : [];
const paginationOf = (payload) => payload?.metadata?.pagination ?? {};
const dateOf = (row) => String(row?.trade_date ?? row?.date ?? row?.tradeDate ?? '').replaceAll('-', '').slice(0, 8);

function validateSnapshot(snapshot) {
  const pages = Array.isArray(snapshot?.stocks) ? snapshot.stocks : [];
  const records = pages.flatMap(recordsInPage);
  const truncatedPages = pages.filter((payload) => payload?.metadata?.truncated).length;
  const pageNumbers = pages.map((payload, index) => Number(paginationOf(payload).page ?? index + 1));
  const continuousPages = pageNumbers.every((page, index) => page === index + 1);
  const dates = records.map(dateOf).filter(Boolean);
  const mismatchedDates = dates.filter((value) => value !== compactDate).length;
  const lastHasMore = pages.length ? paginationOf(pages.at(-1)).has_more : null;
  const advertisedTotals = pages.map((payload) => Number(payload?.metadata?.total)).filter(Number.isFinite);
  const advertisedTotal = advertisedTotals[0] ?? null;
  const totalsAgree = advertisedTotals.every((value) => value === advertisedTotal);
  const observedPageSize = pages.length > 1 ? Math.max(...pages.slice(0, -1).map((payload) => recordsInPage(payload).length)) : records.length;
  const complete = snapshot?.tradeDate === date
    && records.length > 0
    && truncatedPages === 0
    && continuousPages
    && mismatchedDates === 0
    && totalsAgree
    && (lastHasMore === false || (advertisedTotal !== null && records.length === advertisedTotal));
  return {
    complete,
    pages: pages.length,
    records: records.length,
    advertisedTotal,
    observedPageSize,
    truncatedPages,
    continuousPages,
    mismatchedDates,
    lastHasMore,
  };
}

async function reuseCompleteCache(file, manifestFile, sourceLabel) {
  let manifest = await completeManifest(manifestFile, date, { requireFinal });
  if (!manifest && requireFinal && await fileExists(file)) {
    const legacyManifest = await readJson(manifestFile, null);
    if (legacyManifest?.tradeDate === date && legacyManifest.status === 'complete' && !legacyManifest.marketPhase) {
      manifest = { ...legacyManifest, marketPhase: 'final', finalizedAt: legacyManifest.cachedAt ?? new Date().toISOString() };
      await writeJsonAtomic(manifestFile, manifest);
    }
  }
  if (!manifest || !(await fileExists(file))) return false;
  console.log(`[FTShare缓存命中] ${date}：${manifest.records ?? '—'}条，${manifest.pages ?? '—'}页（${sourceLabel}）`);
  return true;
}

if (!refresh && await reuseCompleteCache(output, manifestPath, '统一缓存')) process.exit(0);

const legacyCandidates = [
  path.join('data', 'raw', `${date}.json`),
  path.join('data', 'raw', `smoke-${date}.json`),
  path.join('work', `report-${date.slice(5).replace('-', '')}-v1`, 'raw.json'),
  path.join('work', `report-${date.replaceAll('-', '')}-v1`, 'raw.json'),
];
if (!refresh) {
  for (const legacy of legacyCandidates) {
    if (!(await fileExists(legacy))) continue;
    const snapshot = await readJson(legacy, null);
    const validation = validateSnapshot(snapshot);
    if (!validation.complete) continue;
    await writeJsonAtomic(output, snapshot);
    await writeJsonAtomic(manifestPath, {
      schemaVersion: '1.0',
      source: 'FTShare-MCP/ft_v1_stock_history_list',
      tradeDate: date,
      status: 'complete',
      marketPhase: 'final',
      finalizedAt: new Date().toISOString(),
      cachedAt: new Date().toISOString(),
      importedFrom: path.resolve(legacy),
      pageSize: validation.observedPageSize,
      ...validation,
    });
    console.log(`[FTShare缓存导入] ${date}：${validation.records}条，${validation.pages}页`);
    process.exit(0);
  }
}

if (!apiKey) throw new Error('缓存未命中且缺少FTSHARE_API_KEY。请配置环境变量后重新启动终端。');
await connectMcp();

const latestTradeDate = null;
let priorTradeDate = providedPriorTradeDate;
if (providedPriorTradeDate && !/^\d{8}$/.test(providedPriorTradeDate)) throw new Error(`--prior-date格式错误：${providedPriorTradeDate}`);
if (!priorTradeDate) {
  const calendarStartDate = new Date(`${date}T00:00:00Z`);
  calendarStartDate.setUTCDate(calendarStartDate.getUTCDate() - 14);
  const calendarStart = Number(calendarStartDate.toISOString().slice(0, 10).replaceAll('-', ''));
  const calendar = await call('ft_v1_time_trading_calendar', { market: 'cn', start_date: calendarStart, end_date: Number(compactDate) });
  const tradeDates = calendar?.data?.[0]?.trade_dates ?? [];
  priorTradeDate = tradeDates.filter((value) => Number(value) < Number(compactDate)).at(-1);
}
if (!priorTradeDate) throw new Error(`找不到 ${date} 的前一交易日`);

await mkdir(path.dirname(output), { recursive: true });
let stocks = [];
if (!refresh) {
  try {
    await access(partialPath);
    const partial = JSON.parse(await readFile(partialPath, 'utf8'));
    if (partial.tradeDate === date && Array.isArray(partial.stocks)) stocks = partial.stocks;
  } catch {}
}

const resumedRecords = stocks.reduce((sum, payload) => sum + recordsInPage(payload).length, 0);
const partialPagesComplete = stocks.length > 0 && paginationOf(stocks.at(-1)).has_more === false;
if (!partialPagesComplete && resumedRecords % pageSize !== 0) throw new Error(`断点记录数${resumedRecords}不能按page_size=${pageSize}续取`);
let finished = partialPagesComplete;
for (let page = stocks.length + 1; page <= 400 && !finished; page += concurrency) {
  const pageNumbers = Array.from({ length: concurrency }, (_, index) => page + index).filter((value) => value <= 400);
  const payloads = await Promise.all(pageNumbers.map((pageNumber) => call('ft_v1_stock_history_list', {
    trade_date: Number(compactDate), page: pageNumber, page_size: pageSize,
  })));
  for (let index = 0; index < payloads.length; index += 1) {
    const payload = payloads[index];
    const pageNumber = pageNumbers[index];
    stocks.push(payload);
    const count = recordsInPage(payload).length;
    const pagination = paginationOf(payload);
    if (pageNumber === 1 || pageNumber % 10 === 0 || pagination.has_more === false) {
      console.log(JSON.stringify({ date, page: pageNumber, count, total: payload?.metadata?.total, hasMore: pagination.has_more }));
    }
    if (payload?.metadata?.truncated) throw new Error(`第${pageNumber}页被截断，请保持page_size=${pageSize}`);
    if (pagination.has_more === false || (pagination.has_more === undefined && count < pageSize)) {
      finished = true;
      break;
    }
  }
  await writeJsonAtomic(partialPath, { tradeDate: date, pageSize, stocks });
  if (!finished) await new Promise((resolve) => setTimeout(resolve, 250));
}

const [limitUp, limitDown, brokenLimit, yesterdayLimit] = await Promise.all([
  callPaged('ft_v1_limit_list', { limit_type: 'up', trade_date: compactDate }),
  callPaged('ft_v1_limit_list', { limit_type: 'down', trade_date: compactDate }),
  callPaged('ft_v1_limit_list', { limit_type: 'up_break', trade_date: compactDate }),
  callPaged('ft_v1_limit_list', { limit_type: 'up', trade_date: String(priorTradeDate) }),
]);

const snapshot = {
  schemaVersion: '1.0',
  tradeDate: date,
  fetchedAt: new Date().toISOString(),
  source: 'FTShare-MCP/ft_v1_stock_history_list',
  latestTradeDate,
  priorTradeDate: String(priorTradeDate),
  universe: {
    excludeNameContains: ['ST', '*ST'],
    excludeBoards: ['北交所'],
    includeBoards: ['沪市主板', '深市主板', '创业板', '科创板'],
  },
  stocks,
  limitUp,
  limitDown,
  brokenLimit,
  yesterdayLimit,
};
const validation = validateSnapshot(snapshot);
if (!validation.complete) throw new Error(`FTShare完整性检查失败：${JSON.stringify(validation)}`);

await writeJsonAtomic(output, snapshot);
await writeJsonAtomic(manifestPath, {
  schemaVersion: '1.0',
  source: snapshot.source,
  tradeDate: date,
  status: 'complete',
  marketPhase: requestedPhase,
  finalizedAt: requestedPhase === 'final' ? new Date().toISOString() : null,
  cachedAt: new Date().toISOString(),
  endpoint,
  pageSize,
  concurrency,
  priorTradeDate: snapshot.priorTradeDate,
  ...validation,
});
await rm(partialPath, { force: true });
console.log(`[FTShare缓存完成] ${date}：${validation.records}条，${validation.pages}页 -> ${output}`);

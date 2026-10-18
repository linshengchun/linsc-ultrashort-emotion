import { mkdir } from 'node:fs/promises';
import { DEFAULT_CACHE_ROOT, assertTradeDate, cacheMarketPhase, ftsharePaths, writeJsonAtomic } from './data-cache-paths.mjs';
import { callFtsharePaged, createFtshareClient } from './ftshare-mcp-client.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const date = assertTradeDate(arg('--date', new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })));
const cacheRoot = arg('--cache-root', DEFAULT_CACHE_ROOT);
const paths = ftsharePaths(date, cacheRoot);
const compactDate = date.replaceAll('-', '');
const concurrency = Math.max(1, Math.min(3, Number(arg('--concurrency', '3')) || 3));
if (cacheMarketPhase(date) !== 'final') throw new Error(`${date}尚未到收盘终态。`);

const client = await createFtshareClient();
const calendarStart = new Date(`${date}T00:00:00+08:00`);
calendarStart.setDate(calendarStart.getDate() - 14);
const calendar = await client.call('ft_v1_time_trading_calendar', {
  market: 'cn',
  start_date: Number(calendarStart.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }).replaceAll('-', '')),
  end_date: Number(compactDate),
});
const dates = calendar?.data?.[0]?.trade_dates?.map(String) ?? [];
const priorTradeDate = dates.filter((value) => value < compactDate).at(-1);
if (!priorTradeDate) throw new Error(`找不到${date}的前一交易日。`);

const pages = [];
let totalPages = 1;
for (let page = 1; page <= totalPages; page += concurrency) {
  const pageNumbers = Array.from({ length: concurrency }, (_, index) => page + index).filter((value) => value <= totalPages);
  const payloads = await Promise.all(pageNumbers.map((pageNumber) => client.call('ft_v1_daec_stocks', { page: pageNumber, page_size: 30 })));
  for (const [index, payload] of payloads.entries()) {
    const pageNumber = pageNumbers[index];
    pages.push({ ...payload, data: (payload?.data ?? []).map((row) => ({ ...row, trade_date: Number(compactDate) })) });
    totalPages = Number(payload?.metadata?.pagination?.pages ?? totalPages);
    if (pageNumber === 1 || pageNumber % 10 === 0 || pageNumber === totalPages) console.log(JSON.stringify({ date, page: pageNumber, totalPages, count: payload?.data?.length ?? 0 }));
  }
}
pages.sort((left, right) => Number(left?.metadata?.pagination?.page ?? 0) - Number(right?.metadata?.pagination?.page ?? 0));
const [limitUp, limitDown, brokenLimit, yesterdayLimit, marketSnapshot] = await Promise.all([
  callFtsharePaged(client, 'ft_v1_limit_list', { limit_type: 'up', trade_date: compactDate }),
  callFtsharePaged(client, 'ft_v1_limit_list', { limit_type: 'down', trade_date: compactDate }),
  callFtsharePaged(client, 'ft_v1_limit_list', { limit_type: 'up_break', trade_date: compactDate }),
  callFtsharePaged(client, 'ft_v1_limit_list', { limit_type: 'up', trade_date: priorTradeDate }),
  client.call('ft_v1_daec_market_snapshot', { scope: 'ChinaStock' }),
]);
const snapshot = {
  schemaVersion: '1.0', tradeDate: date, fetchedAt: new Date().toISOString(), source: 'FTShare-MCP/ft_v1_daec_stocks',
  latestTradeDate: date, priorTradeDate, marketSnapshot, universe: {
    excludeNameContains: ['ST', '*ST'], excludeBoards: ['北交所'], includeBoards: ['沪市主板', '深市主板', '创业板', '科创板'],
  },
  stocks: pages, limitUp, limitDown, brokenLimit, yesterdayLimit,
};
await mkdir(paths.dir, { recursive: true });
await writeJsonAtomic(paths.data, snapshot);
await writeJsonAtomic(paths.manifest, {
  schemaVersion: '1.0', tradeDate: date, status: 'complete', marketPhase: 'final', finalizedAt: snapshot.fetchedAt,
  source: snapshot.source, records: pages.reduce((sum, page) => sum + (page.data?.length ?? 0), 0), pages: pages.length,
  endpoint: 'ft_v1_daec_stocks', pageSize: 30, priorTradeDate,
});
console.log(`[FTShare收盘快照完成] ${date}：${pages.length}页 -> ${paths.data}`);

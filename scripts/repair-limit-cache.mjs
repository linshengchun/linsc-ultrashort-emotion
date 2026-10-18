import { readFile } from 'node:fs/promises';
import { cacheMarketPhase, ftsharePaths, writeJsonAtomic } from './data-cache-paths.mjs';
import { callFtsharePaged, createFtshareClient } from './ftshare-mcp-client.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const date = arg('--date');
const cacheRoot = arg('--cache-root', 'data/cache');
if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || cacheMarketPhase(date) !== 'final') {
  throw new Error(`只能修复已进入收盘终态的交易日：${date ?? '—'}`);
}

const paths = ftsharePaths(date, cacheRoot);
const snapshot = JSON.parse(await readFile(paths.data, 'utf8'));
const priorTradeDate = String(snapshot.priorTradeDate ?? '');
if (!/^\d{8}$/.test(priorTradeDate)) throw new Error(`${date}缺少前一交易日，无法修复昨日涨停池。`);
const client = await createFtshareClient();
const [limitUp, limitDown, brokenLimit, yesterdayLimit] = await Promise.all([
  callFtsharePaged(client, 'ft_v1_limit_list', { limit_type: 'up', trade_date: date.replaceAll('-', '') }),
  callFtsharePaged(client, 'ft_v1_limit_list', { limit_type: 'down', trade_date: date.replaceAll('-', '') }),
  callFtsharePaged(client, 'ft_v1_limit_list', { limit_type: 'up_break', trade_date: date.replaceAll('-', '') }),
  callFtsharePaged(client, 'ft_v1_limit_list', { limit_type: 'up', trade_date: priorTradeDate }),
]);
const repaired = { ...snapshot, fetchedAt: new Date().toISOString(), limitUp, limitDown, brokenLimit, yesterdayLimit };
await writeJsonAtomic(paths.data, repaired);
console.log(JSON.stringify({
  date,
  limitUp: limitUp?.metadata?.returned,
  brokenLimit: brokenLimit?.metadata?.returned,
  yesterdayLimit: yesterdayLimit?.metadata?.returned,
  limitUpTruncated: limitUp?.metadata?.truncated ?? null,
  brokenLimitTruncated: brokenLimit?.metadata?.truncated ?? null,
  yesterdayLimitTruncated: yesterdayLimit?.metadata?.truncated ?? null,
}));

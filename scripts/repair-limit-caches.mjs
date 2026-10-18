import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_CACHE_ROOT, completeManifest, fileExists, ftsharePaths, writeJsonAtomic } from './data-cache-paths.mjs';
import { callFtsharePaged, createFtshareClient } from './ftshare-mcp-client.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const targetDate = arg('--date');
const cacheRoot = arg('--cache-root', DEFAULT_CACHE_ROOT);
if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate ?? '')) throw new Error('请使用--date YYYY-MM-DD');
const base = path.join(cacheRoot, 'ftshare');
const candidates = (await readdir(base, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
  .map((entry) => entry.name)
  .filter((date) => date <= targetDate)
  .sort();
const dates = [];
for (const date of candidates) {
  const paths = ftsharePaths(date, cacheRoot);
  if (await completeManifest(paths.manifest, date, { requireFinal: true }) && await fileExists(paths.data)) dates.push(date);
}
const windowDates = dates.slice(-61);
if (windowDates.length !== 61 || windowDates.at(-1) !== targetDate) throw new Error(`窗口不完整：${windowDates[0]}—${windowDates.at(-1)}，共${windowDates.length}日`);

const needsRepair = (payload) => {
  const metadata = payload?.metadata;
  if (!metadata) return true;
  const list = Array.isArray(metadata) ? metadata : [metadata];
  return list.some((item) => item?.truncated || Number(item?.returned ?? 0) < Number(item?.total ?? 0));
};
const client = await createFtshareClient();
let repaired = 0;
for (let index = 0; index < windowDates.length; index += 1) {
  const date = windowDates[index];
  const paths = ftsharePaths(date, cacheRoot);
  const objective = JSON.parse(await readFile(paths.data, 'utf8'));
  if (!['limitUp', 'limitDown', 'brokenLimit', 'yesterdayLimit'].some((key) => needsRepair(objective[key]))) continue;
  const started = Date.now();
  const compactDate = date.replaceAll('-', '');
  const priorTradeDate = String(objective.priorTradeDate ?? windowDates[index - 1]?.replaceAll('-', '') ?? '').replaceAll('-', '');
  const [limitUp, limitDown, brokenLimit, yesterdayLimit] = await Promise.all([
    callFtsharePaged(client, 'ft_v1_limit_list', { limit_type: 'up', trade_date: compactDate }),
    callFtsharePaged(client, 'ft_v1_limit_list', { limit_type: 'down', trade_date: compactDate }),
    callFtsharePaged(client, 'ft_v1_limit_list', { limit_type: 'up_break', trade_date: compactDate }),
    callFtsharePaged(client, 'ft_v1_limit_list', { limit_type: 'up', trade_date: priorTradeDate }),
  ]);
  await writeJsonAtomic(paths.data, { ...objective, fetchedAt: new Date().toISOString(), limitUp, limitDown, brokenLimit, yesterdayLimit });
  repaired += 1;
  console.log(JSON.stringify({
    date,
    durationSec: Number(((Date.now() - started) / 1000).toFixed(1)),
    progress: `${index + 1}/${windowDates.length}`,
    limitUp: limitUp?.metadata?.returned,
    limitDown: limitDown?.metadata?.returned,
    brokenLimit: brokenLimit?.metadata?.returned,
    yesterdayLimit: yesterdayLimit?.metadata?.returned,
  }));
}
console.log(JSON.stringify({ complete: true, window: `${windowDates[0]}—${windowDates.at(-1)}`, repaired }));

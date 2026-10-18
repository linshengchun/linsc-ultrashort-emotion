import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_CACHE_ROOT = process.env.LINSC_DATA_CACHE_DIR ?? path.join('data', 'cache');

export function assertTradeDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) throw new Error(`日期格式错误：${date ?? '—'}，应为YYYY-MM-DD`);
  return date;
}

export function sourceDir(source, date, cacheRoot = DEFAULT_CACHE_ROOT) {
  assertTradeDate(date);
  return path.join(cacheRoot, source, date);
}

export function ftsharePaths(date, cacheRoot = DEFAULT_CACHE_ROOT) {
  const dir = sourceDir('ftshare', date, cacheRoot);
  return {
    dir,
    data: path.join(dir, 'objective.json'),
    partial: path.join(dir, 'objective.json.partial'),
    manifest: path.join(dir, 'manifest.json'),
  };
}

export function jiuyangPaths(date, cacheRoot = DEFAULT_CACHE_ROOT) {
  const dir = sourceDir('jiuyang', date, cacheRoot);
  return {
    dir,
    data: path.join(dir, 'normalized.json'),
    manifest: path.join(dir, 'manifest.json'),
    raw: path.join(dir, 'raw'),
  };
}

export function wencaiPaths(date, cacheRoot = DEFAULT_CACHE_ROOT) {
  const dir = sourceDir('wencai', date, cacheRoot);
  return {
    dir,
    data: path.join(dir, 'fallback.json'),
    anomalies: path.join(dir, 'anomalies.json'),
    manifest: path.join(dir, 'manifest.json'),
  };
}

export function derivedPaths(date, cacheRoot = DEFAULT_CACHE_ROOT) {
  const dir = sourceDir('derived', date, cacheRoot);
  return {
    dir,
    data: path.join(dir, 'metrics.json'),
    manifest: path.join(dir, 'manifest.json'),
  };
}

export function intradayPaths(date, cacheRoot = DEFAULT_CACHE_ROOT) {
  const dir = sourceDir('intraday', date, cacheRoot);
  return {
    dir,
    data: path.join(dir, 'evidence.json'),
    manifest: path.join(dir, 'manifest.json'),
    raw: path.join(dir, 'raw'),
  };
}

export function shanghaiClock(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

export function cacheMarketPhase(tradeDate, now = new Date()) {
  assertTradeDate(tradeDate);
  const clock = shanghaiClock(now);
  if (tradeDate < clock.date) return 'final';
  if (tradeDate > clock.date) return 'future';
  return clock.time >= '15:10:00' ? 'final' : 'intraday';
}

export function finalCacheRequired(tradeDate, now = new Date()) {
  return cacheMarketPhase(tradeDate, now) === 'final';
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function fileExists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

export async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}

export async function completeManifest(file, expectedDate, { requireFinal = false } = {}) {
  const manifest = await readJson(file, null);
  if (!manifest || manifest.tradeDate !== expectedDate || manifest.status !== 'complete') return null;
  if (requireFinal && manifest.marketPhase !== 'final') return null;
  return manifest;
}

import { spawn } from 'node:child_process';
import { cp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_CACHE_ROOT,
  assertTradeDate,
  cacheMarketPhase,
  completeManifest,
  derivedPaths,
  fileExists,
  ftsharePaths,
  intradayPaths,
  jiuyangPaths,
  readJson,
  wencaiPaths,
  writeJsonAtomic,
} from './data-cache-paths.mjs';
import { debugBrowserReady } from './cdp-page.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const flag = (name) => args.includes(name);
const date = assertTradeDate(arg('--date', new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })));
const cacheRoot = arg('--cache-root', DEFAULT_CACHE_ROOT);
const refresh = flag('--refresh');
const forReport = flag('--for-report');
const debugPort = Number(arg('--debug-port', process.env.LINSC_MARKET_BROWSER_PORT ?? '9223'));
const marketPhase = cacheMarketPhase(date);
if (marketPhase === 'future') throw new Error(`不能准备未来日期：${date}`);
if (forReport && marketPhase !== 'final') throw new Error(`${date}尚未收盘终态（15:10后才允许生成正式报告）。`);

const ftshare = ftsharePaths(date, cacheRoot);
const jiuyang = jiuyangPaths(date, cacheRoot);
const wencai = wencaiPaths(date, cacheRoot);

async function command(script, commandArgs, label) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...commandArgs], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${label}失败，退出码 ${code}`)));
  });
}

async function importJiuyangLegacy() {
  if (await fileExists(jiuyang.data)) return false;
  const candidates = [
    path.join('data', 'narratives', date),
    path.join('work', `report-${date.slice(5).replace('-', '')}-v1`, 'narratives'),
    path.join('work', `report-${date.replaceAll('-', '')}-v1`, 'narratives'),
  ];
  for (const source of candidates) {
    if (!(await fileExists(path.join(source, 'normalized.json')))) continue;
    await mkdir(jiuyang.dir, { recursive: true });
    await cp(source, jiuyang.dir, { recursive: true, force: false });
    const oldManifest = await readJson(jiuyang.manifest, {});
    const successful = Number(oldManifest.successful ?? 0);
    await writeJsonAtomic(jiuyang.manifest, {
      ...oldManifest,
      schemaVersion: oldManifest.schemaVersion ?? '1.0',
      tradeDate: date,
      source: oldManifest.source ?? '韭研公社',
      status: successful > 0 && !oldManifest.rateLimited ? 'complete' : 'partial',
      marketPhase: 'final',
      finalizedAt: oldManifest.collectedAt ?? new Date().toISOString(),
      importedAt: new Date().toISOString(),
      importedFrom: path.resolve(source),
    });
    console.log(`[韭研缓存导入] ${date} <- ${source}`);
    return true;
  }
  return false;
}

async function importWencaiLegacy() {
  if (await fileExists(wencai.data)) return false;
  const source = path.join('data', 'fallbacks', `${date}-wencai-limit-up.json`);
  if (!(await fileExists(source))) return false;
  const payload = JSON.parse(await readFile(source, 'utf8'));
  await writeJsonAtomic(wencai.data, payload);
  await writeJsonAtomic(wencai.manifest, {
    schemaVersion: '1.0',
    tradeDate: date,
    source: '同花顺问财手工回退',
    status: 'complete',
    marketPhase: 'final',
    finalizedAt: new Date().toISOString(),
    cachedAt: new Date().toISOString(),
    importedFrom: path.resolve(source),
    note: '仅表示该查询结果已完整缓存，不代表Draft.13全部问财字段已覆盖。',
  });
  console.log(`[问财缓存导入] ${date} <- ${source}`);
  return true;
}

if (forReport) {
  await command('scripts/backfill-ftshare-history.mjs', [
    '--date', date, '--cache-root', cacheRoot, '--prior-days', '60', '--concurrency', arg('--concurrency', '1'),
  ], 'FTShare 60日缓存准备');
} else {
  const fetchArgs = ['--date', date, '--cache-root', cacheRoot];
  if (refresh) fetchArgs.push('--refresh');
  await command('scripts/fetch-objective.mjs', fetchArgs, 'FTShare缓存准备');
}
await importJiuyangLegacy();
await importWencaiLegacy();

const browserReady = await debugBrowserReady(debugPort);
const wencaiApiReady = Boolean(
  process.env.HITHINK_FINANCE_API_KEY?.trim()
  || process.env.FUYAO_API_KEY?.trim()
  || process.env.FUYAO_TOKEN?.trim()
  || process.env.IWENCAI_API_KEY?.trim(),
);
const wencaiManifest = await completeManifest(wencai.manifest, date, { requireFinal: forReport });
if ((refresh || !wencaiManifest || !(await fileExists(wencai.data))) && (wencaiApiReady || browserReady)) {
  await command('scripts/collect-wencai.mjs', [
    '--date', date,
    '--cache-root', cacheRoot,
    '--debug-port', String(debugPort),
  ], '问财缓存准备');
} else if (!wencaiManifest && !wencaiApiReady && !browserReady) {
  console.log(`[问财待采集] ${date}：未配置同花顺金融数据API Key，专用浏览器调试端口${debugPort}也未启动`);
}

const narrativeComplete = await completeManifest(jiuyang.manifest, date, { requireFinal: false });
const narrativeManifest = await readJson(jiuyang.manifest, {});
const needsAuthenticatedRefresh = browserReady && !narrativeManifest.authenticatedSessionSupplied;
if (refresh || !narrativeComplete || !(await fileExists(jiuyang.data)) || needsAuthenticatedRefresh) {
  const collectArgs = [
    '--date', date,
    '--cache-root', cacheRoot,
    '--objective', ftshare.data,
    '--output-dir', jiuyang.dir,
  ];
  if (browserReady) collectArgs.push('--debug-port', String(debugPort));
  if (refresh || needsAuthenticatedRefresh) collectArgs.push('--refresh');
  await command('scripts/collect-narratives.mjs', collectArgs, '韭研缓存准备');
} else {
  console.log(`[韭研缓存命中] ${date}：${jiuyang.data}`);
}

if (await fileExists(jiuyang.data)) {
  await command('scripts/extract-narrative-events.mjs', ['--date', date, '--cache-root', cacheRoot], '韭研事件卡提取');
}

const evidencePaths = intradayPaths(date, cacheRoot);
const evidenceManifest = await readJson(evidencePaths.manifest, null);
const evidenceReady = !refresh
  && evidenceManifest?.tradeDate === date
  && (!forReport || evidenceManifest.marketPhase === 'final')
  && await fileExists(evidencePaths.data);
if (evidenceReady) console.log(`[竞价/早盘证据缓存命中] ${date}：${evidencePaths.data}`);
else await command('scripts/collect-short-term-evidence.mjs', ['--date', date, '--cache-root', cacheRoot], '竞价与早盘证据准备');
const derivedArgs = ['--date', date, '--cache-root', cacheRoot];
if (forReport) derivedArgs.push('--for-report');
const derivedCache = derivedPaths(date, cacheRoot);
const derivedManifest = await completeManifest(derivedCache.manifest, date, { requireFinal: forReport });
const derivedAt = Date.parse(derivedManifest?.generatedAt ?? '');
const sourceManifests = await Promise.all([readJson(ftshare.manifest, null), readJson(wencai.manifest, null)]);
const newestSourceAt = Math.max(...sourceManifests.map((manifest) => Date.parse(
  manifest?.cachedAt ?? manifest?.collectedAt ?? manifest?.finalizedAt ?? '',
)).filter(Number.isFinite), 0);
const derivedReady = !refresh
  && derivedManifest
  && (!forReport || derivedManifest.ma60Ready)
  && Number.isFinite(derivedAt)
  && derivedAt >= newestSourceAt
  && await fileExists(derivedCache.data);
if (derivedReady) console.log(`[确定性指标缓存命中] ${date}：${derivedCache.data}`);
else await command('scripts/build-derived-metrics.mjs', derivedArgs, '确定性指标计算');

if (forReport) {
  const required = [
    { label: 'FTShare', paths: ftshare },
    { label: '问财', paths: wencai },
    { label: '确定性指标', paths: derivedPaths(date, cacheRoot) },
  ];
  for (const { label, paths } of required) {
    const manifest = await completeManifest(paths.manifest, date, { requireFinal: true });
    if (!manifest || !(await fileExists(paths.data))) throw new Error(`${label}没有${date}收盘终态缓存，停止正式报告生成。`);
  }
  const metrics = await readJson(derivedPaths(date, cacheRoot).data, null);
  if (!metrics?.history?.ma60Ready || metrics?.market?.fiveDays?.length !== 5 || metrics?.yesterdayFeedback?.fiveDays?.length !== 5) {
    throw new Error(`确定性指标窗口不完整（需要61个交易日及两张完整近5日表），停止正式报告生成。`);
  }
  const evidence = await readJson(intradayPaths(date, cacheRoot).manifest, null);
  if (!evidence) throw new Error(`竞价与早盘证据缓存缺失，停止正式报告生成。`);
}

console.log(`[统一缓存就绪] ${date}：${path.resolve(cacheRoot)}`);

import { spawn } from 'node:child_process';
import { DEFAULT_CACHE_ROOT, assertTradeDate, completeManifest, fileExists, finalCacheRequired, ftsharePaths } from './data-cache-paths.mjs';
import { createFtshareClient } from './ftshare-mcp-client.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const targetDate = assertTradeDate(arg('--date', new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })));
const cacheRoot = arg('--cache-root', DEFAULT_CACHE_ROOT);
const priorDays = Math.max(4, Number(arg('--prior-days', '60')) || 60);
const concurrency = Math.max(1, Math.min(3, Number(arg('--concurrency', '1')) || 1));
const compactTarget = targetDate.replaceAll('-', '');

const start = new Date(`${targetDate}T00:00:00+08:00`);
start.setDate(start.getDate() - 150);
const compactStart = start.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }).replaceAll('-', '');

const client = await createFtshareClient();
const calendar = await client.call('ft_v1_time_trading_calendar', {
  market: 'cn',
  start_date: Number(compactStart),
  end_date: Number(compactTarget),
});
const tradeDates = [...new Set((calendar?.data ?? []).flatMap((row) => row?.trade_dates ?? []))]
  .map(String)
  .filter((value) => /^\d{8}$/.test(value) && value <= compactTarget)
  .sort();
if (!tradeDates.includes(compactTarget)) throw new Error(`${targetDate}不是交易日，不能建立报告窗口。`);
const required = tradeDates.slice(-(priorDays + 1));
if (required.length !== priorDays + 1) throw new Error(`交易日历不足：需要${priorDays + 1}日，实际${required.length}日。`);

const runOnce = (date, priorDate, currentConcurrency) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    'scripts/fetch-objective.mjs', '--date', date, '--prior-date', priorDate,
    '--cache-root', cacheRoot, '--concurrency', String(currentConcurrency),
  ], { cwd: process.cwd(), env: process.env, stdio: 'inherit', windowsHide: true });
  child.once('error', reject);
  child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${date}缓存失败，退出码${code}`)));
});

async function run(date, priorDate) {
  let currentConcurrency = concurrency;
  let lastError;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      await runOnce(date, priorDate, currentConcurrency);
      return;
    } catch (error) {
      lastError = error;
      currentConcurrency = 1;
      if (attempt < 20) {
        const delaySeconds = Math.min(30, attempt * 5);
        console.log(`[60日缓存续传] ${date}第${attempt}次中断，${delaySeconds}秒后以单并发从断点继续。`);
        await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
      }
    }
  }
  throw lastError;
}

let ready = 0;
for (const compactDate of required) {
  const date = compactDate.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
  const calendarIndex = tradeDates.indexOf(compactDate);
  const priorDate = tradeDates[calendarIndex - 1];
  if (!priorDate) throw new Error(`${date}缺少前一交易日。`);
  const paths = ftsharePaths(date, cacheRoot);
  const manifest = await completeManifest(paths.manifest, date, { requireFinal: finalCacheRequired(date) });
  if (manifest && await fileExists(paths.data)) {
    ready += 1;
    console.log(`[60日缓存命中] ${date}（${ready}/${required.length}）`);
    continue;
  }
  await run(date, priorDate);
  ready += 1;
  console.log(`[60日缓存进度] ${date}（${ready}/${required.length}）`);
}

console.log(`[60日窗口完成] ${required[0]}—${required.at(-1)}，共${required.length}个交易日。`);

import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_CACHE_ROOT, jiuyangPaths } from './data-cache-paths.mjs';

const ENDPOINT = process.env.FTSHARE_MCP_URL ?? 'https://market.ft.tech/gateway/mcp';
const API_KEY = process.env.FTSHARE_API_KEY?.trim();
if (!API_KEY) throw new Error('缺少 FTSHARE_API_KEY。请在Windows用户环境变量中配置后重新启动终端。');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const flag = (name) => args.includes(name);
const date = arg('--date', new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }));
const compactDate = date.replaceAll('-', '');
const intervalMs = Number(arg('--interval-ms', '60000'));
const collectionCooldownMs = Number(arg('--collection-cooldown-ms', '1800000'));
const maxCollections = Number(arg('--max-collections', '8'));
const debugPort = Number(arg('--debug-port', '9223'));
const cacheRoot = arg('--cache-root', DEFAULT_CACHE_ROOT);
const outputDir = arg('--output-dir', jiuyangPaths(date, cacheRoot).dir);
const stateFile = path.join(outputDir, 'intraday-state.json');
const snapshotFile = path.join(outputDir, 'intraday-limit-up.json');
const cookieFile = arg('--cookie-file', path.join('.local', 'session', 'jiuyangongshe-cookie.txt'));
const once = flag('--once');
const noCollect = flag('--no-collect');

if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`日期格式错误：${date}`);
if (!Number.isFinite(intervalMs) || intervalMs < 15000) throw new Error('轮询间隔不得低于15000毫秒');
if (!Number.isFinite(collectionCooldownMs) || collectionCooldownMs < 60000) throw new Error('采集冷却时间不得低于60000毫秒');
if (!Number.isInteger(maxCollections) || maxCollections < 1) throw new Error('每日采集次数上限必须为正整数');

let requestId = 0;
let sessionId = '';
let stopping = false;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function parseBody(text, contentType) {
  if (contentType.includes('application/json')) return JSON.parse(text);
  const messages = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (!messages.length) throw new Error(`MCP返回无法解析：${text.slice(0, 200)}`);
  return messages.at(-1);
}

async function rpc(method, params, notification = false) {
  const payload = { jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) };
  if (!notification) payload.id = ++requestId;
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      FTSHARE_API_KEY: API_KEY,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`${method}失败：HTTP ${response.status}`);
  const nextSession = response.headers.get('mcp-session-id');
  if (nextSession) sessionId = nextSession;
  if (notification || response.status === 202) return null;
  const message = parseBody(await response.text(), response.headers.get('content-type') ?? '');
  if (message.error) throw new Error(`${method}失败：${message.error.message ?? JSON.stringify(message.error)}`);
  return message.result;
}

function decodeToolResult(result) {
  if (result?.structuredContent) return result.structuredContent;
  const texts = result?.content?.filter((item) => item.type === 'text').map((item) => item.text) ?? [];
  if (!texts.length) return result;
  try {
    return JSON.parse(texts.join('\n'));
  } catch {
    return result;
  }
}

async function connectMcp() {
  sessionId = '';
  await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'linsc-intraday-narrative-watch', version: '0.1.0' },
  });
  await rpc('notifications/initialized', undefined, true);
}

async function callTool(name, toolArgs = {}) {
  return decodeToolResult(await rpc('tools/call', { name, arguments: toolArgs }));
}

const recordsFrom = (payload) => {
  if (Array.isArray(payload)) return payload.flatMap(recordsFrom);
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['records', 'data', 'items', 'list', 'results', 'rows']) {
    if (Array.isArray(payload[key])) return payload[key].flatMap(recordsFrom);
  }
  return [payload];
};

const field = (row, names) => {
  for (const name of names) if (row?.[name] !== undefined && row[name] !== null) return row[name];
  return null;
};
const codeOf = (row) => String(field(row, ['symbol', 'code', 'stock_code', '证券代码', '股票代码']) ?? '').replace(/\D/g, '').slice(-6);
const eligible = (row) => {
  const code = codeOf(row);
  const name = String(field(row, ['name', 'stock_name', 'sec_name', '证券简称', '股票简称']) ?? '').toUpperCase();
  return code && !/^(4|8|92)/.test(code) && !name.includes('ST');
};

async function fetchLimitUpPages() {
  return [await callTool('ft_v1_limit_list', { limit_type: 'up', trade_date: compactDate })];
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temp, file);
}

async function command(program, commandArgs) {
  await new Promise((resolve, reject) => {
    const child = spawn(program, commandArgs, { cwd: process.cwd(), stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`子进程退出码：${code}`))));
  });
}

async function cdpCookies() {
  const targetsResponse = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
  if (!targetsResponse.ok) return '';
  const targets = await targetsResponse.json();
  const target = targets.find((item) => item.type === 'page' && String(item.url).includes('jiuyangongshe.com'));
  if (!target?.webSocketDebuggerUrl) return '';

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let id = 0;
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result ?? {});
  };
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error('无法连接浏览器调试端口'));
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const callId = ++id;
    pending.set(callId, { resolve, reject });
    socket.send(JSON.stringify({ id: callId, method, params }));
  });

  try {
    await call('Network.enable');
    const result = await call('Network.getCookies', { urls: ['https://www.jiuyangongshe.com/'] });
    return (result.cookies ?? [])
      .filter((cookie) => String(cookie.domain).includes('jiuyangongshe.com'))
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
  } finally {
    socket.close();
  }
}

async function refreshCookieFile() {
  try {
    const cookie = await cdpCookies();
    if (!cookie) return false;
    await mkdir(path.dirname(cookieFile), { recursive: true });
    await writeFile(cookieFile, cookie, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function shanghaiClock() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date()).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
  );
  const currentDate = `${parts.year}-${parts.month}-${parts.day}`;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return { currentDate, minutes, text: `${parts.hour}:${parts.minute}:${parts.second}` };
}

const isTradingWindow = (minutes) => (minutes >= 9 * 60 + 15 && minutes <= 11 * 60 + 35) || (minutes >= 12 * 60 + 55 && minutes <= 15 * 60 + 10);

async function collect(snapshot, state) {
  if (Number(state.collectionAttempts ?? 0) >= maxCollections) {
    console.log(`[采集] 已达到当日${maxCollections}次访问批次上限，待采集股票留待盘后补抓。`);
    return;
  }
  state.collectionAttempts = Number(state.collectionAttempts ?? 0) + 1;
  const sessionReady = await refreshCookieFile();
  console.log(`[采集] 浏览器登录会话：${sessionReady ? '已读取' : '未读取，使用公开页面'}`);
  await command(process.execPath, [
    'scripts/collect-narratives.mjs',
    '--date',
    date,
    '--objective',
    snapshotFile,
    '--output-dir',
    outputDir,
    '--cookie-file',
    cookieFile,
    '--refresh',
  ]);
  const attemptedAt = new Date().toISOString();
  const manifest = await readJson(path.join(outputDir, 'manifest.json'), null);
  const completed = manifest && !manifest.rateLimited && Number(manifest.successful) > 0;
  state.lastCollectedAt = attemptedAt;
  state.lastCollectionResult = completed ? 'success' : 'deferred';
  if (completed) {
    state.pendingCodes = [];
    pendingCodes.clear();
  } else {
    state.pendingCodes = [...pendingCodes];
    console.log('[采集] 本轮未取得有效页面或触发访问限制，待采集股票已保留。');
  }
  state.lastSnapshotCount = recordsFrom(snapshot.limitUp).filter((row) => eligible(row) && String(field(row, ['status']) ?? 'limit_up') === 'limit_up').length;
  await writeJsonAtomic(stateFile, state);
}

await mkdir(outputDir, { recursive: true });
const state = await readJson(stateFile, {
  schemaVersion: '1.0',
  tradeDate: date,
  startedAt: new Date().toISOString(),
  seenCodes: [],
  pendingCodes: [],
  events: [],
  lastCollectedAt: null,
  collectionAttempts: 0,
});
state.seenCodes ??= [];
state.pendingCodes ??= [];
state.events ??= [];
const seen = new Set(state.seenCodes ?? []);
const pendingCodes = new Set(state.pendingCodes ?? []);

process.once('SIGINT', () => {
  stopping = true;
  console.log('\n收到停止指令，正在保存状态……');
});
process.once('SIGTERM', () => {
  stopping = true;
});

console.log(`LINSC盘中持续监控采集已启动：${date}`);
console.log(`FTShare轮询间隔：${Math.round(intervalMs / 1000)}秒；韭研采集冷却：${Math.round(collectionCooldownMs / 60000)}分钟；每日最多${maxCollections}批`);

await connectMcp();

while (!stopping) {
  const clock = shanghaiClock();
  if (!once && clock.currentDate !== date) {
    console.log(`[${clock.text}] 日期已切换，监控结束。`);
    break;
  }
  if (!once && clock.minutes > 15 * 60 + 10) {
    if (pendingCodes.size && !noCollect) {
      const snapshot = await readJson(snapshotFile, null);
      if (snapshot) await collect(snapshot, state);
    }
    console.log(`[${clock.text}] 已收盘，监控结束。`);
    break;
  }
  if (!once && !isTradingWindow(clock.minutes)) {
    await sleep(intervalMs);
    continue;
  }

  try {
    const limitUp = await fetchLimitUpPages();
    const rows = recordsFrom(limitUp).filter(
      (row) => eligible(row) && String(field(row, ['status']) ?? 'limit_up') === 'limit_up',
    );
    const detectedAt = new Date().toISOString();
    const newRows = rows.filter((row) => !seen.has(codeOf(row)));
    for (const row of newRows) {
      const code = codeOf(row);
      seen.add(code);
      pendingCodes.add(code);
      state.events.push({
        code,
        name: String(field(row, ['name', 'stock_name', 'sec_name', '证券简称', '股票简称']) ?? ''),
        firstLimitUpTime: field(row, ['first_limit_up_time', 'first_limit_time']) ?? null,
        detectedAt,
      });
    }
    state.seenCodes = [...seen];
    state.pendingCodes = [...pendingCodes];
    state.lastPollAt = detectedAt;
    state.lastSnapshotCount = rows.length;
    const snapshot = { tradeDate: date, fetchedAt: detectedAt, source: 'FTShare-MCP盘中监控', limitUp };
    await writeJsonAtomic(snapshotFile, snapshot);
    await writeJsonAtomic(stateFile, state);

    console.log(`[${clock.text}] 当前涨停 ${rows.length} 只；新增 ${newRows.length} 只；待采集 ${pendingCodes.size} 只。`);
    const elapsed = state.lastCollectedAt ? Date.now() - Date.parse(state.lastCollectedAt) : Number.POSITIVE_INFINITY;
    if (!noCollect && pendingCodes.size && elapsed >= collectionCooldownMs && Number(state.collectionAttempts ?? 0) < maxCollections) {
      await collect(snapshot, state);
    }
  } catch (error) {
    console.error(`[${clock.text}] 监控异常：${error instanceof Error ? error.message : String(error)}`);
    try {
      await connectMcp();
    } catch {
      // 下一轮继续重连。
    }
  }

  if (once) break;
  await sleep(intervalMs);
}

state.stoppedAt = new Date().toISOString();
state.seenCodes = [...seen];
state.pendingCodes = [...pendingCodes];
await writeJsonAtomic(stateFile, state);
console.log(`监控状态已保存：${stateFile}`);

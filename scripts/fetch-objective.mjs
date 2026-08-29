import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ENDPOINT = process.env.FTSHARE_MCP_URL ?? 'https://market.ft.tech/gateway/mcp';
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const date = arg('--date', new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }));
const compactDate = date.replaceAll('-', '');
const output = arg('--output', path.join('data', 'raw', `${date}.json`));

let requestId = 0;
let sessionId = '';

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
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`${method}失败：HTTP ${response.status} ${await response.text()}`);
  const nextSession = response.headers.get('mcp-session-id');
  if (nextSession) sessionId = nextSession;
  if (notification || response.status === 202) return null;
  const message = parseBody(await response.text(), response.headers.get('content-type') ?? '');
  if (message.error) throw new Error(`${method}失败：${message.error.message ?? JSON.stringify(message.error)}`);
  return message.result;
}

function decodeToolResult(result) {
  const texts = result?.content?.filter((item) => item.type === 'text').map((item) => item.text) ?? [];
  if (!texts.length) return result;
  const joined = texts.join('\n');
  try {
    return JSON.parse(joined);
  } catch {
    return joined;
  }
}

async function callTool(name, toolArgs = {}) {
  return decodeToolResult(await rpc('tools/call', { name, arguments: toolArgs }));
}

function findRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['records', 'data', 'items', 'list', 'results', 'rows']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

async function callPaged(name, baseArgs, pageSize) {
  const pages = [];
  for (let page = 1; page <= 150; page += 1) {
    const payload = await callTool(name, { ...baseArgs, page, page_size: pageSize });
    const records = findRecords(payload);
    pages.push(payload);
    const hasMore = payload?.metadata?.pagination?.has_more;
    if (hasMore === false || (hasMore === undefined && records.length < pageSize)) break;
  }
  return pages;
}

await rpc('initialize', {
  protocolVersion: '2025-03-26',
  capabilities: {},
  clientInfo: { name: 'linsc-ultrashort-emotion', version: '0.1.0' },
});
await rpc('notifications/initialized', undefined, true);

const [latestTradeDate, marketSnapshot, stocks, limitUp, limitDown, brokenLimit, yesterdayLimit] = await Promise.all([
  callTool('ft_get_nth_trade_date', { n: 1 }),
  callTool('ft_daec_market_snapshot', { scope: 'ChinaStock' }),
  callPaged('ft_daec_stocks_all', {}, 50),
  callPaged('ft_limit_up_pool', { trade_date: compactDate }, 50),
  callTool('ft_limit_down_pool', { trade_date: compactDate }),
  callTool('ft_limit_up_break_pool', { trade_date: compactDate }),
  callTool('ft_limit_up_pool_yesterday', {}),
]);

const snapshot = {
  tradeDate: date,
  fetchedAt: new Date().toISOString(),
  source: 'FTShare-MCP',
  latestTradeDate,
  universe: {
    excludeNameContains: ['ST', '*ST'],
    excludeBoards: ['北交所', '科创板'],
    includeBoards: ['沪市主板', '深市主板', '创业板'],
  },
  marketSnapshot,
  stocks,
  limitUp,
  limitDown,
  brokenLimit,
  yesterdayLimit,
};

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
console.log(`Saved FTShare snapshot: ${output}`);

import path from 'node:path';
import {
  DEFAULT_CACHE_ROOT,
  assertTradeDate,
  cacheMarketPhase,
  derivedPaths,
  fileExists,
  ftsharePaths,
  intradayPaths,
  jiuyangPaths,
  readJson,
  wencaiPaths,
} from './data-cache-paths.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const date = assertTradeDate(arg('--date', new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })));
const compactDate = date.replaceAll('-', '');
const cacheRoot = arg('--cache-root', DEFAULT_CACHE_ROOT);
const skipLive = args.includes('--no-live');
const forReport = args.includes('--for-report');
const expectedPhase = cacheMarketPhase(date);

const rows = [];
const add = (source, status, detail) => rows.push({ source, status, detail });

async function inspectCache(source, paths) {
  const manifest = await readJson(paths.manifest, null);
  const dataExists = await fileExists(paths.data);
  if (!manifest || !dataExists) return add(source, '缺失', '尚无该交易日统一缓存');
  const phaseReady = expectedPhase !== 'final' || manifest.marketPhase === 'final';
  const status = manifest.tradeDate === date && manifest.status === 'complete' && phaseReady ? '可用' : '部分';
  const count = manifest.records !== undefined
    ? `记录=${manifest.records}；页=${manifest.pages ?? '—'}`
    : `成功请求=${manifest.successful ?? '—'}`;
  add(source, status, `${path.relative(process.cwd(), paths.data)}；${manifest.status ?? '无状态'}；阶段=${manifest.marketPhase ?? '旧缓存未标记'}；${count}`);
}

await inspectCache('FTShare本地缓存', ftsharePaths(date, cacheRoot));
await inspectCache('同花顺问财缓存', wencaiPaths(date, cacheRoot));
const jiuyang = jiuyangPaths(date, cacheRoot);
await inspectCache('韭研公社缓存', jiuyang);
await inspectCache('确定性指标缓存', derivedPaths(date, cacheRoot));
await inspectCache('竞价/早盘证据缓存', intradayPaths(date, cacheRoot));
const metrics = await readJson(derivedPaths(date, cacheRoot).data, null);
if (metrics) {
  add('60日指标窗口', metrics.history?.ma60Ready ? '可用' : '部分', `完整交易日=${metrics.history?.availableTradingDays ?? 0}/61；MA60=${metrics.history?.ma60Ready ? '已计算' : '不计算'}`);
  add('跨源涨停核对', metrics.reconciliation?.status === 'matched' ? '可用' : '部分', `FTShare=${metrics.reconciliation?.ftshareLimitUp ?? '—'}；问财=${metrics.reconciliation?.wencaiLimitUp ?? '—'}；仅FT=${metrics.reconciliation?.onlyFtshare?.length ?? '—'}；仅问财=${metrics.reconciliation?.onlyWencai?.length ?? '—'}`);
}
const evidence = await readJson(intradayPaths(date, cacheRoot).data, null);
if (evidence) {
  add('重点股早盘证据覆盖', evidence.coverage?.minuteCoveragePct === 100 ? '可用' : '部分', `重点股=${evidence.coverage?.priorityStocks ?? 0}；分钟覆盖=${evidence.coverage?.minuteComplete ?? 0}；竞价基准=${evidence.benchmark?.length ?? 0}`);
}
const narrative = await readJson(jiuyang.data, null);
if (narrative) {
  const eventCount = Array.isArray(narrative.eventCards) ? narrative.eventCards.length : 0;
  const extractionComplete = narrative.extractionStatus === 'complete';
  const coverage = narrative.extractionCoverage;
  add(
    '韭研事件提取',
    extractionComplete ? '可用' : '部分',
    `eventCards=${eventCount}；检索=${coverage ? `${coverage.searchedPriorityStocks ?? coverage.priorityStocks}/${coverage.priorityStocks}` : '—'}；覆盖=${coverage ? `${coverage.coveredPriorityStocks}/${coverage.priorityStocks}` : '—'}；无证据=${coverage?.noEvidenceStocks?.length ?? '—'}；登录会话=${narrative.authenticatedSessionSupplied ? '有' : '无'}`,
  );
}

if (skipLive) {
  add('FTShare在线接口', '跳过', '使用了--no-live');
} else if (!process.env.FTSHARE_API_KEY?.trim()) {
  add('FTShare在线接口', '不可用', '缺少FTSHARE_API_KEY环境变量');
} else {
  const endpoint = process.env.FTSHARE_MCP_URL ?? 'https://market.ft.tech/gateway/mcp';
  let id = 0;
  let sessionId = '';
  const rpc = async (method, params, notification = false) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        FTSHARE_API_KEY: process.env.FTSHARE_API_KEY.trim(),
        ...(sessionId ? { 'mcp-session-id': sessionId, 'MCP-Protocol-Version': '2025-11-25' } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', method, ...(notification ? {} : { id: ++id }), params }),
    });
    const responseText = notification || response.status === 202 ? '' : await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    sessionId = response.headers.get('mcp-session-id') ?? sessionId;
    if (notification || response.status === 202) return null;
    const messages = responseText.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).filter(Boolean);
    const message = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(responseText) : JSON.parse(messages.at(-1));
    if (message.error) throw new Error(message.error.message ?? 'MCP错误');
    return message.result;
  };
  const decode = (result) => {
    if (result?.structuredContent) return result.structuredContent;
    const value = result?.content?.find((item) => item.type === 'text')?.text;
    try { return value ? JSON.parse(value) : result; } catch { return result; }
  };
  try {
    await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'linsc-data-health', version: '1.0.0' } });
    await rpc('notifications/initialized', {}, true);
    const call = async (name, toolArgs) => decode(await rpc('tools/call', { name, arguments: toolArgs }));
    const [history, limits] = await Promise.all([
      call('ft_v1_stock_history_list', { trade_date: Number(compactDate), page: 1, page_size: 30 }),
      call('ft_v1_limit_list', { limit_type: 'up', trade_date: compactDate }),
    ]);
    const historyCount = Array.isArray(history?.data) ? history.data.length : 0;
    const historyOk = historyCount > 0 && !history?.metadata?.truncated;
    const limitError = limits?.error?.message ?? limits?.error ?? null;
    add('FTShare V1在线接口', historyOk && !limitError ? '可用' : '部分', `历史日行情首屏=${historyCount}；涨停接口=${limitError ? '异常' : '正常'}`);
  } catch (error) {
    add('FTShare V1在线接口', '不可用', error instanceof Error ? error.message : String(error));
  }
}

console.table(rows);
const blocking = rows.some((row) => row.source === 'FTShare V1在线接口' && row.status === '不可用');
const reportBlocking = forReport && (
  !metrics?.history?.ma60Ready
  || rows.some((row) => ['FTShare本地缓存', '同花顺问财缓存', '确定性指标缓存'].includes(row.source) && row.status !== '可用')
);
process.exitCode = blocking || reportBlocking ? 2 : 0;

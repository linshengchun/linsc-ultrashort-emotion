import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { connectCdpPage } from './cdp-page.mjs';
import { DEFAULT_CACHE_ROOT, assertTradeDate, cacheMarketPhase, wencaiPaths, writeJsonAtomic } from './data-cache-paths.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const date = assertTradeDate(arg('--date', new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })));
const cacheRoot = arg('--cache-root', DEFAULT_CACHE_ROOT);
const output = wencaiPaths(date, cacheRoot);
const debugPort = Number(arg('--debug-port', process.env.LINSC_MARKET_BROWSER_PORT ?? '9223'));
const apiKey = process.env.HITHINK_FINANCE_API_KEY?.trim()
  ?? process.env.FUYAO_API_KEY?.trim()
  ?? process.env.FUYAO_TOKEN?.trim()
  ?? process.env.IWENCAI_API_KEY?.trim();
const apiBase = process.env.HITHINK_FINANCE_API_BASE_URL ?? 'https://fuyao.aicubes.cn';
const dateText = `${Number(date.slice(0, 4))}年${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
const query = arg('--query', `${dateText}涨停股，股票代码，股票简称，涨停原因，涨停原因类别，首次涨停时间，最终涨停时间，连续涨停天数，所属概念`);
const resultUrl = `https://www.iwencai.com/screener/result?w=${encodeURIComponent(query)}&querytype=stock`;
const marketPhase = cacheMarketPhase(date);
if (marketPhase === 'future') throw new Error(`不能采集未来交易日：${date}`);

const normalizeHeader = (value) => String(value ?? '').replace(/\s+/g, '').replace(/\[.*?\]/g, '');
const pick = (row, pattern) => {
  const key = Object.keys(row).find((name) => pattern.test(normalizeHeader(name)));
  return key ? row[key] : null;
};
const codeOf = (row) => String(pick(row, /股票代码|证券代码|代码/) ?? '').match(/\d{6}/)?.[0] ?? '';
const nameOf = (row) => String(pick(row, /股票简称|证券简称|简称|名称/) ?? '').trim();
const eligible = (row) => {
  const code = codeOf(row);
  const name = nameOf(row).toUpperCase();
  return code && !/^(4|8|92)/.test(code) && !name.includes('ST');
};

async function apiGet(endpoint, params = {}) {
  const url = new URL(endpoint, apiBase);
  for (const [name, value] of Object.entries(params)) if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    headers: { 'X-api-key': apiKey, accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`同花顺金融数据API HTTP ${response.status}`);
  const payload = await response.json();
  if (Number(payload.code) !== 0) throw new Error(`同花顺金融数据API ${payload.code}：${payload.message ?? '调用失败'}`);
  return payload;
}

async function collectByApi() {
  const dateMs = Date.parse(`${date}T00:00:00+08:00`);
  const pages = [];
  let totalPages = 1;
  for (let page = 1; page <= totalPages; page += 1) {
    const payload = await apiGet('/api/a-share/special-data/limit-up-pool', {
      date_ms: dateMs,
      page,
      size: 200,
      sort_field: 'limit_up_time',
      sort_dir: 'asc',
    });
    pages.push(payload);
    totalPages = Number(payload.data?.pagination?.pages ?? 1);
  }
  const sourceRows = pages.flatMap((payload) => payload.data?.item ?? []);
  const rows = sourceRows
    .filter((row) => row.ticker && !/^(4|8|92)/.test(String(row.ticker)) && !row.is_st && !String(row.name ?? '').toUpperCase().includes('ST'))
    .map((row) => ({
      code: String(row.ticker),
      thscode: row.thscode ?? null,
      name: row.name ?? '',
      reason: row.limit_up_reason ?? null,
      reasonCategory: null,
      firstLimit: row.limit_up_time ?? null,
      finalLimit: null,
      board: row.continue_day_text ?? null,
      continueDayCount: row.continue_day_cnt ?? null,
      sealMoney: row.seal_money ?? null,
      maxSealMoney: row.max_seal_money ?? null,
      lastPrice: row.last_price ?? null,
      changeRatePct: row.price_change_ratio_pct ?? null,
      raw: row,
    }));

  let anomalyStatus = 'historical_unsupported';
  let anomalyPayload = null;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  if (date === today) {
    try {
      anomalyPayload = await apiGet('/api/a-share/special-data/anomaly-analysis-list', { tag_codes: 'LIMIT_UP' });
      anomalyStatus = 'complete';
      await writeJsonAtomic(output.anomalies, {
        schemaVersion: '1.0',
        tradeDate: date,
        source: '同花顺金融数据API/个股异动原因',
        fetchedAt: new Date().toISOString(),
        rows: anomalyPayload.data?.item ?? [],
      });
    } catch (error) {
      anomalyStatus = `partial: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const fetchedAt = new Date().toISOString();
  await mkdir(path.join(output.dir, 'raw'), { recursive: true });
  await writeJsonAtomic(path.join(output.dir, 'raw', `limit-up-${Date.now()}.json`), pages);
  await writeJsonAtomic(output.data, {
    schemaVersion: '1.0',
    tradeDate: date,
    source: '同花顺金融数据API/涨停股票池',
    endpoint: '/api/a-share/special-data/limit-up-pool',
    fetchedAt,
    resultCount: sourceRows.length,
    filteredCount: rows.length,
    rows,
  });
  await writeJsonAtomic(output.manifest, {
    schemaVersion: '1.0',
    tradeDate: date,
    source: '同花顺金融数据API',
    status: 'complete',
    marketPhase,
    finalizedAt: marketPhase === 'final' ? fetchedAt : null,
    collectedAt: fetchedAt,
    endpoint: '/api/a-share/special-data/limit-up-pool',
    pages: pages.length,
    resultCount: sourceRows.length,
    filteredCount: rows.length,
    anomalyStatus,
    cacheFile: 'fallback.json',
    rawDirectory: 'raw/',
  });
  console.log(`[问财API采集完成] ${date}：过滤后${rows.length}只；异动解析=${anomalyStatus}`);
}

if (apiKey) {
  await collectByApi();
} else {
  let browser;
  try {
  browser = await connectCdpPage({ debugPort, urlIncludes: 'iwencai.com', initialUrl: 'https://www.iwencai.com/screener' });
  await browser.navigate(resultUrl);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const text = await browser.evaluate('document.body?.innerText ?? ""');
    if (/查询结果|选股结果|共\s*\d+\s*只|股票简称|涨停原因/.test(text) || /问财登录|短信登录|密码登录/.test(text)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const raw = await browser.evaluate(`(() => {
    const clean = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
    const tables = Array.from(document.querySelectorAll('table')).map((table) => {
      const headers = Array.from(table.querySelectorAll('thead th')).map((cell) => clean(cell.innerText || cell.textContent));
      const rows = Array.from(table.querySelectorAll('tbody tr')).map((tr) => {
        const cells = Array.from(tr.querySelectorAll('td')).map((cell) => clean(cell.innerText || cell.textContent));
        return Object.fromEntries(cells.map((value, index) => [headers[index] || 'field_' + index, value]));
      }).filter((row) => Object.values(row).some(Boolean));
      return { headers, rows };
    }).filter((table) => table.headers.length || table.rows.length);
    const roleRows = Array.from(document.querySelectorAll('[role="row"]')).map((row) =>
      Array.from(row.querySelectorAll('[role="columnheader"],[role="cell"],[role="gridcell"]')).map((cell) => clean(cell.innerText || cell.textContent))
    ).filter((row) => row.length);
    return {
      url: location.href,
      title: document.title,
      fetchedAt: new Date().toISOString(),
      text: clean(document.body?.innerText ?? ''),
      tables,
      roleRows,
    };
  })()`);

  const candidateTables = [...(raw.tables ?? [])];
  if ((raw.roleRows ?? []).length > 1) {
    const [headers, ...rows] = raw.roleRows;
    candidateTables.push({
      headers,
      rows: rows.map((cells) => Object.fromEntries(cells.map((value, index) => [headers[index] || `field_${index}`, value]))),
    });
  }
  const selected = candidateTables
    .filter((table) => table.rows.length)
    .sort((left, right) => {
      const score = (table) => table.headers.filter((header) => /股票|代码|简称|涨停原因/.test(header)).length * 100 + table.rows.length;
      return score(right) - score(left);
    })[0];
  const sourceRows = selected?.rows ?? [];
  const rows = sourceRows.filter(eligible).map((row) => ({
    code: codeOf(row),
    name: nameOf(row),
    reason: pick(row, /涨停原因(?!类别)|涨停原因/) ?? null,
    reasonCategory: pick(row, /涨停原因类别|涨停类型/) ?? null,
    firstLimit: pick(row, /首次涨停时间|首次封板时间/) ?? null,
    finalLimit: pick(row, /最终涨停时间|最终封板时间/) ?? null,
    board: pick(row, /连续涨停天数|几天几板|连板/) ?? null,
    concepts: pick(row, /所属概念|概念/) ?? null,
    raw: row,
  }));
  const loginRequired = /问财登录|短信登录|密码登录/.test(raw.text ?? '');
  const status = rows.length > 0 && !loginRequired ? 'complete' : 'partial';
  await mkdir(path.join(output.dir, 'raw'), { recursive: true });
  await writeJsonAtomic(path.join(output.dir, 'raw', `query-${Date.now()}.json`), { query, ...raw });
  await writeJsonAtomic(output.data, {
    schemaVersion: '1.0',
    tradeDate: date,
    source: '同花顺问财浏览器采集',
    query,
    url: raw.url,
    fetchedAt: raw.fetchedAt,
    resultCount: sourceRows.length,
    filteredCount: rows.length,
    rows,
  });
  await writeJsonAtomic(output.manifest, {
    schemaVersion: '1.0',
    tradeDate: date,
    source: '同花顺问财浏览器采集',
    status,
    marketPhase,
    finalizedAt: marketPhase === 'final' ? raw.fetchedAt : null,
    query,
    collectedAt: raw.fetchedAt,
    loginRequired,
    resultCount: sourceRows.length,
    filteredCount: rows.length,
    cacheFile: 'fallback.json',
    rawDirectory: 'raw/',
  });
  console.log(`[问财采集${status === 'complete' ? '完成' : '不完整'}] ${date}：过滤后${rows.length}只`);
  if (loginRequired) console.log('问财页面要求登录；请在专用浏览器完成登录后重新采集。');
  } finally {
    browser?.close();
  }
}

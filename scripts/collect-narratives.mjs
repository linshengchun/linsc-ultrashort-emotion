import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_CACHE_ROOT,
  cacheMarketPhase,
  completeManifest,
  fileExists,
  ftsharePaths,
  jiuyangPaths,
} from './data-cache-paths.mjs';
import { connectCdpPage } from './cdp-page.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const allArgs = (name) => args.flatMap((value, index) => (value === name && args[index + 1] ? [args[index + 1]] : []));
const date = arg('--date', new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }));
const cacheRoot = arg('--cache-root', DEFAULT_CACHE_ROOT);
const canonical = jiuyangPaths(date, cacheRoot);
const outputDir = arg('--output-dir', canonical.dir);
const objectivePath = arg('--objective', ftsharePaths(date, cacheRoot).data);
const cookieFile = arg('--cookie-file', process.env.JIUYANG_COOKIE_FILE ?? path.join('.local', 'session', 'jiuyangongshe-cookie.txt'));
const timeoutMs = Number(arg('--timeout-ms', '20000'));
const delayMs = Number(arg('--delay-ms', '2500'));
const maxDetailPages = Math.max(0, Number(arg('--max-detail-pages', '120')) || 0);
const debugPort = Number(arg('--debug-port', process.env.LINSC_MARKET_BROWSER_PORT ?? '0'));
const refresh = args.includes('--refresh');
const marketPhase = cacheMarketPhase(date);

if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`日期格式错误：${date}，应为YYYY-MM-DD`);

const cacheFile = path.join(outputDir, 'normalized.json');
const manifestFile = path.join(outputDir, 'manifest.json');
if (!refresh && allArgs('--url').length === 0 && await completeManifest(manifestFile, date) && await fileExists(cacheFile)) {
  console.log(`[韭研缓存命中] ${date}：${cacheFile}`);
  process.exit(0);
}

const defaultPages = [
  { kind: 'daily_action', url: `https://www.jiuyangongshe.com/action/${date}` },
  { kind: 'homepage', url: 'https://www.jiuyangongshe.com/' },
];
const requestedUrls = allArgs('--url').map((url) => ({ kind: 'priority_custom', url }));
const pagesToFetch = [...requestedUrls, ...defaultPages].filter(
  (page, index, list) => list.findIndex((item) => item.url === page.url) === index,
);

const decodeEntities = (value) =>
  value
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");

const visibleText = (html) =>
  decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<template[\s\S]*?<\/template>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );

const pageTitle = (html) => {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? visibleText(match[1]) : '';
};

const links = (html, baseUrl) => {
  const result = [];
  const pattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    let href;
    try {
      href = new URL(match[1], baseUrl).href;
    } catch {
      continue;
    }
    if (!/^https?:\/\//i.test(href)) continue;
    result.push({ href, text: visibleText(match[2]).slice(0, 300) });
  }
  return result.slice(0, 1000);
};

const hash = (value) => createHash('sha256').update(value).digest('hex');
const safeName = (value) => value.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60) || 'page';
let cookieHeader = cookieFile ? (await readFile(cookieFile, 'utf8').catch(() => '')).trim() : '';
let cdpBrowser = null;
let loginVerified = false;
const structured = { articles: [], actions: [], stockSearch: [], pages: [] };
const collectBrowserSnapshot = async (browser, url, kind) => {
  await browser.navigate(url);
  await new Promise((resolve) => setTimeout(resolve, 700));
  const browserKind = JSON.stringify(kind);
  return browser.evaluate(`(async () => {
    const data = window.__NUXT__?.data?.[0] || {};
    const visibleLogin = [...document.querySelectorAll('a,button')].some((element) => element.offsetParent !== null && /登录注册/.test(element.innerText || ''));
    const context = window.__NUXT__?.state?.context || {};
    const contextKeys = Object.keys(context);
    const loggedIn = !visibleLogin && (contextKeys.some((key) => /user|member|account|login/i.test(key)) || Boolean(window.__NUXT__?.state?.admin));
    const stock = (value) => {
      if (!value || typeof value !== 'object') return null;
      const code = String(value.code ?? value.stock_code ?? value.symbol ?? '').replace(/\\D/g, '').slice(-6);
      const name = String(value.name ?? value.stock_name ?? value.sec_name ?? '').trim();
      const stockId = value.stock_id ?? value.stockId ?? null;
      return code || name ? { code, name, stockId } : null;
    };
    const article = (value) => {
      if (!value || typeof value !== 'object') return null;
      const stocks = (Array.isArray(value.stock_list) ? value.stock_list : Array.isArray(value.stockList) ? value.stockList : []).map(stock).filter(Boolean);
      const articleId = String(value.article_id ?? value.articleId ?? value.id ?? '').trim();
      const title = String(value.title ?? '').trim();
      const content = String(value.content ?? value.text ?? value.summary ?? '').trim();
      return articleId || title || content ? { articleId, title, content, createTime: value.create_time ?? value.createTime ?? null, syncTime: value.sync_time ?? value.syncTime ?? null, stockList: stocks, sourceUrl: articleId ? '/a/' + articleId : null } : null;
    };
    const action = (value, fieldId, fieldTitle) => {
      if (!value || typeof value !== 'object') return null;
      const stocks = [
        ...(Array.isArray(value.stock_list) ? value.stock_list : []),
        ...(Array.isArray(value.stockList) ? value.stockList : []),
        ...(value.stock ? [value.stock] : []),
        value.article,
        value.article?.action_info,
        value,
      ].map(stock).filter(Boolean);
      const uniqueStocks = [...new Map(stocks.map((item) => [item.code + '|' + item.name, item])).values()];
      const text = String(value.content ?? value.expound ?? value.reason ?? value.summary ?? value.text ?? value.article?.action_info?.expound ?? '').trim();
      const title = String(value.title ?? value.name ?? value.action_name ?? value.article?.title ?? '').trim();
      return text || title || uniqueStocks.length ? { actionId: String(value.action_id ?? value.id ?? value.article?.action_info?.action_info_id ?? '').trim(), actionFieldId: String(value.action_field_id ?? value.article?.action_info?.action_field_id ?? fieldId ?? '').trim(), actionFieldTitle: fieldTitle || '', title, text, createTime: value.create_time ?? value.publish_time ?? value.action_time ?? value.time ?? value.article?.action_info?.create_time ?? value.article?.create_time ?? null, stockList: uniqueStocks } : null;
    };
    const articles = ${browserKind} === 'homepage' && Array.isArray(data.list) ? data.list.map(article).filter(Boolean) : [];
    const fields = Array.isArray(data.actionFieldList) ? data.actionFieldList : [];
    const manager = window.$nuxt?.$root?.$options?.context?.app?.ApiManager;
    if (${browserKind} === 'daily_action' && manager?.post) {
      for (const group of fields) {
        if (!group.action_field_id) continue;
        try {
          const response = await manager.post({ url: '/api/v1/action/list', params: { action_field_id: group.action_field_id, sort_price: 0, sort_range: 0, sort_time: 0, pc: 1, start: 1, limit: 999 }, headers: { 'Content-Type': 'application/json', platform: 3 } });
          group.list = Array.isArray(response?.data) ? response.data : [];
        } catch {}
      }
    }
    const actions = [];
    for (const group of fields) {
      const fieldId = group.action_field_id ?? group.id ?? '';
      const fieldTitle = group.title ?? group.name ?? group.action_field_name ?? '';
      for (const item of (Array.isArray(group.list) ? group.list : [])) {
        const value = action(item, fieldId, fieldTitle);
        if (value) actions.push(value);
      }
    }
    for (const item of (Array.isArray(data.recommendActionList) ? data.recommendActionList : [])) {
      const value = action(item, item.action_field_id ?? 'recommend', '推荐异动');
      if (value) actions.push(value);
    }
    return { kind: ${browserKind}, url: location.href, loggedIn, articles, actions, pageKeys: Object.keys(data), bodyText: document.body.innerText.slice(0, 8000) };
  })()`);
};

if (debugPort > 0) {
  try {
    cdpBrowser = await connectCdpPage({
      debugPort,
      urlIncludes: 'jiuyangongshe.com',
      initialUrl: 'https://www.jiuyangongshe.com/',
    });
    await cdpBrowser.call('Network.enable');
    const result = await cdpBrowser.call('Network.getCookies', { urls: ['https://www.jiuyangongshe.com/'] });
    cookieHeader = (result.cookies ?? [])
      .filter((cookie) => String(cookie.domain).includes('jiuyangongshe.com'))
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
    const actionSnapshot = await collectBrowserSnapshot(cdpBrowser, `https://www.jiuyangongshe.com/action/${date}`, 'daily_action');
    const homeSnapshot = await collectBrowserSnapshot(cdpBrowser, 'https://www.jiuyangongshe.com/', 'homepage');
    loginVerified = Boolean(actionSnapshot.loggedIn || homeSnapshot.loggedIn);
    structured.actions.push(...actionSnapshot.actions);
    structured.articles.push(...homeSnapshot.articles);
    structured.pages.push({ kind: 'daily_action', url: actionSnapshot.url, loggedIn: actionSnapshot.loggedIn, pageKeys: actionSnapshot.pageKeys });
    structured.pages.push({ kind: 'homepage', url: homeSnapshot.url, loggedIn: homeSnapshot.loggedIn, pageKeys: homeSnapshot.pageKeys });
  } catch {
    cdpBrowser?.close();
    cdpBrowser = null;
  }
}

async function fetchPage(page) {
  const fetchedAt = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(page.url, {
      signal: controller.signal,
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': 'LINSC-NarrativeCollector/1.0 (personal research)',
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
      },
    });
    const html = await response.text();
    const contentHash = hash(html);
    const visible = visibleText(html);
    const rateLimited = response.status === 403 || response.status === 429 || /查阅次数.*上限|访问过于频繁|请求过于频繁|验证码/i.test(visible);
    return {
      kind: page.kind,
      url: page.url,
      fetchedAt,
      status: response.status,
      ok: response.ok && !rateLimited,
      contentType: response.headers.get('content-type') ?? '',
      contentHash,
      title: pageTitle(html),
      text: visible,
      links: links(html, page.url),
      rawHtml: html,
      error: rateLimited ? 'access_limited' : response.ok ? null : `HTTP ${response.status}`,
      rateLimited,
    };
  } catch (error) {
    return {
      kind: page.kind,
      url: page.url,
      fetchedAt,
      status: null,
      ok: false,
      contentType: '',
      contentHash: null,
      title: '',
      text: '',
      links: [],
      rawHtml: '',
      error: error instanceof Error ? error.message : String(error),
      rateLimited: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
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
const nameOf = (row) => String(field(row, ['name', 'stock_name', 'sec_name', '证券简称', '股票简称', '名称']) ?? '');
const eligibleStock = (code, name) => {
  const normalizedName = String(name ?? '').toUpperCase();
  return code && !/^(4|8|92)/.test(code) && !normalizedName.includes('ST');
};

const normalizeStock = (value) => {
  if (!value || typeof value !== 'object') return null;
  const rawCode = field(value, ['code', 'stock_code', 'symbol', '证券代码', '股票代码']);
  const code = String(rawCode ?? '').replace(/\D/g, '').slice(-6);
  const name = String(field(value, ['name', 'stock_name', 'sec_name', '证券简称', '股票简称', '名称']) ?? '').trim();
  return code || name ? { code, name, stockId: field(value, ['stock_id', 'stockId']) ?? null } : null;
};

const compactArticle = (article) => {
  if (!article || typeof article !== 'object') return null;
  const stocks = (Array.isArray(article.stock_list) ? article.stock_list : Array.isArray(article.stockList) ? article.stockList : [])
    .map(normalizeStock).filter(Boolean);
  const articleId = String(article.article_id ?? article.articleId ?? article.id ?? '').trim();
  const title = String(article.title ?? '').trim();
  const content = String(article.content ?? article.text ?? article.summary ?? '').trim();
  if (!articleId && !title && !content) return null;
  return {
    articleId,
    title,
    content,
    createTime: article.create_time ?? article.createTime ?? null,
    syncTime: article.sync_time ?? article.syncTime ?? null,
    stockList: stocks,
    sourceUrl: articleId ? `https://www.jiuyangongshe.com/a/${articleId}` : null,
  };
};

const compactAction = (action, fieldId = null, fieldTitle = '') => {
  if (!action || typeof action !== 'object') return null;
  const stocks = [
    ...(Array.isArray(action.stock_list) ? action.stock_list : []),
    ...(Array.isArray(action.stockList) ? action.stockList : []),
    ...(action.stock ? [action.stock] : []),
    action.article,
    action.article?.action_info,
  ].map(normalizeStock).filter(Boolean);
  const directStock = normalizeStock(action);
  if (directStock) stocks.push(directStock);
  const uniqueStocks = [...new Map(stocks.filter((stock) => stock.code || stock.name).map((stock) => [`${stock.code}|${stock.name}`, stock])).values()];
  const text = String(action.content ?? action.expound ?? action.reason ?? action.summary ?? action.text ?? action.article?.action_info?.expound ?? '').trim();
  const title = String(action.title ?? action.name ?? action.action_name ?? action.article?.title ?? '').trim();
  if (!text && !title && !uniqueStocks.length) return null;
  return {
    actionId: String(action.actionId ?? action.action_id ?? action.id ?? action.article?.action_info?.action_info_id ?? '').trim(),
    actionFieldId: String(action.actionFieldId ?? action.action_field_id ?? action.article?.action_info?.action_field_id ?? fieldId ?? '').trim(),
    actionFieldTitle: fieldTitle,
    title,
    text,
    createTime: action.createTime ?? action.create_time ?? action.publish_time ?? action.action_time ?? action.time ?? action.article?.action_info?.create_time ?? action.article?.create_time ?? null,
    stockList: uniqueStocks,
  };
};

async function writeJsonAtomic(file, value) {
  const temp = `${file}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temp, file);
}

await mkdir(path.join(outputDir, 'raw'), { recursive: true });
const previous = await readJson(cacheFile, { schemaVersion: '1.0', pages: [], eventCards: [], propagation: [] });
const objective = await readJson(objectivePath, null);
const objectiveStocks = recordsFrom(objective?.stocks);
const nameByCode = new Map(objectiveStocks.map((row) => [codeOf(row), nameOf(row)]));
const priorityStocks = recordsFrom(objective?.limitUp)
  .filter((row) => String(field(row, ['status']) ?? 'limit_up') === 'limit_up')
  .map((row) => ({
    code: codeOf(row),
    name: nameOf(row) || nameByCode.get(codeOf(row)) || '',
    firstLimitUpTime: field(row, ['first_limit_up_time', 'first_limit_time']) ?? null,
    breakCount: field(row, ['limit_up_break_count', 'break_count']) ?? null,
  }))
  .filter((row) => eligibleStock(row.code, row.name))
  .filter((row, index, list) => list.findIndex((item) => item.code === row.code) === index);

const fetched = [];
for (const [index, page] of pagesToFetch.entries()) {
  const result = await fetchPage(page);
  fetched.push(result);
  if (result.rateLimited) break;
  if (index < pagesToFetch.length - 1 && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
}

const detailCandidates = fetched
  .filter((page) => page.ok)
  .flatMap((page) => page.links)
  .filter((link) => /jiuyangongshe\.com\/a\//i.test(link.href))
  .map((link) => ({
    ...link,
    stocks: priorityStocks.filter((stock) => link.text.includes(stock.name) || link.text.includes(stock.code)),
  }))
  .filter((link) => link.stocks.length > 0)
  .filter((link, index, list) => list.findIndex((item) => item.href === link.href) === index)
  .slice(0, maxDetailPages);

const structuredArticles = structured.articles.map(compactArticle).filter(Boolean);
const structuredActions = structured.actions.map((item) => compactAction(item, item.actionFieldId, item.actionFieldTitle)).filter(Boolean);
const structuredDetailCandidates = structuredArticles
  .filter((article) => article.articleId && article.stockList.some((articleStock) => priorityStocks.some((stock) => stock.code === articleStock.code || (stock.name && stock.name === articleStock.name))))
  .map((article) => ({
    href: article.sourceUrl,
    text: article.title,
    stocks: priorityStocks.filter((stock) => article.stockList.some((articleStock) => articleStock.code === stock.code || (stock.name && stock.name === articleStock.name))),
    article,
  }));
const allDetailCandidates = [...structuredDetailCandidates, ...detailCandidates]
  .filter((link, index, list) => list.findIndex((item) => item.href === link.href) === index)
  .slice(0, maxDetailPages);

for (const detail of allDetailCandidates) {
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  const result = await fetchPage({ kind: 'priority_stock_detail', url: detail.href });
  result.stockHints = detail.stocks;
  result.articleId = detail.article?.articleId ?? null;
  result.articleTitle = detail.article?.title ?? null;
  fetched.push(result);
  if (result.rateLimited) break;
}

cdpBrowser?.close();
cdpBrowser = null;

const normalizedPages = [];

for (const page of fetched) {
  let rawPath = null;
  if (page.rawHtml) {
    rawPath = path.join('raw', `${safeName(page.kind)}-${page.contentHash.slice(0, 16)}.html`).replaceAll('\\', '/');
    await writeFile(path.join(outputDir, rawPath), page.rawHtml, 'utf8');
  }
  const { rawHtml: _rawHtml, ...normalized } = page;
  normalizedPages.push({ ...normalized, rawPath, eventCards: [] });
}

const pageKey = (page) => `${page.url}|${page.contentHash ?? page.error ?? 'failed'}`;
const successfulUrls = new Set(normalizedPages.filter((page) => page.ok).map((page) => page.url));
const mergedPages = new Map(
  (previous.pages ?? [])
    .filter((page) => !(successfulUrls.has(page.url) && !page.ok))
    .map((page) => [pageKey(page), page]),
);
for (const page of normalizedPages) mergedPages.set(pageKey(page), page);

const cache = {
  schemaVersion: '1.0',
  tradeDate: date,
  source: '韭研公社',
  collectedAt: new Date().toISOString(),
  collectionMode: loginVerified ? 'authenticated-pages-incremental' : 'public-pages-incremental',
  authenticatedSessionSupplied: loginVerified,
  loginVerified,
  requestedPages: pagesToFetch,
  priorityStocks,
  currentPages: normalizedPages,
  pages: [...mergedPages.values()],
  articles: structuredArticles,
  actions: structuredActions,
  eventCards: previous.eventCards ?? [],
  propagation: previous.propagation ?? [],
  extractionStatus: 'pending',
  note: '原始页面与结构化页面缓存分离；事件卡由后续事件提取步骤写入，不覆盖原始内容。',
};

const pageText = fetched.map((page) => page.text ?? '').join('\n');
const actionCodes = new Set(structuredActions.flatMap((action) => action.stockList.map((stock) => stock.code).filter(Boolean)));
const articleCodes = new Set(structuredArticles.flatMap((article) => article.stockList.map((stock) => stock.code).filter(Boolean)));
const structuredSearchCompleted = loginVerified && structured.pages.some((page) => page.kind === 'daily_action');
cache.coverageAttempts = priorityStocks.map((stock) => ({
  code: stock.code,
  name: stock.name,
  searched: structuredSearchCompleted,
  coveredByAction: actionCodes.has(stock.code),
  coveredByArticle: articleCodes.has(stock.code) || pageText.includes(stock.code) || (stock.name && pageText.includes(stock.name)),
}));

await writeJsonAtomic(cacheFile, cache);
const successful = fetched.filter((page) => page.ok).length;
const rateLimited = fetched.some((page) => page.rateLimited);
const collectionStatus = successful > 0 && !rateLimited && (loginVerified || priorityStocks.length === 0) ? 'complete' : 'partial';
await writeJsonAtomic(manifestFile, {
  schemaVersion: '1.0',
  tradeDate: date,
  source: '韭研公社',
  status: collectionStatus,
  marketPhase,
  finalizedAt: marketPhase === 'final' ? cache.collectedAt : null,
  collectedAt: cache.collectedAt,
  authenticatedSessionSupplied: loginVerified,
  loginVerified,
  requested: pagesToFetch.length,
  priorityStocks: priorityStocks.length,
  fetched: fetched.length,
  successful,
  failed: fetched.filter((page) => !page.ok).length,
  rateLimited,
  cacheFile: 'normalized.json',
  rawDirectory: 'raw/',
  coverageAttempts: cache.coverageAttempts.length,
  searchedPriorityStocks: cache.coverageAttempts.filter((item) => item.searched).length,
  actionCoveredPriorityStocks: cache.coverageAttempts.filter((item) => item.coveredByAction).length,
  articleCoveredPriorityStocks: cache.coverageAttempts.filter((item) => item.coveredByArticle).length,
});

console.log(`Saved narrative cache: ${cacheFile}`);
console.log(`Fetched ${fetched.filter((page) => page.ok).length}/${fetched.length} pages; event extraction remains pending.`);

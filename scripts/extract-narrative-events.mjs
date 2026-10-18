import { createHash } from 'node:crypto';
import { DEFAULT_CACHE_ROOT, assertTradeDate, jiuyangPaths, readJson, writeJsonAtomic } from './data-cache-paths.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const date = assertTradeDate(arg('--date', new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })));
const cacheRoot = arg('--cache-root', DEFAULT_CACHE_ROOT);
const paths = jiuyangPaths(date, cacheRoot);
const cache = await readJson(paths.data, null);
if (!cache) throw new Error(`缺少韭研缓存：${paths.data}`);

const hash = (value) => createHash('sha256').update(value).digest('hex');
const sentences = (text) => String(text ?? '')
  .split(/(?<=[。！？；!?])|\s{2,}/)
  .map((value) => value.trim())
  .filter((value) => value.length >= 8 && value.length <= 1200);
const snippetsFor = (page, stock) => {
  const units = sentences(page.text);
  const snippets = [];
  for (let index = 0; index < units.length; index += 1) {
    if (!units[index].includes(stock.name) && !units[index].includes(stock.code)) continue;
    const combined = units.slice(Math.max(0, index - 1), Math.min(units.length, index + 2)).join(' ').slice(0, 1600);
    if (combined && !snippets.includes(combined)) snippets.push(combined);
    if (snippets.length >= 8) break;
  }
  return snippets;
};
const sourceType = (page) => page.kind === 'daily_action' || /异动解析/.test(`${page.title} ${page.text}`)
  ? '个股异动解析'
  : page.kind === 'priority_stock_detail'
    ? '个股或板块帖子'
    : '页面索引片段';
const publishedAtFrom = (page, snippets) => {
  const matches = [...`${page.title ?? ''} ${snippets.join(' ')}`.matchAll(/20\d{2}[-./年]\d{1,2}[-./月]\d{1,2}(?:日)?(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/g)];
  // Article pages place the publication time before later comment timestamps.
  // Using the last timestamp can move a D-day article into D+1 and wrongly discard it.
  const value = matches.at(0)?.[0];
  if (!value) return null;
  const normalized = value
    .replace('年', '-')
    .replace('月', '-')
    .replace('日', '')
    .replaceAll('.', '-')
    .replaceAll('/', '-');
  const [datePart, timePart = '00:00:00'] = normalized.split(/\s+/);
  const parsed = new Date(`${datePart.split('-').map((part, index) => index ? part.padStart(2, '0') : part).join('-')}T${timePart.length === 5 ? `${timePart}:00` : timePart}+08:00`);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
};

const cutoff = new Date(`${date}T23:59:59+08:00`).valueOf();
const parsePublishedAt = (value) => {
  if (!value) return null;
  const text = String(value).trim().replace('年', '-').replace('月', '-').replace('日', '').replaceAll('/', '-').replaceAll('.', '-');
  const parsed = new Date(/^\d{4}-\d{1,2}-\d{1,2}(?:\s|$)/.test(text) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(text) ? `${text}+08:00` : text);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
};
const snippetsFromText = (text) => sentences(text).slice(0, 8);
const stocksFrom = (record) => (Array.isArray(record.stockList) ? record.stockList : []).map((stock) => ({
  code: String(stock.code ?? '').replace(/\D/g, '').slice(-6),
  name: String(stock.name ?? '').trim(),
})).filter((stock) => stock.code || stock.name);
const explicitCards = [];
for (const action of cache.actions ?? []) {
  const publishedAt = parsePublishedAt(action.createTime) ?? new Date(`${date}T15:30:00+08:00`).toISOString();
  for (const stock of stocksFrom(action)) {
    const priority = (cache.priorityStocks ?? []).find((item) => item.code === stock.code || (stock.name && item.name === stock.name));
    if (!priority) continue;
    const evidenceSnippets = snippetsFromText([action.title, action.text].filter(Boolean).join('：'));
    if (!evidenceSnippets.length) continue;
    explicitCards.push({
      eventId: hash(`${priority.code}|action|${action.actionId}|${action.actionFieldId}|${action.title}`).slice(0, 24),
      tradeDate: date,
      stockCode: priority.code,
      stockName: priority.name,
      sourceType: '个股异动解析',
      eventText: evidenceSnippets.join('\n'),
      evidenceSnippets,
      eventKeywords: [],
      themeHints: [],
      mappingEvidence: evidenceSnippets[0],
      eventOccurredAt: null,
      firstPropagationAt: publishedAt,
      publishedAt,
      collectedAt: cache.collectedAt ?? null,
      availableAt: publishedAt,
      availableAtEvidence: '异动记录发布时间',
      expectationGap: null,
      catalystWindow: null,
      invalidationCondition: null,
      priceReaction: null,
      sourceUrl: `https://www.jiuyangongshe.com/action/${date}`,
      sourceTitle: action.actionFieldTitle || action.title || '异动解析',
      sourceContentHash: hash(evidenceSnippets.join('\n')),
      rawPath: null,
      extractionMethod: 'structured-action-v2',
    });
  }
}
for (const article of cache.articles ?? []) {
  const publishedAt = parsePublishedAt(article.createTime ?? article.syncTime);
  if (!publishedAt || Date.parse(publishedAt) > cutoff) continue;
  for (const stock of stocksFrom(article)) {
    const priority = (cache.priorityStocks ?? []).find((item) => item.code === stock.code || (stock.name && item.name === stock.name));
    if (!priority) continue;
    const evidenceSnippets = snippetsFromText([article.title, article.content].filter(Boolean).join('：'));
    if (!evidenceSnippets.length) continue;
    explicitCards.push({
      eventId: hash(`${priority.code}|article|${article.articleId}|${article.title}`).slice(0, 24),
      tradeDate: date,
      stockCode: priority.code,
      stockName: priority.name,
      sourceType: '个股或板块帖子',
      eventText: evidenceSnippets.join('\n'),
      evidenceSnippets,
      eventKeywords: [],
      themeHints: [],
      mappingEvidence: evidenceSnippets[0],
      eventOccurredAt: null,
      firstPropagationAt: publishedAt,
      publishedAt,
      collectedAt: cache.collectedAt ?? null,
      availableAt: publishedAt,
      availableAtEvidence: '帖子发布时间',
      expectationGap: null,
      catalystWindow: null,
      invalidationCondition: null,
      priceReaction: null,
      sourceUrl: article.sourceUrl ?? null,
      sourceTitle: article.title ?? '',
      sourceContentHash: hash(`${article.title}\n${article.content}`),
      rawPath: null,
      extractionMethod: 'structured-article-v2',
    });
  }
}

const explicitUrls = new Set((cache.articles ?? []).map((article) => article.sourceUrl).filter(Boolean));
if ((cache.actions ?? []).length) explicitUrls.add(`https://www.jiuyangongshe.com/action/${date}`);
const nextCards = [...explicitCards];
for (const page of cache.pages ?? []) {
  if (!page.ok || !page.text || !page.contentHash) continue;
  if (!['daily_action', 'priority_stock_detail', 'priority_custom'].includes(page.kind)) continue;
  if (explicitUrls.has(page.url)) continue;
  const hintedCodes = new Set((page.stockHints ?? []).map((stock) => stock.code));
  for (const stock of cache.priorityStocks ?? []) {
    if (!stock.name && !stock.code) continue;
    if (!hintedCodes.has(stock.code) && !page.text.includes(stock.name) && !page.text.includes(stock.code)) continue;
    const evidenceSnippets = snippetsFor(page, stock);
    if (!evidenceSnippets.length) continue;
    const publishedAt = page.kind === 'daily_action'
      ? publishedAtFrom(page, evidenceSnippets) ?? new Date(`${date}T15:30:00+08:00`).toISOString()
      : publishedAtFrom(page, evidenceSnippets);
    if (page.kind !== 'daily_action' && (!publishedAt || Date.parse(publishedAt) > cutoff)) continue;
    nextCards.push({
      eventId: hash(`${stock.code}|${page.url}|${publishedAt ?? 'unknown'}`).slice(0, 24),
      tradeDate: date,
      stockCode: stock.code,
      stockName: stock.name,
      sourceType: sourceType(page),
      eventText: evidenceSnippets.join('\n'),
      evidenceSnippets,
      eventKeywords: [],
      themeHints: [],
      mappingEvidence: evidenceSnippets[0],
      eventOccurredAt: null,
      firstPropagationAt: publishedAt,
      publishedAt,
      collectedAt: page.fetchedAt ?? cache.collectedAt ?? null,
      availableAt: publishedAt,
      availableAtEvidence: publishedAt ? '原文可见发布时间' : null,
      expectationGap: null,
      catalystWindow: null,
      invalidationCondition: null,
      priceReaction: null,
      sourceUrl: page.url,
      sourceTitle: page.title ?? '',
      sourceContentHash: page.contentHash,
      rawPath: page.rawPath ?? null,
      extractionMethod: 'deterministic-stock-mention-v1',
    });
  }
}

const merged = new Map(
  (cache.eventCards ?? [])
    .filter((card) => !['deterministic-stock-mention-v1', 'structured-action-v2', 'structured-article-v2'].includes(card.extractionMethod))
    .map((card) => [card.eventId, card]),
);
for (const card of nextCards) merged.set(card.eventId, card);
const eventCards = [...merged.values()];
const coveredCodes = new Set(eventCards.map((card) => card.stockCode));
const priorityCount = (cache.priorityStocks ?? []).length;
const coveredPriorityStocks = (cache.priorityStocks ?? []).filter((stock) => coveredCodes.has(stock.code)).length;
const searchedPriorityStocks = (cache.coverageAttempts ?? []).filter((item) => item.searched).length || priorityCount;
const noEvidenceStocks = (cache.priorityStocks ?? []).filter((stock) => !coveredCodes.has(stock.code));
const extractionStatus = priorityCount > 0 && searchedPriorityStocks === priorityCount && coveredPriorityStocks === priorityCount ? 'complete' : eventCards.length ? 'partial' : 'empty';
const extractedAt = new Date().toISOString();

await writeJsonAtomic(paths.data, {
  ...cache,
  eventCards,
  propagation: eventCards.map((card) => ({
    eventId: card.eventId,
    stockCode: card.stockCode,
    sourceUrl: card.sourceUrl,
    sourceType: card.sourceType,
    publishedAt: card.publishedAt,
    collectedAt: card.collectedAt,
  })),
  extractionStatus,
  extractedAt,
  extractionCoverage: {
    priorityStocks: priorityCount,
    searchedPriorityStocks,
    coveredPriorityStocks,
    noEvidenceStocks: noEvidenceStocks.map((stock) => ({ code: stock.code, name: stock.name })),
    eventCards: eventCards.length,
  },
});

const manifest = await readJson(paths.manifest, {});
await writeJsonAtomic(paths.manifest, {
  ...manifest,
  extractionStatus,
  extractedAt,
  priorityStocks: priorityCount,
  coveredPriorityStocks,
  searchedPriorityStocks,
  noEvidenceStocks: noEvidenceStocks.map((stock) => ({ code: stock.code, name: stock.name })),
  eventCards: eventCards.length,
});
console.log(`[韭研事件卡提取] ${date}：${eventCards.length}张，覆盖涨停优先股${coveredPriorityStocks}/${priorityCount}`);

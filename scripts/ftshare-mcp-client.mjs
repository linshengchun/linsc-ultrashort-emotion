const endpoint = process.env.FTSHARE_MCP_URL ?? 'https://market.ft.tech/gateway/mcp';
const apiKey = process.env.FTSHARE_API_KEY?.trim();

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function parseBody(text, contentType) {
  if (contentType.includes('application/json')) return JSON.parse(text);
  const messages = text.split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== '[DONE]')
    .map((line) => JSON.parse(line));
  if (!messages.length) throw new Error(`MCP返回无法解析：${text.slice(0, 200)}`);
  return messages.at(-1);
}

function decode(result) {
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
  if (!text) return result;
  try { return JSON.parse(text); } catch { return text; }
}

export async function createFtshareClient() {
  if (!apiKey) throw new Error('缺少FTSHARE_API_KEY。');
  let requestId = 0;
  let sessionId = '';
  let protocolVersion = '2025-11-25';

  async function rpc(method, params, notification = false) {
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: AbortSignal.timeout(60_000),
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        FTSHARE_API_KEY: apiKey,
        ...(sessionId ? { 'mcp-session-id': sessionId, 'MCP-Protocol-Version': protocolVersion } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', method, ...(notification ? {} : { id: ++requestId }), params }),
    });
    const text = notification || response.status === 202 ? '' : await response.text();
    if (!response.ok) throw new Error(`${method}失败：HTTP ${response.status} ${text.slice(0, 300)}`);
    sessionId = response.headers.get('mcp-session-id') ?? sessionId;
    if (notification || response.status === 202) return null;
    const message = parseBody(text, response.headers.get('content-type') ?? '');
    if (message.error) throw new Error(message.error.message ?? JSON.stringify(message.error));
    return message.result;
  }

  async function connect() {
    sessionId = '';
    const initialized = await rpc('initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'linsc-data-cache', version: '1.0.0' },
    });
    protocolVersion = initialized?.protocolVersion ?? protocolVersion;
    await rpc('notifications/initialized', undefined, true);
  }

  await connect();
  return {
    endpoint,
    async call(name, args) {
      let lastError;
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        try {
          const payload = decode(await rpc('tools/call', { name, arguments: args }));
          if (payload?.error) throw new Error(`${payload.error.code ?? 'TOOL_ERROR'}: ${payload.error.message ?? '调用失败'}`);
          return payload;
        } catch (error) {
          lastError = error;
          if (/HTTP 404|session/i.test(error.message)) await connect();
          if (attempt < 4) await sleep(attempt * 2000);
        }
      }
      throw lastError;
    },
  };
}

export async function callFtsharePaged(client, name, args, { pageSize = 100, maxPages = 400 } = {}) {
  const first = await client.call(name, { ...args, page: 1, page_size: pageSize });
  const pagination = first?.metadata?.pagination ?? {};
  const pages = Math.max(1, Math.min(maxPages, Number(pagination.pages) || 1));
  if (pages === 1 && pagination.supported !== true) return first;
  const payloads = [first];
  for (let page = 2; page <= pages; page += 1) {
    payloads.push(await client.call(name, { ...args, page, page_size: pageSize }));
  }
  const rows = payloads.flatMap((payload) => Array.isArray(payload?.data) ? payload.data : []);
  return {
    ...first,
    data: rows,
    metadata: {
      ...first.metadata,
      returned: rows.length,
      truncated: false,
      warnings: [],
      pagination: { ...pagination, page: pages, pages, has_more: false, supported: true },
    },
  };
}

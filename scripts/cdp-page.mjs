const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function debugBrowserReady(debugPort) {
  try {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function connectCdpPage({ debugPort, urlIncludes, initialUrl }) {
  const base = `http://127.0.0.1:${debugPort}`;
  const listResponse = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(3000) });
  if (!listResponse.ok) throw new Error(`浏览器调试端口不可用：HTTP ${listResponse.status}`);
  const targets = await listResponse.json();
  let target = targets.find((item) => item.type === 'page' && String(item.url).includes(urlIncludes));
  if (!target && initialUrl) {
    const created = await fetch(`${base}/json/new?${encodeURIComponent(initialUrl)}`, { method: 'PUT', signal: AbortSignal.timeout(3000) });
    if (created.ok) target = await created.json();
  }
  if (!target?.webSocketDebuggerUrl) throw new Error(`未找到${urlIncludes}浏览器页面`);

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let id = 0;
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const task = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) task.reject(new Error(message.error.message));
    else task.resolve(message.result ?? {});
  };
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error('无法连接浏览器调试页面'));
  });

  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const callId = ++id;
    pending.set(callId, { resolve, reject });
    socket.send(JSON.stringify({ id: callId, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? '页面脚本执行失败');
    return result.result?.value;
  };
  const navigate = async (url) => {
    await call('Page.enable');
    await call('Page.navigate', { url });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await wait(500);
      const ready = await evaluate('document.readyState');
      if (ready === 'complete') break;
    }
  };

  return { call, evaluate, navigate, close: () => socket.close(), target };
}

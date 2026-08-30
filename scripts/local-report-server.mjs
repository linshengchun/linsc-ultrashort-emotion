import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

const host = '127.0.0.1';
const port = Number(process.env.LINSC_LOCAL_GENERATOR_PORT ?? 4317);
let runningDate = null;

const json = (response, status, payload) => {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': response.requestOrigin ?? '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  });
  response.end(JSON.stringify(payload));
};

const validOrigin = (origin) => !origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00+08:00`));

const command = (program, args, label) => new Promise((resolve, reject) => {
  const child = spawn(program, args, {
    cwd: process.cwd(),
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', LLM_PROVIDER: 'codex' },
    stdio: 'inherit',
    windowsHide: true,
  });
  child.once('error', (error) => reject(new Error(`${label}无法启动：${error.message}`)));
  child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${label}失败，退出码 ${code}`)));
});

const pythonExecutable = () => {
  if (process.env.LINSC_PYTHON) return process.env.LINSC_PYTHON;
  if (process.platform === 'win32' && process.env.USERPROFILE) {
    const bundled = path.join(process.env.USERPROFILE, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe');
    if (existsSync(bundled)) return bundled;
  }
  return 'python';
};

const runPipeline = async (date) => {
  await command(process.execPath, ['scripts/fetch-objective.mjs', '--date', date], '行情取数');
  await command(process.execPath, ['scripts/generate-report.mjs', '--date', date, '--provider', 'codex'], 'Codex报告生成');
  await command(process.execPath, ['scripts/validate-reports.mjs'], '报告结构校验');
  await command(process.execPath, ['scripts/build-report-index.mjs'], '报告索引更新');
  const python = pythonExecutable();
  await command(python, ['scripts/render-report-pdf.py', '--date', date, '--output', path.join('public', 'reports', `${date}.pdf`)], 'PDF生成');
};

createServer(async (request, response) => {
  const origin = request.headers.origin ?? '';
  response.requestOrigin = validOrigin(origin) ? origin || '*' : 'null';
  if (!validOrigin(origin)) return json(response, 403, { ok: false, error: '只允许本机网页调用生成服务。' });
  if (request.method === 'OPTIONS') return json(response, 204, {});
  if (request.method === 'GET' && request.url === '/health') {
    return json(response, 200, { ok: true, provider: 'codex', runningDate });
  }
  if (request.method !== 'POST' || request.url !== '/generate') return json(response, 404, { ok: false, error: '接口不存在。' });
  if (runningDate) return json(response, 409, { ok: false, error: `${runningDate} 正在生成，请完成后再试。` });

  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16_384) return json(response, 413, { ok: false, error: '请求过大。' });
  }
  let date;
  try {
    date = JSON.parse(body).date;
  } catch {
    return json(response, 400, { ok: false, error: '请求格式错误。' });
  }
  if (!validDate(date)) return json(response, 400, { ok: false, error: '交易日必须使用 YYYY-MM-DD 格式。' });

  runningDate = date;
  try {
    await runPipeline(date);
    return json(response, 200, { ok: true, date, reportUrl: `/reports/${date}` });
  } catch (error) {
    return json(response, 500, { ok: false, error: error.message });
  } finally {
    runningDate = null;
  }
}).listen(port, host, () => {
  console.log(`LINSC本地Codex生成服务：http://${host}:${port}`);
});

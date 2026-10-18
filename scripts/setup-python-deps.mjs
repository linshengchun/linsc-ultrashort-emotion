import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const bundled = process.platform === 'win32' && process.env.USERPROFILE
  ? path.join(process.env.USERPROFILE, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe')
  : '';
const python = process.env.LINSC_PYTHON ?? (bundled && existsSync(bundled) ? bundled : 'python');

const child = spawn(python, [
  '-m', 'pip', 'install', '--disable-pip-version-check',
  '--target', path.join('work', 'python-deps'),
  '-r', 'requirements.txt',
], {
  cwd: process.cwd(),
  stdio: 'inherit',
  windowsHide: true,
});

child.once('error', (error) => {
  console.error(`Python依赖安装无法启动：${error.message}`);
  process.exitCode = 1;
});
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});

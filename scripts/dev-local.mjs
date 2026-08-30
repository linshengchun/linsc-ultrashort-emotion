import { spawn } from 'node:child_process';

const children = [
  spawn(process.execPath, ['scripts/local-report-server.mjs'], { stdio: 'inherit', windowsHide: true }),
  process.platform === 'win32'
    ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm run dev'], { stdio: 'inherit', windowsHide: true })
    : spawn('npm', ['run', 'dev'], { stdio: 'inherit' }),
];

let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
};

for (const child of children) {
  child.once('error', (error) => {
    console.error(error);
    stop(1);
  });
  child.once('exit', (code) => {
    if (!stopping && code !== null) stop(code);
  });
}

process.once('SIGINT', () => stop(0));
process.once('SIGTERM', () => stop(0));

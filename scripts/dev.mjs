import { spawn } from 'node:child_process';
import path from 'node:path';
import { root, runRust } from './rust.mjs';

const backend = runRust(['run']);
const client = spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', '5173', '--strictPort'], {
  cwd: path.join(root, 'client'), stdio: 'inherit', windowsHide: true,
});
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of [backend, client]) {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else child.kill();
  }
  process.exitCode = code;
}
for (const child of [backend, client]) {
  child.on('error', e => { console.error(e.message); stop(1); });
  child.on('exit', code => stop(code ?? 1));
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

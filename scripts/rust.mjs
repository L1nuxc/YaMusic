import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const root = fileURLToPath(new URL('../', import.meta.url));
export function networkEnvironment() {
  // Respect an explicit project setting. Otherwise use the user's existing
  // Windows system proxy for this child process only; never alter OS settings.
  const hasEnvProxy=['HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','https_proxy','http_proxy','all_proxy'].some(key=>process.env[key]);
  const envFile=path.join(root,'.env');
  const hasFileProxy=existsSync(envFile)&&/^\s*(?:HTTPS_PROXY|HTTP_PROXY|ALL_PROXY)\s*=/m.test(readFileSync(envFile,'utf8'));
  if(process.platform!=='win32'||hasEnvProxy||hasFileProxy) return {};
  try {
    const value=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$u=[uri]'https://api.deezer.com'; $p=[System.Net.WebRequest]::GetSystemWebProxy().GetProxy($u); if($p.AbsoluteUri -ne $u.AbsoluteUri){$p.AbsoluteUri}"],{encoding:'utf8',timeout:5000,windowsHide:true,stdio:['ignore','pipe','ignore']}).trim();
    if(!value) return {};
    const proxy=new URL(value); if(!['http:','https:'].includes(proxy.protocol)) return {};
    return {HTTPS_PROXY:value,HTTP_PROXY:value,CARGO_HTTP_PROXY:value,NO_PROXY:[process.env.NO_PROXY,'localhost','127.0.0.1','::1'].filter(Boolean).join(',')};
  } catch { return {}; }
}
export function runRust(args, options = {}) {
  const cargoHome = path.join(root, '.tools', 'cargo');
  const rustupHome = path.join(root, '.tools', 'rustup');
  const localCargo = path.join(cargoHome, 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
  const local = existsSync(localCargo);
  const separator=args.indexOf('--');
  const cargoArgs=separator<0?[...args,'--manifest-path',path.join(root,'backend','Cargo.toml')]:[...args.slice(0,separator),'--manifest-path',path.join(root,'backend','Cargo.toml'),...args.slice(separator)];
  return spawn(local ? localCargo : 'cargo', cargoArgs, {
    cwd: root, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, ...networkEnvironment(), ...(local ? { CARGO_HOME: cargoHome, RUSTUP_HOME: rustupHome, PATH: path.join(cargoHome, 'bin') + path.delimiter + process.env.PATH } : {}) },
    ...options,
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const child = runRust(process.argv.slice(2));
  child.on('error', e => { console.error('Не удалось запустить Cargo:', e.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}

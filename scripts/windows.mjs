import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const cargoHome=path.join(root,'.tools','cargo');
const localBin=path.join(cargoHome,'bin');
const env={...process.env};
const PATH=Object.keys(env).find(key=>key.toUpperCase()==='PATH')??'PATH';
env[PATH]=path.dirname(process.execPath)+path.delimiter+(env[PATH]??'');
if(existsSync(path.join(localBin,'cargo.exe'))){
  env.CARGO_HOME=cargoHome;
  env.RUSTUP_HOME=path.join(root,'.tools','rustup');
  env[PATH]=localBin+path.delimiter+env[PATH];
}
const cli=path.join(root,'node_modules','@tauri-apps','cli','tauri.js');
env.TAURI_SIGNING_PRIVATE_KEY ||= env.TAURI_SIGNING_PRIVATE_KEY_PATH;
const signed=Boolean(env.TAURI_SIGNING_PRIVATE_KEY);
if(signed!==Boolean(env.YAMUSIC_UPDATE_PUBLIC_KEY)){
  console.error('Для сборки с автообновлением задайте ключ публикации Tauri и YAMUSIC_UPDATE_PUBLIC_KEY.');
  process.exit(1);
}
const updateConfig=signed?['--config',JSON.stringify({
  bundle:{createUpdaterArtifacts:true},
  plugins:{updater:{pubkey:env.YAMUSIC_UPDATE_PUBLIC_KEY,windows:{installMode:'passive'}}},
})]:[];
const result=spawnSync(process.execPath,[cli,'build','--target','x86_64-pc-windows-msvc',...updateConfig,...process.argv.slice(2)],{cwd:root,env,stdio:'inherit'});
if(result.error)console.error(result.error.message);
process.exitCode=result.status??1;

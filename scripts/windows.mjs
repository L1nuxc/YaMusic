import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const cargoHome=path.join(root,'.tools','cargo');
const localBin=path.join(cargoHome,'bin');
const env={...process.env};
if(existsSync(path.join(localBin,'cargo.exe'))){
  env.CARGO_HOME=cargoHome;
  env.RUSTUP_HOME=path.join(root,'.tools','rustup');
  env.PATH=localBin+path.delimiter+env.PATH;
}
const cli=path.join(root,'node_modules','@tauri-apps','cli','tauri.js');
const result=spawnSync(process.execPath,[cli,'build','--target','x86_64-pc-windows-msvc',...process.argv.slice(2)],{cwd:root,env,stdio:'inherit'});
if(result.error)console.error(result.error.message);
process.exitCode=result.status??1;

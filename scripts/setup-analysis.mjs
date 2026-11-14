import {createHash} from 'node:crypto';
import {createReadStream,existsSync} from 'node:fs';
import {mkdir,rename,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {root,networkEnvironment} from './rust.mjs';

const revision='c28f2883575e590e04d3146ff0713c2448d691ba';
const modelHash='3fcff2c8824e7bcb83a983f2a49edab3b60cbcf4872ac70efee517355173bd1f';
const env={...process.env,...networkEnvironment()};
async function run(binary,args){await new Promise((resolve,reject)=>{const child=spawn(binary,args,{cwd:root,env,windowsHide:true,stdio:'inherit'});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`${binary} failed (${code})`)));});}
async function hash(file){const h=createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk);return h.digest('hex');}
async function download(url,file,expected){
  if(existsSync(file)&&(!expected||await hash(file)===expected))return;
  await mkdir(path.dirname(file),{recursive:true});const temp=file+'.download';
  const args=['--fail','--location','--retry','2','--silent','--show-error','--output',temp,url];
  const proxy=env.HTTPS_PROXY||env.https_proxy||env.ALL_PROXY||env.all_proxy;
  if(proxy)args.unshift('--proxy',proxy);
  try{await run(process.platform==='win32'?'curl.exe':'curl',args);if(expected&&await hash(temp)!==expected)throw new Error('Downloaded file checksum does not match the pinned model.');await rename(temp,file);}finally{await rm(temp,{force:true});}
}
if(process.arch!=='x64'||!['win32','linux'].includes(process.platform))throw new Error('Automatic setup supports Windows x64 and Linux x64. Set CLAP_MODEL_PATH and ORT_DYLIB_PATH for another platform.');
console.log('Preparing the pinned CPU CLAP model (34 MB)…');
await download(`https://huggingface.co/Xenova/clap-htsat-unfused/resolve/${revision}/onnx/audio_model_quantized.onnx`,path.join(root,'models/clap-audio-int8.onnx'),modelHash);
const windows=process.platform==='win32';const name=`onnxruntime-${windows?'win':'linux'}-x64-1.22.0`;
const destination=path.join(root,'.tools','onnxruntime');const library=path.join(destination,name,'lib',windows?'onnxruntime.dll':'libonnxruntime.so');
if(!existsSync(library)){
  const extension=windows?'zip':'tgz';const archive=path.join(root,'.tools',`${name}.${extension}`);
  console.log('Preparing Microsoft ONNX Runtime 1.22 CPU…');
  await download(`https://github.com/microsoft/onnxruntime/releases/download/v1.22.0/${name}.${extension}`,archive,windows?'174c616efc0271194488642a72f1a514e01487da4dfe84c49296d66e40ebe0da':undefined);
  await mkdir(destination,{recursive:true});
  if(windows)await run('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(root,'scripts','unpack-runtime.ps1'),'-Archive',archive,'-Destination',destination]);
  else await run('tar',['-xzf',archive,'-C',destination]);
}
console.log('CPU audio analysis is ready. Restart npm run dev.');

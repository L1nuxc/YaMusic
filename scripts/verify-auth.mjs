// Isolated HTTP authentication verification. Never uses the production bot token.
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, openSync, closeSync } from 'node:fs';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(path.join(root,'artifacts'),{recursive:true});
const scratch = mkdtempSync(path.join(root,'artifacts','auth-http-'));
const socket = createServer();
await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
const port = socket.address().port;
await new Promise(resolve=>socket.close(resolve));
const base = `http://127.0.0.1:${port}`;
const origin = 'https://auth-test.invalid';
const testToken = `test-only:${randomUUID()}`;
const dbPath = path.join(scratch,'test.db');
const log = openSync(path.join(scratch,'server.log'),'a');
const binary = process.env.AUTH_TEST_BINARY || path.join(root,'backend','target','debug',process.platform==='win32'?'yamusic-server.exe':'yamusic-server');
const child = spawn(binary,[],{cwd:root,windowsHide:true,stdio:['ignore',log,log],env:{...process.env,
  BIND_ADDRESS:`127.0.0.1:${port}`, DATABASE_URL:`sqlite://${dbPath.replaceAll('\\','/')}`,
  AUDIO_CACHE_DIR:path.join(scratch,'audio'), PUBLIC_ORIGIN:origin,
  TELEGRAM_BOT_TOKEN:testToken, TELEGRAM_BOT_USERNAME:'test_auth_bot',
  CLAP_MODEL_PATH:path.join(scratch,'disabled-analysis.onnx'), ANALYSIS_BACKFILL_LIMIT:'0',
}});
const exited = new Promise(resolve=>{child.once('exit',resolve);child.once('error',resolve);});
function signed(id,age=0) {
  const data={id,auth_date:Math.floor(Date.now()/1000)-age,first_name:'Auth fixture',username:`fixture_${id}`};
  const canonical=Object.keys(data).sort().map(k=>`${k}=${data[k]}`).join('\n');
  return {...data,hash:createHmac('sha256',createHash('sha256').update(testToken).digest()).update(canonical).digest('hex')};
}
async function request(endpoint,{method='GET',body,cookie,requestOrigin=origin,profile}={}) {
  return fetch(base+endpoint,{method,headers:{Origin:requestOrigin,...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...(profile?{'X-YaMusic-Profile':profile}:{})},body:body?JSON.stringify(body):undefined});
}
let db;
try {
  for(let i=0;;i++) {
    try {if((await fetch(base+'/api/health')).ok)break;}catch{}
    if(i>=100)throw new Error('Isolated server failed to start; inspect artifacts auth-http server.log');
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal((await request('/api/auth/me').then(r=>r.json())).user,null);
  const config=await request('/api/auth/config').then(r=>r.json());
  assert.equal(config.enabled,true);
  assert.equal(config.bot_username,'test_auth_bot');
  const first=signed(100001);
  assert.equal((await request('/api/auth/telegram',{method:'POST',body:{...first,first_name:'Forged'}})).status,401);
  assert.equal((await request('/api/auth/telegram',{method:'POST',body:signed(100003,301)})).status,401);
  assert.equal((await request('/api/auth/telegram',{method:'POST',body:signed(100004,-120)})).status,401);
  assert.equal((await request('/api/auth/telegram',{method:'POST',body:first,requestOrigin:'https://evil.invalid'})).status,401);
  const login=await request('/api/auth/telegram',{method:'POST',body:first});
  assert.equal(login.status,200);
  const cookieHeader=login.headers.get('set-cookie');
  for(const flag of ['HttpOnly','Secure','SameSite=Lax','Path=/'])assert.ok(cookieHeader.includes(flag));
  const firstCookie=cookieHeader.split(';')[0];
  assert.match(firstCookie,/^yamusic_session=[a-f0-9]{64}$/);
  assert.equal(login.headers.get('cache-control'),'no-store');
  const account=(await login.json()).user;
  assert.equal(account.telegram_id,100001);
  assert.equal((await request('/api/auth/me',{cookie:firstCookie}).then(r=>r.json())).user.id,account.id);
  assert.equal((await request('/api/auth/telegram',{method:'POST',body:first})).status,401,'signed login replay');
  const second=await request('/api/auth/telegram',{method:'POST',body:signed(100002)});
  assert.equal(second.status,200);
  const secondCookie=second.headers.get('set-cookie').split(';')[0];
  const other=(await second.json()).user;
  assert.notEqual(other.id,account.id);
  db=new DatabaseSync(dbPath);
  db.prepare("INSERT INTO catalog_artists(id,name,picture_url,data_json) VALUES (987,'Fixture artist','','{}')").run();
  db.prepare('INSERT INTO favorite_artists(user_id,artist_id,position) VALUES (?,987,0)').run(account.id);
  const profile='browser-profile-12345678';
  const own=await request('/api/recommendations/artists',{cookie:firstCookie,profile}).then(r=>r.json());
  assert.deepEqual(own.artists.map(a=>a.id),[987]);
  const otherFavorites=await request('/api/recommendations/artists',{cookie:secondCookie,profile}).then(r=>r.json());
  assert.deepEqual(otherFavorites.artists,[],'browser header must not switch a signed-in account');
  const raw=firstCookie.split('=')[1];
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_sessions WHERE token_hash=?').get(raw).n,0,'session secret must not be stored in plaintext');
  assert.equal((await request('/api/auth/logout',{method:'POST',cookie:firstCookie,body:{},requestOrigin:'https://evil.invalid'})).status,401);
  assert.equal((await request('/api/auth/me',{cookie:firstCookie}).then(r=>r.json())).user.id,account.id);
  const logout=await request('/api/auth/logout',{method:'POST',cookie:firstCookie,body:{}});
  assert.equal(logout.status,200);
  assert.ok(logout.headers.get('set-cookie').includes('Max-Age=0'));
  assert.equal((await request('/api/auth/me',{cookie:firstCookie}).then(r=>r.json())).user,null);
  db.prepare('UPDATE auth_sessions SET expires_at=0 WHERE user_id=?').run(other.id);
  assert.equal((await request('/api/auth/me',{cookie:secondCookie}).then(r=>r.json())).user,null,'expired session');
  console.log('PASS: signed login, forgery/date/origin/replay rejection, cookie flags, session hashing, account isolation, logout and expiry.');
} finally {
  db?.close();child.kill();await exited;closeSync(log);
}

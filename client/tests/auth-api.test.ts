import test from 'node:test';
import assert from 'node:assert/strict';

test('changing Telegram identity never replays the previous account reaction queue', async () => {
  const keys=['window','localStorage','fetch'];
  const saved=new Map(keys.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
  const storage=new Map<string,string>();
  const calls:{path:string;body:unknown}[]=[];
  let releaseLogin:()=>void=()=>{};
  let loginStarted:()=>void=()=>{};
  const started=new Promise<void>(resolve=>loginStarted=resolve);
  const pending=new Promise<void>(resolve=>releaseLogin=resolve);
  Object.defineProperties(globalThis,{
    window:{configurable:true,value:{addEventListener(){},setInterval(){return 0;}}},
    localStorage:{configurable:true,value:{getItem:(k:string)=>storage.get(k)||null,setItem:(k:string,v:string)=>storage.set(k,v)}},
    fetch:{configurable:true,value:async(path:string,options?:RequestInit)=>{
      calls.push({path,body:options?.body?JSON.parse(String(options.body)):undefined});
      if(path==='/api/interactions')return Response.json({error:{message:'offline'}},{status:503});
      if(path==='/api/auth/telegram'){loginStarted();await pending;return Response.json({user:{id:7,telegram_id:42,first_name:'Listener'}});}
      return Response.json({});
    }},
  });
  try{
    const {api}=await import('../src/api.ts');
    await api.react({track_id:'deezer_42',action:'like'});
    assert.equal(JSON.parse(storage.get('yamusic.reactions.v1')!).length,1);
    const login=api.authLogin({id:42,first_name:'Listener',auth_date:1,hash:'signed-by-server-check'});
    await started;
    await api.react({track_id:'deezer_43',action:'like'});
    releaseLogin();await login;
    await api.flushReactions();
    assert.deepEqual(JSON.parse(storage.get('yamusic.reactions.v1')!),[]);
    assert.equal(calls.filter(c=>c.path==='/api/interactions').length,2);
    assert.equal(calls.some(c=>(c.body as {track_id?:string})?.track_id==='deezer_43'),false);
  }finally{
    for(const [key,descriptor] of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}
  }
});

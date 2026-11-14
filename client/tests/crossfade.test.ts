import assert from 'node:assert/strict';
import test from 'node:test';
import { Player } from '../src/player.ts';
import type { Track } from '../src/types.ts';

Object.defineProperty(globalThis,'document',{value:{documentElement:{style:{setProperty(){}}}},configurable:true});

class AudioStub extends EventTarget {
  static instances: AudioStub[]=[];
  paused=true;
  seeking=false;
  ended=false;
  duration=20;
  currentTime=0;
  readyState=4;
  volume=1;
  src='';
  constructor(){super();AudioStub.instances.push(this);}
  play(){this.paused=false;return Promise.resolve();}
  pause(){if(!this.paused){this.paused=true;this.dispatchEvent(new Event('pause'));}}
  removeAttribute(){this.src='';}
  load(){}
  at(seconds:number){this.currentTime=seconds;this.dispatchEvent(new Event('timeupdate'));}
}

test('crossfade overlaps the two tracks and promotes the already playing element',async()=>{
  Object.defineProperty(globalThis,'Audio',{value:AudioStub,configurable:true});
  const first={id:'deezer_1',duration_sec:20,cover_url:''} as Track;
  const second={...first,id:'deezer_2'};
  const player=new Player(.8);
  player.setCrossfade(4);
  const changes: string[]=[];
  player.addEventListener('trackchange',()=>changes.push(player.current!.id));
  player.play(first,[first,second]);
  const outgoing=AudioStub.instances[0];
  outgoing.dispatchEvent(new Event('playing'));
  outgoing.at(15);
  const incoming=AudioStub.instances[1];
  assert.equal(incoming.paused,true);
  assert.equal(incoming.src,'/api/stream/deezer_2');
  outgoing.at(16);
  await Promise.resolve();
  incoming.at(2);
  outgoing.at(18);
  assert.equal(incoming.paused,false);
  assert.equal(incoming.volume,.4);
  assert.equal(outgoing.volume,.4);
  assert.equal(player.volume,.8);
  incoming.at(4);
  outgoing.ended=true;
  outgoing.dispatchEvent(new Event('ended'));
  assert.equal(player.current?.id,second.id);
  assert.equal(player.time,4);
  assert.equal(incoming.volume,.8);
  assert.equal(outgoing.src,'');
  assert.deepEqual(changes,[first.id,second.id]);
});

test('pausing cancels the overlap and restores the current volume',async()=>{
  AudioStub.instances=[];
  const first={id:'deezer_1',duration_sec:20,cover_url:''} as Track;
  const second={...first,id:'deezer_2'};
  const player=new Player(.6);
  player.setCrossfade(5);
  player.play(first,[first,second]);
  const outgoing=AudioStub.instances[0];
  outgoing.dispatchEvent(new Event('playing'));
  outgoing.at(15);
  await Promise.resolve();
  outgoing.at(17);
  const incoming=AudioStub.instances[1];
  player.pause();
  assert.equal(player.current?.id,first.id);
  assert.equal(incoming.paused,true);
  assert.equal(incoming.src,'');
  assert.equal(outgoing.volume,.6);
});

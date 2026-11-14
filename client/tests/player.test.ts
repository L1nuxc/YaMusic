import test from 'node:test';
import assert from 'node:assert/strict';
import { Player } from '../src/player.ts';
import type { Track } from '../src/types.ts';

class FakeAudio extends EventTarget {
  preload = ''; volume = 1; src = ''; paused = true;
  currentTime = 0; duration = 200; seeking = false;
  readyState = 0;
  ended = false;
  removeAttribute(name: string) { if(name==='src')this.src=''; }
  load() {}
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
}

test('player renews a failed stream once, restores position and resets retries for the next song', async () => {
  const originals = new Map(['Audio','navigator','document','fetch'].map(k => [k,Object.getOwnPropertyDescriptor(globalThis,k)]));
  const requests: string[] = [];
  Object.defineProperties(globalThis, {
    Audio: { configurable:true, value:FakeAudio },
    navigator: { configurable:true, value:{} },
    document: { configurable:true, value:{documentElement:{style:{setProperty(){}}}} },
    fetch: { configurable:true, value:async (url:string) => { requests.push(url); return new Response('{}'); } },
  });
  try {
    const track = {id:'deezer_42',title:'Song',artist:'Artist',duration_sec:200,cover_url:''} as Track;
    const p = new Player(1);
    let errors = 0; p.addEventListener('playererror',()=>errors++);
    p.play(track);
    assert.equal(p.audio.src,'/api/stream/deezer_42');
    assert.deepEqual(requests,[], 'playback must not start a second resolver request');
    p.audio.currentTime = 32;
    p.audio.dispatchEvent(new Event('error'));
    assert.equal(p.audio.src,'/api/stream/deezer_42?refresh=1');
    assert.equal(errors,0);
    p.audio.currentTime = 0;
    p.audio.dispatchEvent(new Event('loadedmetadata'));
    assert.equal(p.time,32);
    p.audio.dispatchEvent(new Event('error'));
    assert.equal(p.mode,'unavailable'); assert.equal(errors,1);
    p.play({...track,id:'deezer_43'});
    p.audio.currentTime = 0;
    p.audio.dispatchEvent(new Event('error'));
    assert.equal(p.mode,'unavailable');
    assert.equal(p.audio.src,'/api/stream/deezer_43', 'an unavailable initial source must not cause another long search automatically');
    p.resume();
    p.audio.currentTime = 1;
    p.audio.dispatchEvent(new Event('error'));
    assert.equal(p.audio.src,'/api/stream/deezer_43?refresh=1');

    const list = [42,43,44,45,46].map(id => ({...track,id:`deezer_${id}`}));
    p.play(list[0],list);
    p.toggleShuffle();
    const nextInDisplayedQueue = p.queue[1].id;
    p.next();
    assert.equal(p.current?.id,nextInDisplayedQueue,'Next uses the order shown in the shuffled queue');
    const last = p.queue.length - 1;
    const queued = p.queue[last].id;
    p.playQueued(last);
    assert.equal(p.current?.id,queued);
    p.playQueued(0);
    assert.equal(p.current?.id,queued,'past positions are not selectable from the queue');
    p.play(list[0],list,'wave-session');
    p.toggleShuffle();
    assert.equal(p.shuffle,true,'the saved shuffle preference is preserved while Wave owns the order');
    p.next();
    assert.equal(p.current?.id,list[1].id);
    await Promise.resolve();
  } finally {
    for (const [key,value] of originals) {
      if(value) Object.defineProperty(globalThis,key,value);
      else Reflect.deleteProperty(globalThis,key);
    }
  }
});

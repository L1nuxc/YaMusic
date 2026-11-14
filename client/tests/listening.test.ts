import test from 'node:test';
import assert from 'node:assert/strict';
import {ListeningProgress} from '../src/listening.ts';
test('seeking to the end and buffer waits never count as complete listening',()=>{
  const p=new ListeningProgress();p.reset(0,0);
  p.sample(1,1000,true,false);p.sample(90,1100,true,true);p.sample(91,2100,true,false);
  assert.equal(p.seconds,2);assert.equal(p.ratio(100),0.02);
  p.sample(91,100000,true,false);assert.equal(p.seconds,2);
  p.sample(92,101000,false,false);assert.equal(p.seconds,2);
  p.sample(93,102000,true,false);assert.equal(p.seconds,3);
});
test('continuous real playback crosses the completion threshold once enough was heard',()=>{
  const p=new ListeningProgress();p.reset(0,0);for(let i=1;i<=81;i++)p.sample(i,i*1000,true,false);
  assert.equal(p.seconds,81);assert.equal(p.ratio(100),0.81);
});

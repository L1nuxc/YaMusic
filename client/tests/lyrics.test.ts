import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLrc,activeLine,retryLyrics } from '../src/lyrics.ts';
test('LRC supports repeated timestamps, variable precision, metadata and global offset',()=>{
  const lines=parseLrc('[ar:Example]\n[00:02.50][00:04.500]An original test line\n[offset:500]\n[00:01.2]Opening\n[00:99.0]Invalid\n[00:05.00]');
  assert.deepEqual(lines,[{time:.7,text:'Opening'},{time:2,text:'An original test line'},{time:4,text:'An original test line'}]);
  assert.equal(activeLine(lines,.1),-1);assert.equal(activeLine(lines,2),1);assert.equal(activeLine(lines,99),2);
});
test('empty and unsynchronized input is not assigned fake timestamps',()=>{
  assert.deepEqual(parseLrc('Plain text\n[al:An album]'),[]);
  assert.equal(activeLine([],50),-1);
});
test('retries a temporary lyrics failure before returning the result',async()=>{
  let attempts=0;
  const result=await retryLyrics(async()=>{
    if(++attempts===1)throw Object.assign(new Error('provider temporarily unavailable'),{status:502});
    return 'lyrics';
  },new AbortController().signal);
  assert.equal(attempts,2);
  assert.equal(result,'lyrics');
});
test('does not retry a missing track or continue after the player closes',async()=>{
  let attempts=0;
  const missing=Object.assign(new Error('missing'),{status:404});
  await assert.rejects(retryLyrics(async()=>{ attempts++; throw missing; },new AbortController().signal),missing);
  const controller=new AbortController();
  const request=retryLyrics(async()=>{ attempts++; throw new TypeError('offline'); },controller.signal);
  setTimeout(()=>controller.abort(),10);
  await assert.rejects(request,{name:'AbortError'});
  assert.equal(attempts,2);
});

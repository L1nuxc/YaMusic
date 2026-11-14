import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreLibrary, freshLibrary, nextIndex, safeImage, escapeHtml } from '../src/model.ts';
const track = { id: 'deezer_42', deezer_id: 42, title: 'Song', artist: 'Artist', artist_id: 7, album: 'Album', album_id: 9, cover_url: '', duration_sec: 100, is_explicit: false, preview_url: '' };
test('storage recovery rejects malformed data, deduplicates songs, clamps settings', () => {
  assert.deepEqual(restoreLibrary('{broken'), freshLibrary());
  assert.deepEqual(restoreLibrary('{"version":2}'), freshLibrary());
  const restored = restoreLibrary(JSON.stringify({ version:1, likes:[track, track, {id:'invalid'}, null], settings:{theme:'arbitrary',volume:10}, playlists:[null, {}, {id:'p',title:'Mine',tracks:[track]}] }));
  assert.equal(restored.likes.length,1); assert.equal(restored.playlists.length,1);
  assert.equal(restored.playlists[0].tracks[0].id,'deezer_42');
  assert.equal(restored.settings.volume,1); assert.equal(restored.settings.theme,'dark');
});
test('queue terminates, loops, repeats and shuffles without repeating same track', () => {
  assert.equal(nextIndex(2,3,'off',false,true),null);
  assert.equal(nextIndex(2,3,'all',false,true),0);
  assert.equal(nextIndex(1,3,'one',false,true),1);
  assert.equal(nextIndex(1,3,'one',false,false),2);
  for (let index=0;index<3;index++) for (const random of [0,.4,.99]) assert.notEqual(nextIndex(index,3,'off',true,false,()=>random),index);
  assert.equal(nextIndex(-1,0,'all',true),null);
});
test('provider text and unsafe image schemes cannot become markup or executable URLs', () => {
  assert.equal(safeImage('javascript:alert(1)'), '');
  assert.equal(safeImage('data:image/svg+xml,x'), '');
  assert.equal(escapeHtml('<img onerror="x">'), '&lt;img onerror=&quot;x&quot;&gt;');
});

// Imported collections may contain old solo metadata or hostile cover values.
test('playlist edits and complete artist credits survive storage without losing old libraries', async () => {
  const {trackArtists}=await import('../src/model.ts');
  const full={...track,contributors:[{id:7,name:'GreyRock'},{id:8,name:'madk1d'},{id:8,name:'madk1d'},null]};
  const restored=restoreLibrary(JSON.stringify({version:1,likes:[full],playlists:[{id:'p',title:'Night',description:'My songs',cover_url:'data:image/jpeg;base64,YWJj',tracks:[full]},{id:'bad',title:'Bad',cover_url:'data:image/svg+xml,<svg onload="x"/>',tracks:[]}]}));
  assert.deepEqual(trackArtists(restored.likes[0]).map(a=>a.name),['GreyRock','madk1d']);
  assert.deepEqual(trackArtists(track),[{id:7,name:'Artist'}]);
  assert.equal(restored.playlists[0].description,'My songs');
  assert.equal(restored.playlists[0].cover_url,'data:image/jpeg;base64,YWJj');
  assert.equal(restored.playlists[1].cover_url,'');
});
test('search history restores safely, deduplicates case and bounds retained queries', async () => {
  const {restoreSearchHistory,rememberSearch}=await import('../src/model.ts');
  assert.deepEqual(restoreSearchHistory('{bad'),[]);
  assert.deepEqual(restoreSearchHistory('["Кино",null,4,""]'),['Кино']);
  assert.deepEqual(rememberSearch(['Кино','Земфира'],'кино'),['кино','Земфира']);
  assert.equal(rememberSearch(Array.from({length:20},(_,i)=>'query '+i),'New').length,20);
});

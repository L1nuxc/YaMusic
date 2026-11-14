import assert from 'node:assert/strict';
import test from 'node:test';
import {parseSpotifyExport} from '../src/spotify-export.ts';

test('Spotify JSON preserves the whole playlist in order and separates unavailable items',()=>{
  const items=Array.from({length:181},(_,i)=>({track:{trackName:`Song ${i}`,artistName:'Artist',uri:`spotify:track:${i}`}}));
  const [list]=parseSpotifyExport(JSON.stringify({playlists:[{name:'Long playlist',items:[...items,{track:null,episode:{name:'Episode'}}]}]}));
  assert.equal(list.tracks.length,181);
  assert.equal(list.tracks[180].title,'Song 180');
  assert.equal(list.unavailable,1);
});

test('Spotify saved tracks export uses flat artist and track names',()=>{
  const [list]=parseSpotifyExport(JSON.stringify({tracks:[{artist:'Artist',track:'Song',uri:'spotify:track:123'}]}));
  assert.deepEqual(list.tracks,[{artist:'Artist',title:'Song'}]);
});

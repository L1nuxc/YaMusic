import test from 'node:test';
import assert from 'node:assert/strict';
import {paletteFromPixels,neutralPalette} from '../src/palette.ts';
test('cover colors ignore transparent/white margins and preserve a second dominant hue',()=>{
  const p=new Uint8ClampedArray([255,255,255,255,0,0,0,255,255,0,0,0,180,40,50,255,180,40,50,255,40,70,150,255]);
  assert.deepEqual(paletteFromPixels(p),{primary:[180,40,50],secondary:[40,70,150]});
  assert.deepEqual(paletteFromPixels(new Uint8ClampedArray([0,0,0,0])),neutralPalette);
});

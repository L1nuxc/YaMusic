import type { MissingTrack } from './api.ts';

export interface SpotifyExportPlaylist {
  title: string;
  tracks: MissingTrack[];
  unavailable: number;
}

export function parseSpotifyExport(text: string): SpotifyExportPlaylist[] {
  const data = JSON.parse(text.replace(/^\uFEFF/,'')) as { playlists?: unknown[]; tracks?: unknown[] };
  const lists = Array.isArray(data?.playlists) ? data.playlists :
    Array.isArray(data?.tracks) ? [{name:'Любимое в Spotify',items:data.tracks}] : [];
  return lists.flatMap((entry: unknown) => {
    if(!entry||typeof entry!=='object')return [];
    const list=entry as {name?:unknown;items?:unknown[]};
    if(!Array.isArray(list.items)||!list.items.length)return [];
    const tracks=list.items.flatMap(item=>{
      if(!item||typeof item!=='object')return [];
      const wrapper=item as {track?:unknown};
      const track=(wrapper.track&&typeof wrapper.track==='object'?wrapper.track:item) as {
        trackName?:unknown;artistName?:unknown;track?:unknown;artist?:unknown;uri?:unknown
      };
      const title=track.trackName??track.track;
      const artist=track.artistName??track.artist;
      if(typeof title!=='string'||typeof artist!=='string'||!title.trim()||!artist.trim())return [];
      if(typeof track.uri==='string'&&!track.uri.startsWith('spotify:track:'))return [];
      return [{artist,title}];
    });
    const title=typeof list.name==='string'?list.name:'Spotify';
    return [{title,tracks,unavailable:list.items.length-tracks.length}];
  });
}

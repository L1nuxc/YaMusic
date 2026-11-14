import { api } from './api.ts';
import type { LyricsResult } from './lyrics.ts';
import type { Track } from './types.ts';

interface Native {
  invoke<T>(name: string, args?: object): Promise<T>;
  convertFileSrc(path: string): string;
}
const platform=window as Window & {
  __TAURI_INTERNALS__?: Native;
  __YAMUSIC_WINDOWS__?: boolean;
  __YAMUSIC_UPDATE__?: string;
};
const native=platform.__YAMUSIC_WINDOWS__?platform.__TAURI_INTERNALS__:undefined;
export const windowsDesktop=Boolean(native);
export const localDesktop=windowsDesktop && ['tauri.localhost','localhost'].includes(location.hostname);
export const invokeDesktop=<T>(name: string,args?: object): Promise<T> =>
  native ? native.invoke<T>(name,args) : Promise.reject(new Error('Действие доступно в приложении Windows.'));
export const desktopUpdate=():string|undefined=>platform.__YAMUSIC_UPDATE__;

interface Download { track: Track; path: string; lyrics?: LyricsResult; artwork?: string }
interface DownloadedPlaylist {title:string;tracks:string[]}
export class Downloads {
  entries: Record<string, Download>={};
  playlists: Record<string, DownloadedPlaylist>={};
  folder='';
  private pending=new Set<string>();
  constructor(readonly account: number) {}

  async refresh(): Promise<void> {
    [this.entries,this.folder,this.playlists]=await Promise.all([
      invokeDesktop<Record<string, Download>>('offline_list',{account:this.account}),
      invokeDesktop<string>('offline_folder',{account:this.account}),
      invokeDesktop<Record<string, DownloadedPlaylist>>('offline_playlists',{account:this.account}),
    ]);
  }

  source(id:string): string|undefined {
    const entry=this.entries[id];
    if(entry)return native?.convertFileSrc(entry.path);
  }

  async chooseFolder(): Promise<void> {
    const folder=await invokeDesktop<string|null>('offline_choose_folder',{account:this.account});
    if(folder)this.folder=folder;
  }

  async save(track: Track): Promise<void> {
    if(this.entries[track.id]||this.pending.has(track.id))return;
    const account=this.account;
    this.pending.add(track.id);
    const args={account,track:track.id};
    let started=false;
    try{
      const response=await fetch(`/api/stream/${encodeURIComponent(track.id)}`);
      if(!response.ok||!response.body||response.headers.get('x-yamusic-mode')!=='full')throw new Error('Полная запись сейчас недоступна.');
      await invokeDesktop('offline_begin',{...args,mime:response.headers.get('content-type')??''});
      started=true;
      const metadata=Promise.all([
        api.lyrics(track.id,AbortSignal.timeout(6000)).catch(()=>null),
        fetchArtwork(track.cover_url).catch(()=>undefined),
      ]);
      const reader=response.body.getReader();
      try {
        while(true){
          const {done,value}=await reader.read();
          if(done)break;
          for(let offset=0;offset<value.length;offset+=48*1024) {
            const bytes=value.subarray(offset,offset+48*1024);
            await invokeDesktop('offline_write',{...args,chunk:btoa(String.fromCharCode(...bytes))});
          }
        }
      } finally { await reader.cancel().catch(()=>{}); }
      const [lyrics,artwork]=await metadata;
      const size=Number(response.headers.get('content-length'))||null;
      await invokeDesktop('offline_finish',{account,track,lyrics,size,artwork});
      started=false;
      await this.refresh();
    } finally {
      if(started)await invokeDesktop('offline_cancel',args).catch(()=>{});
      this.pending.delete(track.id);
    }
  }

  async remove(track: string): Promise<void> {
    await invokeDesktop('offline_remove',{account:this.account,track});
    await this.refresh();
  }

  async savePlaylist(id: string, title: string, tracks: Track[]): Promise<void> {
    const playlist={title,tracks:tracks.map(track=>track.id).filter(id=>id in this.entries)};
    if(!playlist.tracks.length)return;
    await invokeDesktop('offline_save_playlist',{account:this.account,id,playlist});
    this.playlists[id]=playlist;
  }
}

async function fetchArtwork(url:string):Promise<string|undefined>{
  if(!url||!url.startsWith('https://'))return;
  const response=await fetch(url,{signal:AbortSignal.timeout(4500)});
  if(!response.ok)return;
  const blob=await response.blob();
  if(blob.size>250_000||!['image/jpeg','image/png','image/webp'].includes(blob.type))return;
  return await new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onerror=reject;reader.onload=()=>resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

import type { Track, SearchResults, Album, Artist, TranslationProvider } from './types.ts';
import type { LyricsResult } from './lyrics.ts';
import type { LivePlayback } from './player.ts';

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, { signal, headers: { Accept: 'application/json', 'X-YaMusic-Profile': profileId } });
  let data;
  try { data = await response.json(); } catch { throw Object.assign(new Error('Сервер пока недоступен. Попробуйте ещё раз.'),{status:response.ok ? undefined : response.status}); }
  if (!response.ok) throw apiError(response,path,data.error?.message || 'Не удалось загрузить музыку.');
  return data as T;
}
const PROFILE_KEY='yamusic.profile.v1';
let profileId=localStorage.getItem(PROFILE_KEY)||'';
if(!/^[a-zA-Z0-9-]{16,64}$/.test(profileId)){profileId=crypto.randomUUID();localStorage.setItem(PROFILE_KEY,profileId);}
function apiError(response: Response, path: string, message: string): Error {
  if (response.status===401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('yamusic-session-expired'));
  return Object.assign(new Error(message),{status:response.status});
}
async function post<T>(path:string,body:unknown,signal?:AbortSignal):Promise<T>{
  const response=await fetch(`/api${path}`,{method:'POST',signal,headers:{'Content-Type':'application/json','X-YaMusic-Profile':profileId},body:JSON.stringify(body)});
  const data=await response.json();if(!response.ok)throw apiError(response,path,data.error?.message||'Не удалось обновить рекомендации.');return data as T;
}
export interface WaveQueue {session_id:string;tracks:Track[];personalized:boolean;learning:boolean}
export interface AuthUser {id:number;telegram_id:number;first_name:string;username?:string|null;avatar_url?:string|null}
export interface AuthConfig {enabled:boolean;bot_username?:string|null;spotify?:boolean;google_translate?:boolean;deepl?:boolean}
export interface MissingTrack { artist:string; title:string }
export interface ImportPreview {title:string;tracks:Track[];checked:number;total:number;limited?:boolean;missing?:MissingTrack[];unavailable?:number}
export interface TelegramLogin {id:number;first_name:string;last_name?:string;username?:string;photo_url?:string;auth_date:number;hash:string}
export interface PersonalMix {id:string;title:string;description:string;tracks:Track[]}
export interface Mixes {day:string;week:string;mixes:PersonalMix[]}
export interface AccountLibrary {entries:Record<string, unknown>;likes:Track[];dislikes:string[]}
export interface LibraryChange {id:string;entries:Record<string, unknown>;import_legacy?:boolean;likes?:string[]}
export interface DeviceCommand {action:string;value?:number}
export interface DeviceState {
  active:string|null; devices:Record<string,{label:string}>; playback:LivePlayback|null;
  revision:number; age:number; transferring:boolean; commands:DeviceCommand[];
}
export interface RecommendationStatus {available:boolean;analyzed_tracks:number;pending:number;analyzing:boolean;likes:string[];dislikes:string[];blocked_tracks:Track[]}
export interface Reaction {track_id:string;action:'like'|'unlike'|'dislike'|'undislike'|'complete'|'early_skip';event_id:string;listen_ratio?:number;listened_sec?:number;session_id?:string}
export interface ResumeSnapshot { track: Track; position: number; context?: string | null; queue: Track[]; captured_at: number }
const prepared = new Map<string,number>();
// Keep reactions across a reload or a short network interruption. Event IDs make
// retries safe: one listening event can only contribute its weight once.
let reactionQueue:Reaction[]=[];
try{const saved=JSON.parse(localStorage.getItem('yamusic.reactions.v1')||'[]');if(Array.isArray(saved))reactionQueue=saved.filter(r=>r&&typeof r.event_id==='string'&&/^deezer_\d+$/.test(r.track_id)).slice(-500);}catch{/* Ignore damaged data. */}
let flushing:Promise<void>|undefined;
let authChanging=false;
function saveReactions():void{try{localStorage.setItem('yamusic.reactions.v1',JSON.stringify(reactionQueue));}catch{/* Music remains available if storage is full. */}}
function flushReactions(duringAuth=false):Promise<void>{
  if(authChanging&&!duringAuth)return Promise.resolve();
  if(flushing)return flushing;
  flushing=(async()=>{while(reactionQueue[0]){try{await post('/interactions',reactionQueue[0]);reactionQueue.shift();saveReactions();}catch(error){const status=(error as {status?:number})?.status;if(status&&[400,404,422].includes(status)){reactionQueue.shift();saveReactions();continue;}break;}}})().finally(()=>{flushing=undefined;});return flushing;
}
window.addEventListener('online',()=>void flushReactions());
window.setInterval(()=>{if(reactionQueue.length)void flushReactions();},15000);
export const api = {
  authConfig:()=>get<AuthConfig>('/auth/config'),
  authMe:()=>get<{user:AuthUser|null}>('/auth/me'),
  authLogin:async(payload:TelegramLogin)=>{
    authChanging=true;
    try{await flushReactions(true);reactionQueue=[];saveReactions();return await post<{user:AuthUser}>('/auth/telegram',payload);}
    finally{authChanging=false;}
  },
  authLogout:async()=>{
    authChanging=true;
    try{await flushReactions(true);reactionQueue=[];saveReactions();return await post('/auth/logout',{});}
    finally{authChanging=false;}
  },
  favoriteArtists:()=>get<{artists:Artist[]}>('/recommendations/artists'),
  artistSuggestions:(index=0,signal?:AbortSignal)=>get<{artists:Artist[];next_index:number|null}>(`/recommendations/artists/suggestions?index=${index}`,signal),
  relatedArtists:(id:number,signal?:AbortSignal)=>get<{artists:Artist[]}>(`/recommendations/artists/${id}/related`,signal),
  saveFavoriteArtists:async(artist_ids:number[])=>{
    const response=await fetch('/api/recommendations/artists',{method:'PUT',headers:{'Content-Type':'application/json','X-YaMusic-Profile':profileId},body:JSON.stringify({artist_ids})});
    const data=await response.json();if(!response.ok)throw new Error(data.error?.message||'Не удалось сохранить исполнителей.');return data as {artists:Artist[]};
  },
  react:(reaction:Omit<Reaction,'event_id'>)=>{if(authChanging)return Promise.resolve();reactionQueue.push({...reaction,event_id:crypto.randomUUID()});reactionQueue=reactionQueue.slice(-500);saveReactions();return flushReactions();},
  flushReactions,
  recommendationStatus:()=>get<RecommendationStatus>('/recommendations/status'),
  wave:()=>post<WaveQueue>('/wave',{}),
  advanceWave:(session:string,current_id:string)=>post<WaveQueue>(`/wave/${encodeURIComponent(session)}/next`,{current_id}),
  mixes:()=>get<Mixes>('/mixes'),
  accountLibrary:()=>get<AccountLibrary>('/account/library'),
  saveAccountLibrary:async (change:LibraryChange)=>{
    const path='/account/library';
    const response=await fetch('/api'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(change)});
    if(!response.ok)throw apiError(response,path,'Не удалось синхронизировать медиатеку.');
  },
  prepare: (tracks: Track[], playback = false) => {
    const now=Date.now();for(const [id,at] of prepared)if(now-at>60000)prepared.delete(id);
    const ids=tracks.slice(0,5).map(t=>t.id).filter(id=>now-(prepared.get(`${playback}:${id}`)??0)>(playback?6000:60000));
    if(!ids.length)return;ids.forEach(id=>prepared.set(`${playback}:${id}`,now));
    void fetch('/api/prefetch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids,playback})})
      .then(r=>{if(!r.ok)ids.forEach(id=>prepared.delete(`${playback}:${id}`));}).catch(()=>ids.forEach(id=>prepared.delete(`${playback}:${id}`)));
  },
  discover: () => get<{ tracks: Track[] }>('/discover'),
  track:(id:string)=>get<Track>(`/tracks/${encodeURIComponent(id)}`),
  search: (q: string, kind = 'all', index = 0, signal?: AbortSignal) => get<SearchResults>(`/search?${new URLSearchParams({ q, type: kind, limit: '24', index: String(index), compact: 'true' })}`, signal),
  album: (id: number, signal?: AbortSignal) => get<{ album: Album; tracks: Track[] }>(`/albums/${id}?compact=true`, signal),
  artist: (id: number, signal?: AbortSignal, compact = true) => get<{ artist: Artist; tracks: Track[]; albums: Album[]; more_tracks?: boolean }>(`/artists/${id}?compact=${compact}`, signal),
  restorePlayback: () => get<ResumeSnapshot | null>('/playback/resume'),
  devices: (body:object, keepalive=false) => fetch('/api/playback/devices',{
    method:'POST',keepalive,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
  }).then(async response=>{
    if(!response.ok)throw apiError(response,'/playback/devices','Устройства пока недоступны.');
    return await response.json() as DeviceState;
  }),
  savePlayback: async (snapshot: ResumeSnapshot) => {
    const path='/playback/resume';
    const response=await fetch('/api'+path,{method:'POST',keepalive:true,headers:{'Content-Type':'application/json'},
      body:JSON.stringify({track_id:snapshot.track.id,position:snapshot.position,context:snapshot.context,
        queue:snapshot.queue.map(track=>track.id),captured_at:snapshot.captured_at})});
    if(!response.ok)throw apiError(response,path,'Не удалось сохранить позицию.');
  },
  smartSearch: (query: string, signal?: AbortSignal) => post<{tracks:Track[]}>('/search/smart',{query},signal),
  matchImport:(tracks:MissingTrack[],signal?:AbortSignal)=>post<Pick<ImportPreview,'tracks'|'missing'|'checked'>>('/import/match',{tracks},signal),
  spotifyStart:()=>post<{url:string}>('/import/spotify/start',{}),
  spotifyDisconnect:()=>post('/import/spotify/disconnect',{}),
  spotifyPlaylists:(offset:number,signal?:AbortSignal)=>get<{connected:boolean;playlists:{id:string;name:string}[];next_offset?:number}>(`/import/spotify/playlists?offset=${offset}`,signal),
  spotifyPage:(playlist:string,offset:number,signal?:AbortSignal)=>post<Omit<ImportPreview,'title'>&{next_offset?:number}>('/import/spotify/page',{playlist,offset},signal),
  importPreview: (input: string, signal?: AbortSignal) => post<ImportPreview>('/import/preview',{input},signal),
  translateLyrics: (id: string, provider: TranslationProvider, language: string, signal?: AbortSignal) =>
    post<{translated_lrc:string;plain?:boolean}>(`/lyrics/${encodeURIComponent(id)}/translation?${new URLSearchParams({provider,lang:language})}`,{},signal),
  lyrics: (id: string, signal?: AbortSignal) => get<LyricsResult>(`/lyrics/${encodeURIComponent(id)}`,signal),
};

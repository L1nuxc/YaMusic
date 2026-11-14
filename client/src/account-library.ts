import { api, type AccountLibrary, type LibraryChange } from './api.ts';
import type { Library, Track } from './types.ts';
import { isTrack, restoreLibrary, restoreSearchHistory, uniqueTracks } from './model.ts';

const settingsKeys = ['theme', 'animations', 'crossfade', 'translation', 'translationLanguage'] as const;

export function accountEntries(library: Library, searchHistory: string[]): Record<string, unknown> {
  const entries: Record<string, unknown> = { searchHistory };
  for (const key of settingsKeys) entries[key] = library.settings[key];
  for (const playlist of library.playlists) entries['playlist:'+playlist.id] = playlist;
  return structuredClone(entries);
}

export function applyAccountLibrary(snapshot: AccountLibrary, volume: number, pending: LibraryChange[]) {
  const entries = { ...snapshot.entries };
  for (const change of pending) {
    for (const [key,value] of Object.entries(change.entries)) {
      if (change.import_legacy && key in entries) continue;
      if (key === 'heard' && isTrack(value)) {
        const history = Array.isArray(entries.history) ? entries.history.filter(isTrack) : [];
        entries.history = uniqueTracks([value, ...history]).slice(0, 100);
      } else entries[key] = value;
    }
  }
  return {
    library: restoreLibrary(JSON.stringify({
      version:1, likes:snapshot.likes, history:entries.history,
      playlists:Object.entries(entries).filter(([key,value])=>key.startsWith('playlist:') && value !== null).map(([,value])=>value),
      settings:Object.fromEntries([['volume',volume],...settingsKeys.map(key=>[key,entries[key]])]),
    })),
    searchHistory:restoreSearchHistory(JSON.stringify(entries.searchHistory)),
  };
}

export class LibrarySync {
  private pending: LibraryChange[] = [];
  private baseline: Record<string, unknown> = {};
  private running?: Promise<void>;
  private timer = 0;
  private stopped = false;
  private key: string;
  ready = false;

  constructor(user: number, private apply: (snapshot: AccountLibrary, pending: LibraryChange[])=>void) {
    this.key='yamusic.library-pending.v1.'+user;
    try { this.pending=JSON.parse(localStorage.getItem(this.key)||'[]'); } catch { /* A fresh snapshot is still available. */ }
    window.addEventListener('online',this.refresh);
    this.timer=window.setInterval(this.refresh,4500);
  }

  seed(library: Library, searchHistory: string[], id: string): void {
    if(this.pending.some(change=>change.id===id))return;
    const entries=accountEntries(library,searchHistory);
    if(library.history.length)entries.history=library.history;
    if(!searchHistory.length)delete entries.searchHistory;
    this.enqueue({id,import_legacy:true,entries,likes:library.likes.map(track=>track.id)});
  }

  observe(library: Library, searchHistory: string[]): void {
    this.baseline=accountEntries(library,searchHistory);
  }

  capture(library: Library, searchHistory: string[]): void {
    if (!this.ready) return;
    const entries=accountEntries(library,searchHistory);
    const changes: Record<string, unknown>={};
    for (const key of new Set([...Object.keys(entries),...Object.keys(this.baseline)])) {
      if (JSON.stringify(entries[key])!==JSON.stringify(this.baseline[key])) changes[key]=entries[key]??null;
    }
    this.baseline=entries;
    if(Object.keys(changes).length)this.enqueue({id:crypto.randomUUID(),entries:changes});
  }

  heard(track: Track): void { this.enqueue({id:crypto.randomUUID(),entries:{heard:track}}); }
  clearHistory(): void { this.enqueue({id:crypto.randomUUID(),entries:{history:[]}}); }

  private enqueue(change: LibraryChange): void {
    this.pending.push(change);
    this.cache();
    this.refresh();
  }

  private cache(): void {
    try { localStorage.setItem(this.key,JSON.stringify(this.pending)); } catch { /* Edits remain queued in memory. */ }
  }

  readonly refresh = (): void => { void this.sync().catch(()=>{}); };

  sync(): Promise<void> {
    if(this.stopped)return Promise.resolve();
    return this.running??=(async()=>{
      while(this.pending[0]&&!this.stopped){
        await api.saveAccountLibrary(this.pending[0]);
        this.pending.shift();
        this.cache();
      }
      if(this.stopped)return;
      await api.flushReactions();
      const snapshot=await api.accountLibrary();
      if(this.stopped)return;
      this.ready=true;
      this.apply(snapshot,this.pending);
    })().finally(()=>{this.running=undefined;});
  }

  close(): void {
    this.stopped=true;
    clearInterval(this.timer);
    window.removeEventListener('online',this.refresh);
  }
}

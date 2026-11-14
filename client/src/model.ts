import { languageCodes } from './translation-settings.ts';
import type { Library, Track, ArtistCredit } from './types.ts';

export const STORAGE_KEY = 'yamusic.library.v1';
export function freshLibrary(): Library {
  return { version: 1, likes: [], history: [], playlists: [], settings: { theme: 'dark', animations: true, volume: 0.65, translation: 'mymemory', translationLanguage: 'ru', crossfade: 0 } };
}
export function isTrack(value: unknown): value is Track {
  if (!value || typeof value !== 'object') return false;
  const t = value as Partial<Track>;
  return typeof t.id === 'string' && /^deezer_\d+$/.test(t.id) && Number.isSafeInteger(t.deezer_id) &&
    typeof t.title === 'string' && typeof t.artist === 'string' && typeof t.album === 'string' &&
    typeof t.cover_url === 'string' && typeof t.preview_url === 'string' &&
    typeof t.duration_sec === 'number' && Number.isFinite(t.duration_sec) && t.duration_sec >= 0 &&
    typeof t.artist_id === 'number' && typeof t.album_id === 'number' && typeof t.is_explicit === 'boolean';
}
export function uniqueTracks(tracks: Track[]): Track[] { return [...new Map(tracks.map(t => [t.id, t])).values()]; }
export function restoreLibrary(raw: string | null): Library {
  const base = freshLibrary();
  if (!raw) return base;
  try {
    const data = JSON.parse(raw);
    if (data?.version !== 1) return base;
    const list = (v: unknown): Track[] => Array.isArray(v) ? uniqueTracks(v.filter(isTrack)).slice(0, 5000) : [];
    base.likes = list(data.likes); base.history = list(data.history).slice(0, 100);
    base.playlists = Array.isArray(data.playlists) ? data.playlists.filter((p: unknown) => {
      if (!p || typeof p !== 'object') return false;
      const item = p as Record<string, unknown>;
      return typeof item.id === 'string' && typeof item.title === 'string' && item.title.length <= 100;
    }).slice(0, 200).map((p: { id: string; title: string; description?: unknown; cover_url?: unknown; tracks: unknown; createdAt?: number }) => ({ id: p.id, title: p.title, description: typeof p.description === 'string' ? p.description.slice(0,1000) : '', cover_url: typeof p.cover_url === 'string' ? safeImage(p.cover_url) : '', tracks: list(p.tracks), createdAt: Number.isFinite(p.createdAt) ? p.createdAt! : Date.now() })) : [];
    base.settings.theme = data.settings?.theme === 'light' ? 'light' : 'dark';
    base.settings.animations = data.settings?.animations !== false;
    const translation=data.settings?.translation;
    if(translation==='deepseek'||translation==='google'||translation==='deepl')base.settings.translation=translation;
    if(languageCodes.includes(data.settings?.translationLanguage))base.settings.translationLanguage=data.settings.translationLanguage;
    const crossfade = data.settings?.crossfade;
    if(typeof crossfade==='number' && Number.isFinite(crossfade))base.settings.crossfade=Math.max(0,Math.min(8,Math.round(crossfade)));
    const volume = data.settings?.volume;
    base.settings.volume = typeof volume === 'number' && Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0.65;
  } catch { /* Corrupt storage should not stop the app from opening. */ }
  return base;
}
export function formatTime(seconds: number): string {
  const n = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}
export function nextIndex(index: number, length: number, repeat: 'off' | 'all' | 'one', shuffle: boolean, ended = false, random = Math.random): number | null {
  if (length === 0) return null;
  if (ended && repeat === 'one') return index;
  if (shuffle && length > 1) return (Math.max(0, index) + 1 + Math.floor(random() * (length - 1))) % length;
  if (index + 1 < length) return index + 1;
  return repeat === 'all' ? 0 : null;
}
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
export function safeImage(url: string): string {
  // Only our resized raster cover uploads; SVG/HTML data URLs stay forbidden.
  if (/^data:image\/(jpeg|png|webp);base64,[a-zA-Z0-9+/=]+$/.test(url) && url.length <= 350000) return url;
  try { const parsed = new URL(url); return parsed.protocol === 'https:' ? parsed.href : ''; } catch { return ''; }
}
export function trackArtists(track: Track): ArtistCredit[] {
  const credits = Array.isArray(track.contributors) ? track.contributors.filter(a => a && Number.isSafeInteger(a.id) && a.id > 0 && typeof a.name === 'string' && a.name.trim()) : [];
  const all = credits.some(a => a.id === track.artist_id) ? credits : [{id:track.artist_id,name:track.artist}, ...credits];
  return [...new Map(all.map(a => [a.id,a])).values()];
}
export function restoreSearchHistory(raw: string | null): string[] {
  try { const data:unknown=JSON.parse(raw||'[]'); return Array.isArray(data) ? [...new Set(data.filter((q):q is string=>typeof q==='string'&&q.trim().length>0&&q.length<=200).map(q=>q.trim()))].slice(0,20) : []; } catch {return [];}
}
export function rememberSearch(history: string[], query: string): string[] {
  const q=query.trim().slice(0,200); if(!q)return history;
  return [q,...history.filter(s=>s.toLocaleLowerCase()!==q.toLocaleLowerCase())].slice(0,20);
}

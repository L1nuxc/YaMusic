import { isTrack } from './model.ts';
import type { Album, Artist, Track } from './types.ts';

export type RecentSearch = { tracks: Track[]; albums: Album[]; artists: Artist[] };
export type SearchHistorySection = keyof RecentSearch;

const maxRecent = 50;

function validArtist(value: unknown): value is Artist {
  const artist = value as Partial<Artist> | null;
  return !!artist && Number.isSafeInteger(artist.id)
    && typeof artist.name === 'string' && typeof artist.picture_url === 'string';
}

function validAlbum(value: unknown): value is Album {
  const album = value as Partial<Album> | null;
  return !!album && Number.isSafeInteger(album.id) && Number.isSafeInteger(album.artist_id)
    && typeof album.title === 'string' && typeof album.artist === 'string' && typeof album.cover_url === 'string';
}

export function readRecentSearch(account: number | undefined): RecentSearch {
  const recent: RecentSearch = { tracks: [], albums: [], artists: [] };
  try {
    const stored: Partial<RecentSearch> | null = JSON.parse(localStorage.getItem(storageKey(account)) ?? 'null');
    if (Array.isArray(stored?.tracks)) recent.tracks = stored.tracks.filter(isTrack).slice(0, maxRecent);
    if (Array.isArray(stored?.albums)) recent.albums = stored.albums.filter(validAlbum).slice(0, maxRecent);
    if (Array.isArray(stored?.artists)) recent.artists = stored.artists.filter(validArtist).slice(0, maxRecent);
  } catch { /* Search remains available if browser storage fails. */ }
  return recent;
}

function storageKey(account: number | undefined): string {
  return `yamusic.search-opened.v1.${account ?? 'local'}`;
}

export function recordSearchItem<K extends SearchHistorySection>(
  account: number | undefined, kind: K, item: RecentSearch[K][number],
): void {
  const recent = readRecentSearch(account);
  const items = recent[kind] as RecentSearch[K][number][];
  items.splice(0, items.length, ...[item, ...items.filter(entry => entry.id !== item.id)].slice(0, maxRecent));
  try { localStorage.setItem(storageKey(account), JSON.stringify(recent)); } catch { /* Keep playback available. */ }
}

export function refreshSearchArtist(account: number | undefined, artist: Artist): void {
  const recent = readRecentSearch(account);
  const index = recent.artists.findIndex(entry => entry.id === artist.id);
  if (index < 0 || !artist.picture_url || recent.artists[index].picture_url === artist.picture_url) return;
  recent.artists[index] = artist;
  try { localStorage.setItem(storageKey(account), JSON.stringify(recent)); } catch { /* Keep navigation available. */ }
}

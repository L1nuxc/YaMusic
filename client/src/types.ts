export interface Track {
  id: string; deezer_id: number; title: string; artist: string; artist_id: number;
  album: string; album_id: number; cover_url: string; duration_sec: number;
  is_explicit: boolean; preview_url: string;
  contributors?: ArtistCredit[];
}
export interface ArtistCredit { id: number; name: string; role?: string }
export interface Album { id: number; title: string; artist: string; artist_id: number; cover_url: string; track_count: number }
export interface Artist { id: number; name: string; picture_url: string }
export interface SearchResults { tracks: Track[]; albums: Album[]; artists: Artist[]; total: number; source: string }
export interface Playlist { id: string; title: string; description?: string; cover_url?: string; tracks: Track[]; createdAt: number }
export type TranslationProvider = 'mymemory' | 'deepseek' | 'google' | 'deepl';
export interface Settings { translation: TranslationProvider; translationLanguage: string; crossfade: number; theme: 'dark' | 'light'; animations: boolean; volume: number }
export interface Library { version: 1; likes: Track[]; history: Track[]; playlists: Playlist[]; settings: Settings }

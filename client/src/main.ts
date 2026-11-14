import './style.css';
import './features.css';
import { icon, hydrateIcons } from './icons.ts';
import { api } from './api.ts';
import type { WaveQueue, DailyMix, Reaction, AuthUser, AuthConfig, TelegramLogin, ResumeSnapshot, ImportPreview } from './api.ts';
import { escapeHtml as e, formatTime, restoreLibrary, safeImage, STORAGE_KEY, isTrack, uniqueTracks, trackArtists, restoreSearchHistory, rememberSearch } from './model.ts';
import { Player } from './player.ts';
import { Wave } from './wave.ts';
import { openArtistPicker } from './preferences.ts';
import type { Track, Album, Artist, SearchResults, Playlist, TranslationProvider } from './types.ts';
import { parseLrc, activeLine, retryLyrics } from './lyrics.ts';
import type { LyricLine } from './lyrics.ts';
import { languageCodes, languageName } from './translation-settings.ts';
import { parseSpotifyExport, type SpotifyExportPlaylist } from './spotify-export.ts';
import { animateDropdown, mountSpringSelect, mountSpringSwitch } from './spring-controls.ts';
import { jellySlider, mountJellySlider } from './jelly-slider.ts';
import { mountPillGroups, selectPillButton, syncTabPill } from './tab-pill.ts';
import { mountPlayerRanges, playerRange } from './player-range.ts';
import { mountCoverParallax } from './cover-parallax.ts';

const app = document.querySelector<HTMLDivElement>('#app')!;
const dialog = document.querySelector<HTMLDialogElement>('#dialog')!;
let library = restoreLibrary(localStorage.getItem(STORAGE_KEY));
const player = new Player(library.settings.volume);
player.setCrossfade(library.settings.crossfade);
const tracks = new Map<string, Track>();
let discovery: Track[] = [];
let discoveryPromise: Promise<Track[]> | undefined;
let wave: Wave | undefined;
let generation = 0;
let currentView = 'home';
let visibleTracks: Track[] = [];
let searchResults: SearchResults | undefined;
let searchFilter = 'all';
let searchQuery = '';
const SEARCH_HISTORY_KEY='yamusic.search-history.v1';
let searchHistory=restoreSearchHistory(localStorage.getItem(SEARCH_HISTORY_KEY));
let searchHistoryTimer=0;
let searchRequest: AbortController | undefined;
let searchTimer = 0;
let toastTimer = 0;
let lastVolume = library.settings.volume || .65;
let lyricsRequest: AbortController | undefined;
let translationRequest: AbortController | undefined;
let translatedLines: string[] | undefined;
let translationVisible = false;
let lyricLines: LyricLine[] = [];
let plainLyricLines: string[] = [];
let activeLyric = -1;
let followLyrics = true;
let waveQueue:WaveQueue|undefined;
let wavePromise:Promise<WaveQueue>|undefined;
let dailyMix:DailyMix|undefined;
let dailyPromise:Promise<DailyMix>|undefined;
let disliked=new Set<string>();
let profileReady:Promise<void>|undefined;
let recommendationUpdate:Promise<void>=Promise.resolve();
let waveContinuation:Promise<void>|undefined;
const failedWaveTracks=new Set<string>();
let lastAnalyzedCount=0;
let authUser:AuthUser|null=null;
let authConfig:AuthConfig={enabled:false};
let authEpoch=0;
let accountBusy=false;
let currentPlaylist: Playlist | undefined;
let playlistSuggestions: Track[] = [];
let authReady: Promise<void> = Promise.resolve();
let restoringPlayback = false;
let lastCloudSave = 0;
let lastCloudPosition = '';
let lastCapture = 0;
let neuroRequest: AbortController | undefined;
let neuroTracks: Track[] = [];
const useMobilePlayer = matchMedia('(max-width: 760px)');
async function refreshAuth():Promise<void>{
  const [config,profile]=await Promise.all([api.authConfig(),api.authMe()]);
  authConfig=config;authUser=profile.user;
  renderAccountAvatars();
}
window.setInterval(()=>{
  if(!authUser||currentView!=='home'||document.hidden)return;
  void api.recommendationStatus().then(status=>{
    if(status.analyzed_tracks===lastAnalyzedCount)return;lastAnalyzedCount=status.analyzed_tracks;
    if(status.likes.length){
      if(waveQueue?.learning&&!player.context){waveQueue=undefined;void getWave().then(drawWaveQueue).catch(()=>{});}
      if(dailyMix&&(!dailyMix.personalized||dailyMix.tracks.length<50)){dailyMix=undefined;void getDaily().then(drawDaily).catch(()=>{});}
    }
  }).catch(()=>{});
},20000);

function syncProfile():Promise<void>{
  return profileReady??=(async()=>{
    await authReady;
    await api.flushReactions();const status=await api.recommendationStatus();disliked=new Set(status.dislikes);
    for(const track of authUser ? [] : library.likes){if(!status.likes.includes(track.id))void api.react({track_id:track.id,action:'like'});}
    await api.flushReactions();
  })().catch(error=>{profileReady=undefined;throw error;});
}
async function getWave():Promise<WaveQueue>{
  if(waveQueue)return waveQueue;
  const epoch=authEpoch;
  return wavePromise??=(async()=>{await syncProfile();await getDiscovery();const data=await api.wave();if(epoch!==authEpoch)throw new Error('Профиль изменился. Обновите подборку.');register(data.tracks);waveQueue=data;return data;})().finally(()=>{if(epoch===authEpoch)wavePromise=undefined;});
}
async function getDaily():Promise<DailyMix>{
  if(dailyMix?.day===new Date().toISOString().slice(0,10)&&dailyMix.tracks.length===50)return dailyMix;
  const epoch=authEpoch;
  return dailyPromise??=(async()=>{await syncProfile();await getDiscovery();const data=await api.dailyMix();if(epoch!==authEpoch)throw new Error('Профиль изменился. Обновите подборку.');data.tracks=data.tracks.filter(t=>!disliked.has(t.id));register(data.tracks);api.prepare(data.tracks.slice(0,3));dailyMix=data;return data;})().finally(()=>{if(epoch===authEpoch)dailyPromise=undefined;});
}
function drawWaveQueue():void{
  const note=document.querySelector('.hero-footnote');
  if(note&&waveQueue)note.textContent=waveQueue.personalized?'Подстраивается под ваш вкус':'Знакомимся с вашим вкусом · ставьте лайки';
}
function drawDaily():void{
  const target=document.querySelector('#daily-cards');if(!target||!dailyMix)return;
  target.innerHTML=dailyMix.tracks.slice(0,5).map(t=>`<article class="music-card"><button class="card-image" data-action="play-daily-track" data-id="${e(t.id)}" aria-label="Включить ${e(t.title)}">${image(t.cover_url)}<span class="card-play">${icon('play')}</span></button><a class="card-title" href="#/album/${t.album_id}" data-action="album" data-id="${t.album_id}">${e(t.title)}</a>${artistLinks(t, "card-artist")}</article>`).join('');
  const detail=document.querySelector('.daily-section .section-heading p');if(detail)detail.textContent=`${trackCount(dailyMix.tracks.length)} · ${dailyMix.personalized?'подобраны для вас':'знакомство с вашим вкусом'}`;hydrateIcons(target as HTMLElement);
}

function register(list: Track[]): Track[] { list.forEach(t => tracks.set(t.id, t)); return list; }
const metadataRequests=new Map<string,Promise<void>>();
function applyTrackMetadata(full:Track):void {
  register([full]);player.queue=player.queue.map(t=>t.id===full.id?full:t);
  for(const list of [library.likes,library.history,...library.playlists.map(p=>p.tracks)])for(let i=0;i<list.length;i++)if(list[i].id===full.id)list[i]=full;
  document.querySelectorAll<HTMLElement>('[data-credits]').forEach(el=>{if(el.dataset.credits===full.id){const replacement=document.createElement('span');replacement.innerHTML=artistLinks(full);el.innerHTML=replacement.firstElementChild!.innerHTML;}});
}
function hydrateSavedCredits(list:Track[]):void {
  const missing=uniqueTracks(list).filter(t=>!t.contributors?.length&&!metadataRequests.has(t.id)).slice(0,100);
  // Reserve IDs before starting workers, so repeated renders cannot duplicate requests.
  for(const track of missing)metadataRequests.set(track.id,Promise.resolve());
  if(!missing.length)return;
  let next=0;
  void Promise.all(Array.from({length:Math.min(3,missing.length)},async()=>{
    while(next<missing.length){const track=missing[next++];const request=api.track(track.id).then(applyTrackMetadata).catch(()=>{metadataRequests.delete(track.id);});metadataRequests.set(track.id,request);await request;}
  })).then(()=>save());
}
function trackCount(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 14 ? 'треков' : n % 10 === 1 ? 'трек' : n % 10 >= 2 && n % 10 <= 4 ? 'трека' : 'треков';
  return `${n} ${suffix}`;
}
register([...library.likes, ...library.history, ...library.playlists.flatMap(p => p.tracks)]);
function save(): boolean {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(library)); return true; }
  catch { toast('Не хватает места для медиатеки. Попробуйте уменьшить обложку или сохранить копию коллекции.'); return false; }
}
function applySettings(): void {
  document.documentElement.dataset.theme = library.settings.theme;
  document.documentElement.dataset.motion = library.settings.animations ? 'on' : 'off';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', library.settings.theme === 'dark' ? '#151617' : '#f3f3f1');
  wave?.setEnabled(library.settings.animations);
}
applySettings();
function toast(message: string): void {
  const target = document.querySelector<HTMLDivElement>('#toast')!;
  target.textContent = message; target.classList.add('visible'); clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => target.classList.remove('visible'), 4200);
}
function image(url: string, alt = '', cls = '', eager = false): string {
  const src = safeImage(url);
  return src ? `<img src="${e(src)}" alt="${e(alt)}" class="${cls}" loading="${eager ? 'eager' : 'lazy'}" referrerpolicy="no-referrer" />` : `<span class="art-placeholder ${cls}">${icon('disc-3')}</span>`;
}
function accountAvatar(): string {
  const src = safeImage(authUser?.avatar_url ?? '');
  return `<span class="telegram-avatar">${icon('circle-user-round')}${src ? `<img src="${e(src)}" alt="" referrerpolicy="no-referrer"/>` : ''}</span>`;
}
function renderAccountAvatars(): void {
  for (const target of app.querySelectorAll<HTMLElement>('[data-account-avatar]')) {
    target.innerHTML = accountAvatar();
    hydrateIcons(target);
  }
}
function artistLinks(track: Track, cls = ""): string {
  return `<span class="artist-credits ${cls}" data-credits="${e(track.id)}">${trackArtists(track).map(a=>`<a href="#/artist/${a.id}" data-action="artist" data-id="${a.id}">${e(a.name)}</a>`).join('<span class="credit-separator">, </span>')}</span>`;
}
function button(action: string, glyph: string, label: string, extra = ''): string {
  return `<button type="button" class="icon-button" data-action="${action}" aria-label="${e(label)}" title="${e(label)}" ${extra}>${icon(glyph)}</button>`;
}
function sectionHeading(title: string, action = '', detail = ''): string {
  return `<div class="section-heading"><div><h2>${e(title)}</h2>${detail ? `<p>${e(detail)}</p>` : ''}</div>${action}</div>`;
}
function empty(title: string, description: string, glyph = 'music-2', action = ''): string {
  return `<div class="empty-state"><span class="empty-icon">${icon(glyph)}</span><h2>${e(title)}</h2><p>${e(description)}</p>${action}</div>`;
}
function loading(): string { return `<div class="loading-state" role="status"><span class="loader"></span><span>Находим вашу музыку…</span></div>`; }
function errorState(error: unknown): string {
  return empty('Музыка ненадолго затихла', error instanceof Error ? error.message : 'Не удалось загрузить каталог.', 'circle-alert', '<button class="primary-button" data-action="reload">Попробовать ещё раз</button>');
}
const navItems = [{ page: 'home', label: 'Главная', glyph: 'house' }, { page: 'search', label: 'Поиск', glyph: 'search' }, { page: 'library', label: 'Медиатека', glyph: 'library' }];
app.innerHTML = `
  <a class="skip-link" href="#main" hidden>Перейти к содержимому</a>
  <div class="app-shell" hidden>
    <aside class="sidebar" aria-label="Боковое меню">
      <a class="brand" href="#/home" aria-label="YaMusic — главная">${icon('audio-lines')}<span>YaMusic<span class="brand-dot">.</span></span></a>
      <nav class="desktop-navigation tab-pill-group" aria-label="Основная навигация">${navItems.map(n => `<a href="#/${n.page}" data-page="${n.page}" class="navigation-link">${icon(n.glyph)}<span>${n.label}</span></a>`).join('')}</nav>
      <div class="settings-account"><a href="#/settings" data-page="settings">${icon('settings-2')}<span>Настройки</span></a><button data-action="account" data-account-avatar aria-label="Мой аккаунт" title="Мой аккаунт">${accountAvatar()}</button></div>
    </aside>
    <div class="workspace">
      <header class="topbar"><div class="breadcrumbs"><span class="topbar-title">Для вас</span><span class="topbar-divider"></span><span>В вашем ритме</span></div><span class="preview-badge">${icon('disc-3')}<span>Музыка в вашем ритме</span></span></header>
      <div class="view-navigation" hidden><button class="back-link" data-action="back">${icon('chevron-left')}Назад</button></div>
      <main id="main" tabindex="-1"></main>
    </div>
    <footer class="player-bar" aria-label="Плеер"></footer>
    <nav class="mobile-navigation tab-pill-group" aria-label="Основная навигация"><span class="tab-pill navigation-lens" aria-hidden="true" hidden></span>${navItems.map(n => `<a href="#/${n.page}" data-page="${n.page}">${icon(n.glyph)}<span>${n.label}</span></a>`).join('')}</nav>
  </div>
  <section class="login-screen" aria-labelledby="login-title">
    <div class="login-card">
      <span class="login-brand">${icon('audio-lines')}YaMusic</span>
      <h1 id="login-title">Вход через Telegram</h1>
      <div id="telegram-login-widget"></div>
      <p class="account-login-status" role="status">Проверяем сеанс…</p>
      <button class="secondary-button" data-action="retry-auth" hidden>Попробовать снова</button>
    </div>
  </section>`;
const main = document.querySelector<HTMLElement>('#main')!;
const playerBar = document.querySelector<HTMLElement>('.player-bar')!;
const mobileNav = document.querySelector<HTMLElement>('.mobile-navigation')!;
const queuePanel = document.createElement('aside');
queuePanel.id = 'playback-queue';
queuePanel.className = 'queue-panel';
queuePanel.setAttribute('popover','manual');
queuePanel.setAttribute('aria-label','Очередь воспроизведения');
app.append(queuePanel);
const playlistMenu = document.createElement('section');
playlistMenu.id = 'playlist-menu';
playlistMenu.className = 'playlist-menu';
playlistMenu.setAttribute('popover','manual');
playlistMenu.setAttribute('aria-label','Добавить в плейлист');
app.append(playlistMenu);
let playlistMenuTrigger: HTMLElement | undefined;
const songActions = document.createElement('section');
songActions.id = 'song-actions';
songActions.className = 'playlist-menu song-actions';
songActions.setAttribute('popover','manual');
songActions.setAttribute('aria-label','Действия с песней');
app.append(songActions);
let songActionsTrigger: HTMLElement | undefined;
let prepareIntent:ReturnType<typeof setTimeout>;
for(const event of ['pointerover','focusin']) main.addEventListener(event,e=>{
  const row=(e.target as Element).closest<HTMLElement>('[data-track-row]');
  clearTimeout(prepareIntent);
  if(row)prepareIntent=setTimeout(()=>{
    const track=tracks.get(row.dataset.trackRow!);if(track)api.prepare([track]);
  },200);
});

function row(track: Track, index = 0, playAction = 'play'): string {
  const liked = library.likes.some(t => t.id === track.id);
  return `<div class="track-row ${player.current?.id === track.id ? 'current-track' : ''}" data-track-row="${e(track.id)}">
    <span class="track-number">${String(index + 1).padStart(2, '0')}</span>
    <button class="track-cover" data-action="${playAction}" data-id="${e(track.id)}" aria-label="Включить ${e(track.title)}">${image(track.cover_url)}<span class="cover-play">${icon('play')}</span></button>
    <div class="track-title"><a class="track-name" href="#/album/${track.album_id}" data-action="album" data-id="${track.album_id}"><strong class="moving-title-text">${e(track.title)}${track.is_explicit ? '<span class="explicit-badge" title="Ненормативная лексика">E</span>' : ''}</strong></a>${artistLinks(track, "track-artist")}</div>
    <button class="track-album" data-action="album" data-id="${track.album_id}">${e(track.album)}</button>
    <span class="track-duration">${formatTime(track.duration_sec)}</span>
    <button class="icon-button like-button ${liked ? 'liked' : ''}" data-action="like" data-id="${e(track.id)}" aria-label="${liked ? 'Убрать из любимого' : 'В любимое'}" aria-pressed="${liked}">${icon('heart')}</button>
    ${button('add-playlist-menu','plus','Добавить в плейлист',`data-id="${e(track.id)}" aria-expanded="false" aria-controls="playlist-menu"`)}
    ${button('track-menu', 'ellipsis', `Действия с треком ${track.title}`, `data-id="${e(track.id)}" aria-expanded="false" aria-controls="song-actions"`)}
  </div>`;
}
function rows(list: Track[], max = 50): string { register(list); api.prepare(list.slice(0,3)); return `<div class="track-list">${list.slice(0, max).map((track,index)=>row(track,index)).join('')}</div>`; }
function albumCard(album: Album): string {
  return `<article class="music-card"><a class="card-image" href="#/album/${album.id}" data-action="album" data-id="${album.id}" aria-label="Альбом ${e(album.title)}">${image(album.cover_url)}<span class="card-play">${icon('play')}</span></a><a class="card-title" href="#/album/${album.id}" data-action="album" data-id="${album.id}">${e(album.title)}</a><a class="card-artist" href="#/artist/${album.artist_id}" data-action="artist" data-id="${album.artist_id}">${e(album.artist)}</a></article>`;
}
function artistCard(artist: Artist): string {
  return `<button class="music-card artist-card" data-action="artist" data-id="${artist.id}"><span class="card-image">${image(artist.picture_url)}</span><strong>${e(artist.name)}</strong><span>Исполнитель</span></button>`;
}
const moods = [
  { title: 'Ночной маршрут', subtitle: 'Город остаётся позади', query: 'Три дня дождя', art: 'night' },
  { title: 'Тихий вечер', subtitle: 'Никуда не торопиться', query: 'Моя Мишель', art: 'evening' },
  { title: 'В потоке', subtitle: 'Меньше шума. Больше фокуса.', query: 'Антоха МС', art: 'focus' },
  { title: 'Без слов', subtitle: 'Когда музыка говорит сама', query: 'Миша Мищенко', art: 'ambient' },
];
const moodCovers=new Map<string,string>();
const moodCoverRequests=new Map<string,Promise<void>>();
function moodCard(m: typeof moods[number]): string {
  return `<button class="music-card mood-card" data-action="mood" data-query="${e(m.query)}" data-title="${e(m.title)}"><span class="card-image mood-art ${m.art}" data-mood-cover="${e(m.query)}">${moodCovers.has(m.query)?image(moodCovers.get(m.query)!):''}<span class="art-ribbon"></span><span class="mood-symbol">${icon(m.art === 'focus' ? 'audio-lines' : m.art === 'ambient' ? 'waves' : 'disc-3')}</span><span class="card-play">${icon('play')}</span></span><strong>${e(m.title)}</strong><span>${e(m.subtitle)}</span></button>`;
}

function loadMoodCovers():void{
  for(const mood of moods){
    if(!moodCoverRequests.has(mood.query))moodCoverRequests.set(mood.query,api.search('artist:"'+mood.query+'"','track').then(data=>{const cover=data.tracks.find(t=>safeImage(t.cover_url))?.cover_url;if(cover)moodCovers.set(mood.query,cover);}).catch(()=>{}));
    void moodCoverRequests.get(mood.query)!.then(()=>{const cover=moodCovers.get(mood.query);if(!cover)return;main.querySelectorAll<HTMLElement>('[data-mood-cover]').forEach(el=>{if(el.dataset.moodCover===mood.query&&!el.querySelector('img'))el.insertAdjacentHTML('afterbegin',image(cover));});});
  }
}
async function getDiscovery(): Promise<Track[]> {
  if (discovery.length) return discovery;
  if (!discoveryPromise) {
    const epoch=authEpoch;
    discoveryPromise=api.discover().then(data=>{
      if(epoch!==authEpoch)return [];
      discovery=register(data.tracks);api.prepare(discovery.slice(0,3));return discovery;
    }).finally(()=>{if(epoch===authEpoch)discoveryPromise=undefined;});
  }
  return discoveryPromise;
}
function home(): void {
  hydrateSavedCredits(library.history.slice(0,4));
  main.innerHTML = `<div class="home-content"><section class="home-hero" aria-label="Моя волна"><canvas class="wave-canvas" aria-hidden="true"></canvas><div class="hero-main"><h1>Моя волна</h1><div class="hero-controls">${button('previous', 'skip-back', 'Предыдущий трек')}<button class="wave-play" data-action="wave" aria-label="Включить Мою волну">${icon(player.context&&player.playing ? 'pause' : 'play')}</button>${button('next', 'skip-forward', 'Следующий трек')}</div><span class="hero-footnote">Знакомимся с вашим вкусом</span></div></section>
    <section class="neuro-banner"><div class="neuro-heading"><span class="neuro-icon">${icon('sparkles')}</span><div><h2>Нейро-волна</h2></div></div><form id="neuro-form"><input name="mood" aria-label="Настроение для Нейро-волны" placeholder="Настроение, жанр или исполнитель…" maxlength="300"/><button class="icon-button" aria-label="Создать Нейро-волну">${icon('arrow-right')}</button></form></section>
    <section id="neuro-results" class="section" hidden></section>
    <section class="section daily-section">${sectionHeading('Микс дня', '<a class="text-button" href="#/daily">Все треки '+icon('arrow-right')+'</a>', 'Найти что-то близкое. Услышать что-то новое.')}<div class="card-rail" id="daily-cards">${loading()}</div></section>
    <section class="section">${sectionHeading('Откройте новое', '<a class="text-button" href="#/search">Весь каталог '+icon('arrow-right')+'</a>')}<div id="discovery-tracks">${loading()}</div></section>
    <section class="section" id="recent-section">${library.history.length ? sectionHeading('Недавно слушали', '<a class="text-button" href="#/history">Вся история '+icon('arrow-right')+'</a>') + rows(library.history, 4) : ''}</section>
    <p class="page-footnote">YaMusic · музыка в вашем ритме</p></div>`;
  hydrateIcons(main);
  wave = new Wave(main.querySelector<HTMLCanvasElement>('.wave-canvas')!, () => player.playing, () => ({...player.visualAudio(),palette:player.palette}));
  wave.setEnabled(library.settings.animations);
  const gen = generation;
  void getDiscovery().then(list => {
    if (gen !== generation) return;
    const heard=new Set([...library.history,...library.likes].map(track=>track.id));
    visibleTracks=list.filter(track=>!heard.has(track.id));
    document.querySelector('#discovery-tracks')!.innerHTML=visibleTracks.length?rows(visibleTracks,5):'<p class="muted">Новые треки появятся здесь.</p>'; hydrateIcons(main);
  }).catch(error => {
    if (gen !== generation) return;
    document.querySelector('#discovery-tracks')!.innerHTML = errorState(error);
    hydrateIcons(main);
  });
  void getWave().then(()=>{if(gen===generation)drawWaveQueue();}).catch(()=>{});
  void getDaily().then(()=>{if(gen===generation)drawDaily();}).catch(()=>{if(gen===generation)document.querySelector('#daily-cards')!.innerHTML='<p class="muted">Микс пока недоступен</p>';});
}

function search(): void {
  main.innerHTML = `<div class="page-heading"><div><span class="eyebrow">ВЕСЬ МИР МУЗЫКИ</span><h1>Поиск</h1></div></div><form class="search-form" id="search-form" role="search">${icon('search')}<input id="search-input" name="q" type="search" placeholder="Трек, исполнитель или альбом" autocomplete="off" aria-label="Поиск музыки" maxlength="200" value="${e(searchQuery)}"/><kbd>↵</kbd></form><button class="text-button lyric-search-link" data-action="search-by-lyrics">${icon('sparkles')}Найти по строке песни</button><div class="filter-row"><div class="tab-pill-group" role="group" aria-label="Что искать">${[['all','Всё'],['track','Треки'],['album','Альбомы'],['artist','Исполнители']].map(([id,title])=>`<button class="chip ${searchFilter === id ? 'selected' : ''}" data-action="search-filter" data-filter="${id}" aria-pressed="${searchFilter === id}">${title}</button>`).join('')}</div></div><div id="search-results"></div>`;
  if (searchQuery && searchResults) drawSearchResults();
  else if (searchQuery) void runSearch();
  else drawSearchStart();
  hydrateIcons(main);
  syncTabPill(main.querySelector<HTMLElement>(".tab-pill-group")!);
}
function saveSearchHistory():void {try{localStorage.setItem(SEARCH_HISTORY_KEY,JSON.stringify(searchHistory));}catch{/* Browsing remains available with full storage. */}}
function rememberCurrentSearch():void {if(!searchQuery.trim())return;searchHistory=rememberSearch(searchHistory,searchQuery);saveSearchHistory();}
function drawSearchStart(): void {
  loadMoodCovers();
  document.querySelector('#search-results')!.innerHTML = `<section class="section search-history">${sectionHeading('Вы недавно искали',searchHistory.length?'<button class="text-button" data-action="clear-search-history">Очистить</button>':'')}${searchHistory.length?`<div class="search-history-items">${searchHistory.map((q,index)=>`<span class="history-chip"><button data-action="search-suggestion" data-query="${e(q)}">${e(q)}</button><button data-action="remove-search-history" data-index="${index}" aria-label="Убрать ${e(q)} из истории">${icon('x')}</button></span>`).join('')}</div>`:'<p class="muted">Здесь появятся ваши поисковые запросы. Историю можно очистить в любой момент.</p>'}</section><section class="section">${sectionHeading('Что послушаем?', '', 'Выберите настроение или найдите что-то своё')}<div class="card-rail">${moods.map(moodCard).join('')}</div></section>`;
  hydrateIcons(main);
}
let lyricSearchRequest: AbortController | undefined;
let lyricMatches: Track[] = [];
function openLyricSearch(): void {
  const query=main.querySelector<HTMLInputElement>('#search-input')?.value.trim()??'';
  showDialog('Поиск по строке песни',`
    <form id="lyric-search-form" class="lyric-search-form">
      <label for="lyric-search-input">Вставьте несколько слов, которые помните. Можно добавить имя исполнителя.</label>
      <input id="lyric-search-input" class="text-input" name="line" maxlength="200" required value="${e(query)}" placeholder="Строка из песни" autofocus>
      <button class="primary-button" type="submit">Найти песню</button>
    </form><div id="lyric-search-results" aria-live="polite"></div>`);
}
async function findByLyrics(form: HTMLFormElement): Promise<void> {
  const input=form.querySelector('input')!;
  const phrase=input.value.trim();
  if(phrase.length<2){input.focus();return;}
  lyricSearchRequest?.abort();
  const controller=new AbortController();
  lyricSearchRequest=controller;
  lyricMatches=[];
  const result=dialog.querySelector<HTMLElement>('#lyric-search-results')!;
  const submit=form.querySelector('button')!;
  submit.disabled=true;
  result.textContent='Ищем песню по словам…';
  try {
    const {tracks}=await api.smartSearch(phrase,controller.signal);
    if(controller.signal.aborted||!result.isConnected)return;
    lyricMatches=register(tracks);
    result.innerHTML=tracks.length?`<div class="track-list">${tracks.map((track,index)=>row(track,index,'play-lyric-match')).join('')}</div>`:
      '<p class="muted">Совпадений не нашлось. Попробуйте другую строку или добавьте имя исполнителя.</p>';
    hydrateIcons(result);
  } catch(error) {
    if(!controller.signal.aborted&&result.isConnected)result.textContent=error instanceof Error?error.message:'Не удалось выполнить поиск.';
  } finally { if(submit.isConnected)submit.disabled=false; }
}
async function runSearch(): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('#search-input');
  const query = (input?.value ?? searchQuery).trim();
  clearTimeout(searchHistoryTimer);searchQuery = query; searchRequest?.abort(); searchResults = undefined;
  if (!query) { drawSearchStart(); return; }
  const container = document.querySelector('#search-results'); if (!container) return;
  container.innerHTML = loading();
  const controller = new AbortController(); searchRequest = controller;
  const gen = generation;
  try {
    const result = await api.search(query, searchFilter, 0, controller.signal);
    if (gen !== generation || controller.signal.aborted) return;
    searchResults = result; register(result.tracks); api.prepare(result.tracks.slice(0,3)); visibleTracks = result.tracks; drawSearchResults();
    searchHistoryTimer=window.setTimeout(()=>{if(searchQuery===query)rememberCurrentSearch();},1500);

  } catch (error) {
    if (gen !== generation || controller.signal.aborted) return;
    container.innerHTML = errorState(error); hydrateIcons(main);
  }
}
function drawSearchResults(): void {
  const data = searchResults; if (!data) return;
  const container = document.querySelector('#search-results')!;
  if (!data.tracks.length && !data.albums.length && !data.artists.length) {
    container.innerHTML = empty('Пока ничего не нашлось', 'Попробуйте другое название или имя исполнителя.', 'search');
  } else {
    container.innerHTML = `<p class="results-caption">Результаты по запросу «${e(searchQuery)}»</p>${data.artists.length ? `<section class="section artists-section">${sectionHeading('Исполнители')}<div class="artist-rail">${data.artists.slice(0, searchFilter === 'all' ? 4 : 12).map(artistCard).join('')}</div></section>` : ''}${data.tracks.length ? `<section class="section">${sectionHeading('Треки', '<span class="subtle-label">Каталог Deezer</span>')}${rows(data.tracks, searchFilter === 'all' ? 6 : 24)}</section>` : ''}${data.albums.length ? `<section class="section">${sectionHeading('Альбомы')}<div class="${searchFilter === 'all' ? 'card-rail' : 'card-grid'}">${data.albums.slice(0, searchFilter === 'all' ? 5 : 24).map(albumCard).join('')}</div></section>` : ''}<p class="page-footnote">Каталог Deezer · доступны первые ${data.tracks.length + data.artists.length + data.albums.length} результатов</p>`;
  }
  hydrateIcons(main);
}

let libraryFilter = 'all';
function libraryView(): void {
  hydrateSavedCredits([...library.likes,...library.history.slice(0,5),...library.playlists.flatMap(p=>p.tracks.slice(0,1))]);
  visibleTracks = library.likes;
  if (!main.querySelector("#library-results")) main.innerHTML = `<div class="page-heading"><div><span class="eyebrow">ТО, ЧТО БЛИЗКО</span><h1>Медиатека</h1></div><div class="heading-actions"><a class="secondary-button library-settings" href="#/settings" aria-label="Настройки" title="Настройки">${icon('settings-2')}</a><button class="secondary-button" data-action="import" aria-label="Импорт коллекции">${icon('import')}<span>Импорт</span></button><button class="secondary-button" data-action="new-playlist" aria-label="Создать плейлист">${icon('plus')}<span>Плейлист</span></button></div></div><div class="filter-row"><div class="tab-pill-group" role="group" aria-label="Раздел медиатеки">${[['all','Всё'],['playlists','Плейлисты'],['likes','Мне нравится'],['artists','Исполнители']].map(([id,label])=>`<button class="chip ${libraryFilter === id ? 'selected' : ''}" data-action="library-filter" data-filter="${id}" aria-pressed="${libraryFilter === id}">${label}</button>`).join('')}</div><span class="local-library-note">На этом устройстве</span></div><div id="library-results"></div>`;
  const group = main.querySelector<HTMLElement>('.tab-pill-group')!;
  selectPillButton(group, 'data-filter', libraryFilter);
  const results = main.querySelector<HTMLElement>('#library-results')!;
  results.replaceChildren();
  if (libraryFilter === 'artists') {
    const section=document.createElement('section');
    section.className='section';section.innerHTML=loading();results.append(section);
    const epoch=authEpoch;
    void authReady.then(()=>api.favoriteArtists()).then(({artists})=>{
      if(!section.isConnected||epoch!==authEpoch)return;
      section.innerHTML=artists.length
        ? sectionHeading('Любимые исполнители')+'<div class="card-grid">'+artists.map(artistCard).join('')+'</div>'
        : empty('Пока нет подписок','Подпишитесь на исполнителя в его карточке.','circle-user-round','<a class="primary-button" href="#/search">Найти исполнителей</a>');
      hydrateIcons(section);
    }).catch(error=>{if(section.isConnected&&epoch===authEpoch){section.innerHTML=errorState(error);hydrateIcons(section);}});
  } else if (libraryFilter === 'likes') {
    results.insertAdjacentHTML('beforeend', library.likes.length ? `<section class="section">${sectionHeading('Мне нравится', `<button class="primary-button" data-action="play-likes">${icon('play')}Слушать</button>`)}${rows(library.likes)}</section>` : empty('Здесь будет любимая музыка', 'Нажмите сердечко рядом с треком — он останется здесь.', 'heart', '<a href="#/search" class="primary-button">Найти музыку</a>'));
  } else {
    results.insertAdjacentHTML('beforeend', `<div class="card-grid library-grid">${libraryFilter === 'all' ? `<button class="music-card" data-action="library-filter" data-filter="likes"><span class="card-image favorites-art">${icon('heart')}</span><strong>Мне нравится</strong><span>${library.likes.length ? trackCount(library.likes.length) : 'Самое близкое — здесь'}</span></button>` : ''}${library.playlists.map(p=>`<button class="music-card" data-action="playlist" data-id="${e(p.id)}"><span class="card-image ${p.cover_url || p.tracks.length ? '' : 'empty-playlist-art'}">${p.cover_url || p.tracks.length ? image(p.cover_url || p.tracks[0].cover_url) : icon('list-music')}</span><strong>${e(p.title)}</strong><span>${trackCount(p.tracks.length)}</span></button>`).join('')}<button class="music-card new-playlist-card" data-action="new-playlist"><span class="card-image">${icon('plus')}</span><strong>Новый плейлист</strong><span>Музыка под ваш момент</span></button></div>${library.history.length ? `<section class="section">${sectionHeading('Недавно слушали', '<a class="text-button" href="#/history">Вся история '+icon('arrow-right')+'</a>')}${rows(library.history,5)}</section>` : `<section class="library-welcome">${icon('audio-lines')}<div><h2>Всё начинается с одной песни</h2><p>Сохраняйте любимое и собирайте свои плейлисты.</p></div><a class="text-button" href="#/search">В каталог ${icon('arrow-right')}</a></section>`}`);
  }
  hydrateIcons(main);
}
function historyView(): void {
  hydrateSavedCredits(library.history);
  visibleTracks=library.history;
  main.innerHTML=`<div class="page-heading"><div><span class="eyebrow">ВАША МУЗЫКА</span><h1>История</h1></div>${library.history.length?'<div class="history-heading-actions"><button class="text-button" data-action="clear-listening-history">Очистить</button><button class="primary-button" data-action="play-list">'+icon('play')+'Слушать</button></div>':''}</div><p class="results-caption">Последние 100 разных песен · на этом устройстве</p>${library.history.length?rows(library.history,100):empty('Здесь пока тихо','Включите музыку — прослушанные песни появятся здесь.','music-2','<a class="primary-button" href="#/search">Найти музыку</a>')}`;
  hydrateIcons(main);
}
const translationLabels:Record<TranslationProvider,string>={mymemory:'MyMemory · бесплатно',deepseek:'ИИ',google:'Google Переводчик',deepl:'DeepL'};
const translationLanguages = languageCodes.map(value => ({ value, label: languageName(value) }))
  .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
let closeTranslationMenus: (() => void) | undefined;

function translationTrigger(id: string, label: string, value: string): string {
  return `<button type="button" class="secondary-button spring-select" id="${id}" aria-label="${e(label)}: ${e(value)}" aria-haspopup="dialog" aria-expanded="false">
    <span class="spring-select-label"><span class="spring-select-value">${e(value)}</span></span>${icon('chevron-down')}
  </button>`;
}

function mountTranslationSettings(): void {
  const providers = Object.entries(translationLabels).map(([value, label]) => ({
    value, label, disabled: value === 'google' && !authConfig.google_translate || value === 'deepl' && !authConfig.deepl,
  }));
  const closeProvider = mountSpringSelect(
    main.querySelector<HTMLButtonElement>('#translation-provider')!, 'Сервис перевода', providers, library.settings.translation,
    value => { library.settings.translation = value as TranslationProvider; save(); },
  );
  const closeLanguage = mountSpringSelect(
    main.querySelector<HTMLButtonElement>('#translation-language')!, 'Язык перевода', translationLanguages, library.settings.translationLanguage,
    value => { library.settings.translationLanguage = value; save(); }, true,
  );
  closeTranslationMenus = () => { closeProvider(); closeLanguage(); };
}
function settings(): void {
  closeTranslationMenus?.();
  main.innerHTML = `<div class="page-heading"><div><span class="eyebrow">ВАШЕ ПРОСТРАНСТВО</span><h1>Настройки</h1></div></div><div class="settings-content"><button class="profile-summary" data-action="account"><span class="profile-avatar" data-account-avatar>${accountAvatar()}</span><span><strong>${authUser?e(authUser.first_name||authUser.username||"Мой профиль"):"Мой профиль"}</strong><small>${authUser?"Telegram подключён":"Войти через Telegram"}</small></span>${icon('chevron-right')}</button><section class="settings-group"><h2>Оформление</h2><div class="setting-row"><div class="setting-label">${icon('palette')}<span>Тема</span></div><div class="segmented tab-pill-group" role="group" aria-label="Цветовая тема"><button data-action="theme" data-theme="dark" class="${library.settings.theme === 'dark' ? 'selected' : ''}" aria-pressed="${library.settings.theme === 'dark'}">Тёмная</button><button data-action="theme" data-theme="light" class="${library.settings.theme === 'light' ? 'selected' : ''}" aria-pressed="${library.settings.theme === 'light'}">Светлая</button></div></div><label class="setting-row"><span class="setting-label">${icon('waves')}<span><span id="animations-label">Анимации</span><small id="animations-description">Живая волна и анимация интерфейса</small></span></span><span class="spring-switch"><input id="animations" type="checkbox" role="switch" aria-labelledby="animations-label" aria-describedby="animations-description" ${library.settings.animations ? 'checked' : ''}><span class="spring-switch-thumb" aria-hidden="true"></span></span></label></section><section class="settings-group"><h2>Воспроизведение</h2><label class="setting-row crossfade-setting"><span class="setting-label"><span><span id="crossfade-label">Плавный переход</span><small id="crossfade-description">Новый трек начинает звучать перед концом предыдущего</small></span></span>${jellySlider(library.settings.crossfade)}</label></section><section class="settings-group"><h2>Тексты песен</h2><div class="setting-row"><span class="setting-label">${icon('mic-2')}Сервис перевода</span>${translationTrigger('translation-provider', 'Сервис перевода', translationLabels[library.settings.translation])}</div><div class="setting-row"><span class="setting-label">Язык перевода</span>${translationTrigger('translation-language', 'Язык перевода', languageName(library.settings.translationLanguage))}</div></section><section class="settings-group"><h2>Рекомендации</h2><div class="setting-row"><span class="setting-label">${icon('waves')}<span>Любимые исполнители<small>Помогите волне лучше узнать вас</small></span></span><button class="text-button" data-action="favorite-artists">Выбрать ${icon('chevron-right')}</button></div><div class="setting-row"><span class="setting-label">${icon('thumbs-down')}<span>Не рекомендовать</span></span><button class="text-button" data-action="blocked-tracks">Посмотреть список ${icon('chevron-right')}</button></div></section><section class="settings-group"><h2>Медиатека</h2><div class="setting-row"><span class="setting-label">${icon('library')}<span>Ваша коллекция<small>${library.likes.length} любимых · ${library.playlists.length} плейлистов</small></span></span><button class="text-button" data-action="export">Сохранить копию ${icon('download')}</button></div><div class="setting-row"><span class="setting-label">${icon('import')}<span>Перенос музыки</span></span><button class="text-button" data-action="import">Открыть ${icon('arrow-right')}</button></div></section><div class="settings-about">${icon('audio-lines')}<span><strong>YaMusic</strong><small>В вашем ритме · версия 0.1</small></span></div></div>`;
  hydrateIcons(main);
  syncTabPill(main.querySelector<HTMLElement>('.tab-pill-group')!);
  mountJellySlider(main.querySelector<HTMLInputElement>('#crossfade')!);
  mountTranslationSettings();
  mountSpringSwitch(main.querySelector<HTMLInputElement>('#animations')!);
}

async function detail(kind: string, id: string, gen: number): Promise<void> {
  main.innerHTML = loading();
  try {
    if (kind === 'daily') {
      const data=await getDaily();if(gen!==generation)return;visibleTracks=register(data.tracks);
      main.innerHTML=`<div class="collection-header"><div class="collection-art mood-art evening">${icon('audio-lines')}</div><div><span class="eyebrow">КАЖДЫЙ ДЕНЬ ЗАНОВО</span><h1>Микс дня</h1><p>${trackCount(data.tracks.length)} · ${data.personalized?'для вашего вкуса':'пока знакомимся с вами'}</p><button class="primary-button" data-action="play-list" ${data.tracks.length?'':'disabled'}>${icon('play')}Слушать всё</button></div></div>${rows(data.tracks)}`;
    } else if (kind === 'playlist') {
      const p = library.playlists.find(item => item.id === id);
      if (!p) { main.innerHTML = empty('Плейлист не найден', 'Возможно, его уже удалили.', 'list-music'); return; }
      currentPlaylist = p;
      main.innerHTML = `<div class="collection-header playlist-header">
          <div class="collection-art" data-playlist-art></div>
          <div><span class="eyebrow">ВАШ ПЛЕЙЛИСТ</span><h1>${e(p.title)}</h1>
            ${p.description ? `<p class="playlist-description">${e(p.description)}</p>` : ''}
            <p data-playlist-count></p>
            <div class="collection-actions"><button class="primary-button" data-action="play-list">${icon('play')}Слушать</button>
              <button class="secondary-button" data-action="rename-playlist" data-id="${e(p.id)}">Редактировать</button>
              ${button('delete-playlist','trash-2','Удалить плейлист',`data-id="${e(p.id)}"`)}
            </div>
          </div>
        </div>
        <div data-playlist-tracks></div>
        <section class="section playlist-discovery" aria-label="Добавить музыку">
          ${sectionHeading('Добавить музыку','<a href="#/search" class="text-button">Поиск</a>')}
          <div class="playlist-discovery-columns">
            <section><h3>Мне нравится</h3><div data-playlist-likes></div></section>
            <section><h3>Может понравиться</h3><div data-playlist-suggestions>${loading()}</div></section>
          </div>
        </section>`;
      updatePlaylistContents(p);
      void loadPlaylistSuggestions(p, gen);
    } else if (kind === 'mood') {
      const mood = moods.find(m => m.query === id) ?? { query: id, title: id, art: 'night' };
      const data = await api.search('artist:"'+mood.query+'"', 'track'); if (gen !== generation) return;
      visibleTracks = register(data.tracks);
      main.innerHTML = `<div class="collection-header"><div class="collection-art mood-art ${mood.art}">${data.tracks[0]?image(data.tracks[0].cover_url):icon('waves')}</div><div><span class="eyebrow">СМЕНА НАСТРОЕНИЯ</span><h1>${e(mood.title)}</h1><p>Знакомство с музыкой · ${e(mood.query)}</p><button class="primary-button" data-action="play-list">${icon('play')}Слушать</button></div></div>${rows(data.tracks)}`;
    } else if (kind === 'album') {
      const data = await api.album(Number(id)); if (gen !== generation) return;
      visibleTracks = register(data.tracks);
      main.innerHTML = `<div class="collection-header"><div class="collection-art">${image(data.album.cover_url)}</div><div><span class="eyebrow">АЛЬБОМ</span><h1>${e(data.album.title)}</h1><button class="artist-link" data-action="artist" data-id="${data.album.artist_id}">${e(data.album.artist)} ${icon('arrow-up-right')}</button><p>${trackCount(data.tracks.length)} · Deezer</p><button class="primary-button" data-action="play-list" ${data.tracks.length ? '' : 'disabled'}>${icon('play')}Слушать</button></div></div>${rows(data.tracks)}`;
    } else {
      const data = await api.artist(Number(id)); if (gen !== generation) return;
      visibleTracks = register(data.tracks);
      main.innerHTML = `<div class="collection-header artist-header"><div class="collection-art">${image(data.artist.picture_url)}</div><div><span class="eyebrow">ИСПОЛНИТЕЛЬ</span><h1>${e(data.artist.name)}</h1><div class="collection-actions"><button class="primary-button" data-action="play-list" ${data.tracks.length ? '' : 'disabled'}>${icon('play')}Слушать</button><button class="secondary-button" data-action="artist-follow" data-id="${data.artist.id}" aria-pressed="false" disabled>Подписаться</button></div></div></div><section class="section">${sectionHeading('Треки')}${rows(data.tracks, 30)}</section><section class="section">${sectionHeading('Альбомы')}<div class="card-grid">${data.albums.map(albumCard).join('')}</div></section>`;
      const follow=main.querySelector<HTMLButtonElement>('[data-action="artist-follow"]')!;
      void authReady.then(()=>api.favoriteArtists()).then(({artists})=>{if(follow.isConnected)setFollowButton(follow,artists.some(a=>a.id===data.artist.id));}).catch(()=>{if(follow.isConnected)follow.disabled=false;});
    }
    if (gen === generation) hydrateIcons(main);
  } catch (error) { if (gen === generation) { main.innerHTML = errorState(error); hydrateIcons(main); } }
}

function navigate(): void {
  if(!authUser)return;
  closeTranslationMenus?.(); closeTranslationMenus = undefined;
  closePlaylistMenu();closeSongActions();neuroRequest?.abort();currentPlaylist=undefined;playlistSuggestions=[];
  if(currentView==='search'&&searchResults)rememberCurrentSearch();
  generation++; searchRequest?.abort(); clearTimeout(searchTimer); wave?.destroy(); wave = undefined;
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const page = parts[0] || 'home';
  currentView = page;
  updateBackButton(page);
  const navPage = ['album','artist','mood'].includes(page) ? 'search' : ['playlist','history'].includes(page) ? 'library' : page==='daily'?'home':page;
  document.querySelectorAll<HTMLElement>('[data-page]').forEach(link => {
    const selected = link.dataset.page === navPage;
    link.classList.toggle('selected', selected);
    if (selected) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
  syncTabPill(app.querySelector<HTMLElement>('.desktop-navigation')!, true);
  syncTabPill(mobileNav, true);
  document.querySelector('.topbar-title')!.textContent = ({home:'Для вас',search:'Поиск',library:'Медиатека',settings:'Настройки',album:'Альбом',artist:'Исполнитель',playlist:'Плейлист',mood:'Подборка',daily:'Микс дня',history:'История'} as Record<string,string>)[page] || 'YaMusic';
  main.className = `view-${page}`; main.scrollTop = 0; visibleTracks = [];
  if (page === 'home') home(); else if (page === 'search') search(); else if (page === 'library') libraryView(); else if (page === 'settings') settings();
  else if(page==='history')historyView();
  else if(page==='daily')void detail('daily','',generation);
  else if (['album','artist','playlist','mood'].includes(page) && parts[1]) {
    let id; try { id = decodeURIComponent(parts.slice(1).join('/')); } catch { id = ''; }
    void detail(page, id, generation);
  } else { location.hash = '/home'; }
  hydrateIcons(app);
}
function go(page: string): void { if (location.hash === `#/${page}`) navigate(); else location.hash = `/${page}`; }

let routeDepth=0;
let knownRoute: string | undefined;
function updateBackButton(page: string): void {
  const route=location.hash;
  const state=history.state as {yaMusicDepth?:number} | null;
  if(state?.yaMusicDepth!==undefined)routeDepth=state.yaMusicDepth;
  else if(knownRoute!==undefined && knownRoute!==route)routeDepth++;
  history.replaceState({...state,yaMusicDepth:routeDepth},'');
  knownRoute=route;
  const bar=app.querySelector<HTMLElement>('.view-navigation')!;
  const hasBack=!['home','search','library','settings'].includes(page);
  bar.hidden=!hasBack;
  bar.parentElement!.classList.toggle('has-back',hasBack);
}
function navigateBack(): void {
  if(routeDepth>0){ history.back(); return; }
  go(['playlist','history','settings'].includes(currentView)?'library':['album','artist'].includes(currentView)?'search':'home');
}

function volumeControl(): string {
  return `<div class="volume-group">
    <button class="icon-button mute-button" data-action="mute" aria-label="Выключить звук">${icon('volume-2')}</button>
    ${playerRange('volume', player.volume, 1)}
  </div>`;
}

function renderPlayer(): void {
  const t = player.current;
  playerBar.classList.toggle('has-track', !!t);
  playerBar.innerHTML = `<div class="player-information"><button class="player-art" data-action="expand" ${t ? '' : 'disabled'} aria-label="Открыть плеер">${t ? image(t.cover_url, '', '', true) : icon('disc-3')}</button><div class="player-track-name">${t ? `<button class="player-name-link" data-action="expand"><span class="moving-title-text">${e(t.title)}</span></button><span class="mobile-track-artist">${e(trackArtists(t).map(a=>a.name).join(', '))}</span>${artistLinks(t, "player-artist-link")}` : '<strong>С чего начнём?</strong><span>Найдите музыку по настроению</span>'}</div><button class="icon-button like-button player-like" data-action="like-current" aria-label="В любимое" ${t ? '' : 'disabled'}>${icon('heart')}</button>${t ? button('add-playlist-menu','plus','Добавить в плейлист',`data-id="${e(t.id)}" aria-expanded="false" aria-controls="playlist-menu" data-player-add`) : ''}</div><div class="player-transport"><div class="transport-buttons"><button class="icon-button shuffle-button" data-action="shuffle" aria-label="Перемешать" aria-pressed="${player.shuffle}">${icon('shuffle')}</button>${button('previous','skip-back','Предыдущий трек')}<button class="transport-play" data-action="toggle" aria-label="Воспроизвести">${icon('play')}</button>${button('next','skip-forward','Следующий трек')}<button class="icon-button repeat-button" data-action="repeat" aria-label="Повтор выключен">${icon('repeat')}</button></div><div class="player-timeline"><span data-elapsed>0:00</span>${playerRange('seek', player.time, player.duration, !t)}<span data-duration>${formatTime(player.duration)}</span></div></div><div class="player-end">${volumeControl()}<div class="player-extras">${button('lyrics','mic-2','Текст песни')}${button('queue','list-music','Очередь','aria-controls="playback-queue" aria-expanded="false"')}</div></div><div class="mobile-player-actions"><button class="icon-button" data-action="toggle" aria-label="Воспроизвести" data-mobile-play>${icon('play')}</button></div><div class="mobile-progress">${playerRange('seek', player.time, player.duration, !t)}</div>`;
  mountPlayerRanges(playerBar);
  if(playlistMenuTrigger&&!playlistMenuTrigger.isConnected)closePlaylistMenu();
  updatePlayerControls(); updateQueueButtons(); hydrateIcons(playerBar); updateProgress();
}
function replaceIcon(el: HTMLElement | null, name: string): void { if (el) { el.innerHTML = icon(name); hydrateIcons(el); } }
function updatePlayerControls(): void {
  const t = player.current;
  const glyph = player.playing ? 'pause' : 'play';
  document.querySelectorAll('[data-playback-label]').forEach(el=>{
    el.textContent=player.mode==='full'?'':player.mode==='loading'?'Находим аудио…':'Трек недоступен · попробуйте ещё раз';
  });
  document.querySelectorAll<HTMLElement>('.transport-play, [data-mobile-play], .full-play').forEach(el => {
    replaceIcon(el, glyph); el.setAttribute('aria-label', player.playing ? 'Пауза' : 'Воспроизвести');
    el.classList.toggle('is-loading', player.loading); (el as HTMLButtonElement).disabled = !t;
  });
  document.querySelectorAll<HTMLButtonElement>('.shuffle-button').forEach(el=>{
    const inWave = Boolean(player.context);
    el.disabled = inWave;
    el.classList.toggle('active',player.shuffle && !inWave);
    el.setAttribute('aria-pressed',String(player.shuffle && !inWave));
    el.title = inWave ? 'Моя волна сама выбирает порядок треков' : 'Перемешать';
  });
  renderQueue();
  document.querySelectorAll<HTMLElement>('.repeat-button').forEach(el=> { el.classList.toggle('active',player.repeat !== 'off'); el.setAttribute('aria-label', `Повтор: ${player.repeat === 'one' ? 'одна песня' : player.repeat === 'all' ? 'вся очередь' : 'выключен'}`); replaceIcon(el, player.repeat === 'one' ? 'repeat-1' : 'repeat'); });
  document.querySelectorAll<HTMLElement>('.mute-button').forEach(el => {
    const muted = player.volume === 0;
    const label = muted ? 'Включить звук' : 'Выключить звук';
    el.setAttribute('aria-label', label);
    el.title = label;
    replaceIcon(el, muted ? 'volume-x' : 'volume-2');
  });
  document.querySelectorAll<HTMLInputElement>('[data-volume]').forEach(el => { el.value = String(player.volume); fillRange(el); });
  document.querySelectorAll<HTMLElement>('.wave-play').forEach(el => {replaceIcon(el, player.context&&player.playing?'pause':'play');el.setAttribute('aria-label',player.context&&player.playing?'Пауза Моей волны':'Включить Мою волну');});
  document.querySelectorAll<HTMLElement>('[data-track-row]').forEach(el=>el.classList.toggle('current-track',el.dataset.trackRow === t?.id));
  updateLikes();
}
function fillRange(el: HTMLInputElement): void {
  const max = Number(el.max);
  const fill = max > 0 ? Math.max(0, Math.min(100, Number(el.value) / max * 100)) : 0;
  el.style.setProperty('--range-fill', `${fill}%`);
  el.setAttribute('aria-valuetext', el.hasAttribute('data-volume') ? `${Math.round(Number(el.value) * 100)}%` : formatTime(Number(el.value)));
}
function updateProgress(): void {
  updateLyrics();
  document.querySelectorAll<HTMLInputElement>('[data-seek]').forEach(el => {
    el.max = String(player.duration);
    el.value = String(player.time);
    fillRange(el);
  });
  document.querySelectorAll('[data-elapsed]').forEach(el => el.textContent = formatTime(player.time));
  document.querySelectorAll('[data-duration]').forEach(el => el.textContent = formatTime(player.duration));
}
function updateLikes(): void {
  document.querySelectorAll<HTMLElement>('.like-button').forEach(el => {
    const id = el.dataset.id || player.current?.id;
    const liked = library.likes.some(t => t.id === id);
    el.classList.toggle('liked', liked); el.setAttribute('aria-pressed', String(liked));
    el.setAttribute('aria-label', liked ? 'Убрать из любимого' : 'В любимое');
  });
}
function like(track?: Track): void {
  if (!track) return;
  const exists = library.likes.some(t=>t.id === track.id);
  library.likes = exists ? library.likes.filter(t=>t.id !== track.id) : [track,...library.likes];
  void api.react({track_id:track.id,action:exists?'unlike':'like',session_id:player.context});
  if(player.context)void refreshWave();else waveQueue=undefined;
  dailyMix=undefined;
  if (save() && !exists) celebrateWave();
  updateLikes(); toast(exists ? 'Песня удалена из любимого' : 'Песня сохранена в любимом');
  if (currentView === 'library') libraryView();
  if (currentPlaylist) renderPlaylistSuggestions(currentPlaylist);
}
function celebrateWave(): void {
  if (currentView === 'home' && player.context) wave?.celebrate();
}
function showDialog(title: string, content: string, cls = ''): void {
  closeTranslationMenus?.();
  closeSongActions(); closePlaylistMenu(); closeQueue();
  fullPlayerClosing?.cancel();
  fullPlayerClosing = undefined;
  if (dialog.open) dialog.close();
  dialog.setAttribute('aria-label', title);
  dialog.className = cls;
  dialog.innerHTML = `<div class="dialog-header"><h2>${e(title)}</h2>${button('close','x','Закрыть')}</div>${content}`;
  hydrateIcons(dialog); dialog.showModal();
}
function resetAccountRecommendations():void {
  renderAccountAvatars();authEpoch++;profileReady=undefined;waveQueue=undefined;wavePromise=undefined;
  dailyMix=undefined;dailyPromise=undefined;discovery=[];discoveryPromise=undefined;disliked.clear();lastAnalyzedCount=0;
  player.context=undefined;recommendationUpdate=Promise.resolve();
  waveContinuation=undefined;failedWaveTracks.clear();
}
const loginScreen=app.querySelector<HTMLElement>('.login-screen')!;
const shell=app.querySelector<HTMLElement>('.app-shell')!;
const loginStatus=loginScreen.querySelector<HTMLElement>('.account-login-status')!;
const loginRetry=loginScreen.querySelector<HTMLButtonElement>('[data-action="retry-auth"]')!;
let sessionInitialized=false;

function renderSession(): void {
  shell.hidden=!authUser;
  loginScreen.hidden=!!authUser;
  const skipLink=app.querySelector<HTMLElement>('.skip-link')!;
  skipLink.hidden=!authUser;
  if(authUser){
    loginScreen.querySelector('#telegram-login-widget')!.replaceChildren();
    navigate();
    const returned=new URL(location.href);
    const spotifyResult=returned.searchParams.get('spotify');
    if(spotifyResult){
      returned.searchParams.delete('spotify');history.replaceState(history.state,'',returned);
      importDialog();
      if(spotifyResult!=='connected')toast(spotifyResult==='denied'?'Доступ к Spotify не предоставлен.':'Не удалось подключить Spotify.');
    }
    void restorePlayback(authUser.id);
    return;
  }
  if(dialog.open)dialog.close();
  closeQueue(); closePlaylistMenu(); closeSongActions();
  closeTranslationMenus?.(); closeTranslationMenus = undefined;
  wave?.destroy(); wave=undefined;
  generation++; searchRequest?.abort(); neuroRequest?.abort();
  main.replaceChildren();
  const target=loginScreen.querySelector<HTMLElement>('#telegram-login-widget')!;
  target.replaceChildren();
  loginRetry.hidden=false;
  if(!authConfig.enabled||!authConfig.bot_username||!/^\w{5,32}$/.test(authConfig.bot_username)){
    loginStatus.textContent='Вход через Telegram сейчас недоступен.';
    return;
  }
  loginStatus.textContent='';
  loginRetry.hidden=true;
  const script=document.createElement('script');
  script.async=true;
  script.src='https://telegram.org/js/telegram-widget.js?22';
  script.setAttribute('data-telegram-login',authConfig.bot_username);
  script.setAttribute('data-size','large');
  script.setAttribute('data-userpic','true');
  script.setAttribute('data-radius','14');
  script.setAttribute('data-onauth','onYaMusicTelegramAuth(user)');
  script.setAttribute('data-lang','ru');
  const unavailable=()=>{
    if(!script.isConnected||authUser)return;
    loginStatus.textContent='Не удалось загрузить кнопку Telegram. Проверьте соединение.';
    loginRetry.hidden=false;
  };
  script.onerror=unavailable;
  target.append(script);
  window.setTimeout(()=>{if(!target.querySelector('iframe'))unavailable();},10000);
}

function startSession(): void {
  loginRetry.hidden=true;
  loginStatus.textContent='Проверяем сеанс…';
  hydrateIcons(loginScreen);
  authReady=refreshAuth().then(()=>{
    sessionInitialized=true;
    renderSession();
  }).catch(()=>{
    loginStatus.textContent='Не удалось связаться с YaMusic.';
    loginRetry.hidden=false;
  });
}

function account(): void {
  if(!authUser)return;
  const name=authUser.first_name||authUser.username||'Слушатель';
  showDialog('Мой профиль',`<div class="account-dialog"><div class="account-emblem">${authUser.avatar_url?image(authUser.avatar_url,name,'account-avatar',true):icon('circle-user-round')}</div><h3>${e(name)}</h3>${authUser.username?`<p class="account-username">@${e(authUser.username)}</p>`:''}<span class="account-connected">${icon('send')}Telegram подключён</span><dl class="account-details"><div><dt>Telegram ID</dt><dd>${e(String(authUser.telegram_id))}</dd></div></dl><p>Рекомендации и позиция воспроизведения привязаны к вашему профилю. Любимое, плейлисты и настройки пока сохраняются в этом браузере.</p><button class="secondary-button" data-action="auth-logout">Выйти из профиля</button></div>`,'account-profile-dialog');
}

(window as Window & {onYaMusicTelegramAuth?:(user:TelegramLogin)=>void}).onYaMusicTelegramAuth=(payload)=>{
  if(accountBusy||authUser||!sessionInitialized)return;
  accountBusy=true;
  loginStatus.textContent='Подтверждаем вход…';
  void api.authLogin(payload).then(result=>{
    authUser=result.user;
    resetAccountRecommendations();
    authReady=Promise.resolve();
    renderSession();
  }).catch(error=>{loginStatus.textContent=error instanceof Error?error.message:'Не удалось войти через Telegram.';})
    .finally(()=>{accountBusy=false;});
};

async function logoutAccount():Promise<void>{
  if(accountBusy)return;
  accountBusy=true;
  try {
    player.pause();
    await persistPlayback(true);
    await api.authLogout();
    authUser=null;
    resetAccountRecommendations();
    player.reset(); renderPlayer(); renderSession();
  } catch(error) {
    toast(error instanceof Error?error.message:'Не удалось выйти из профиля.');
  } finally { accountBusy=false; }
}

function localResumeKey(user: number): string { return `yamusic.resume.v1.${user}`; }
async function restorePlayback(user: number): Promise<void> {
  lastCloudPosition=''; lastCloudSave=0; lastCapture=0;
  let local: ResumeSnapshot | undefined;
  try {
    const saved=JSON.parse(localStorage.getItem(localResumeKey(user)) || 'null');
    if(saved && isTrack(saved.track) && Number.isFinite(saved.position) && saved.position>=0 && Number.isFinite(saved.captured_at)) {
      local={...saved,queue:Array.isArray(saved.queue)?saved.queue.filter(isTrack):[]};
    }
  } catch { /* The server can restore playback without the browser copy. */ }
  const remote=await api.restorePlayback().catch(()=>null);
  if(authUser?.id!==user || player.current)return;
  const saved=local && (!remote || local.captured_at>remote.captured_at) ? local : remote;
  if(!saved)return;
  // Only the server knows whether a restored Wave session still belongs to this account.
  const context=remote?.context && remote.context===saved.context ? remote.context : undefined;
  restoringPlayback=true;
  lastCapture=saved.captured_at;
  register([saved.track,...saved.queue]);
  player.restore(saved.track,saved.queue,saved.position,context);
  lastCloudPosition=`${saved.track.id}:${saved.position.toFixed(1)}:${context??''}`;
  restoringPlayback=false;
  if(saved===local) {
    lastCloudPosition='';
    void persistPlayback(true);
  }
}

async function persistPlayback(force = false, initialPosition?: number): Promise<void> {
  const track=player.current,user=authUser;
  if(!track||!user||restoringPlayback)return;
  const time=initialPosition ?? player.time;
  const position=Number(Math.min(time,track.duration_sec || time).toFixed(1));
  const queue=player.queue.slice(Math.max(0,player.index-5),player.index+26);
  const signature=`${track.id}:${position.toFixed(1)}:${player.context??''}`;
  const now=Date.now();
  if(signature===lastCloudPosition || (!force && now-lastCloudSave<3500))return;
  const snapshot:ResumeSnapshot={track,queue,context:player.context,position,captured_at:Math.max(now,lastCapture+1)};
  lastCapture=snapshot.captured_at;
  try {localStorage.setItem(localResumeKey(user.id),JSON.stringify(snapshot));}catch{/* Cloud save still works. */}
  lastCloudSave=now;
  lastCloudPosition=signature;
  try {await api.savePlayback(snapshot);}
  catch {
    if(authUser?.id===user.id && lastCloudPosition===signature)lastCloudPosition='';
  }
}
function setFollowButton(button:HTMLButtonElement,following:boolean):void {
  button.textContent=following?'Вы подписаны':'Подписаться';
  button.setAttribute('aria-pressed',String(following));
  button.title=following?'Отписаться от исполнителя':'Подписаться на исполнителя';
  button.disabled=false;
}
async function refreshArtistPreferences():Promise<void>{
  await Promise.allSettled([wavePromise,dailyPromise]);
  waveQueue=undefined;dailyMix=undefined;
  if(player.context)void refreshWave();
  if(currentView==='home'){
    if(!player.context)void getWave().then(drawWaveQueue).catch(()=>{});
    void getDaily().then(drawDaily).catch(()=>{});
  }
}
let renderedQueue = '';

function closeQueue(restoreFocus = false): void {
  if (!queuePanel.matches(':popover-open')) return;
  queuePanel.hidePopover();
  updateQueueButtons();
  if (restoreFocus) [...playerBar.querySelectorAll<HTMLButtonElement>('[data-action="queue"]')].find(button=>button.getClientRects().length)?.focus();
}

function updateQueueButtons(): void {
  document.querySelectorAll('[data-action="queue"]').forEach(button =>
    button.setAttribute('aria-expanded', String(queuePanel.matches(':popover-open'))));
}

function renderQueue(): void {
  if (!queuePanel.matches(':popover-open')) return;
  const list = player.queue.slice(Math.max(0, player.index));
  const signature = JSON.stringify([player.index, list.map(track => [track.id, track.title, track.artist, track.cover_url, track.contributors])]);
  if (signature === renderedQueue) return;
  renderedQueue = signature;
  queuePanel.innerHTML = `<header class="floating-panel-header"><h2>Очередь</h2>${button('close-queue','x','Закрыть очередь')}</header>
    <div class="queue-panel-list">${list.length ? list.map((track, index) => `${index === 0 ? '<h3>Сейчас играет</h3>' : index === 1 ? '<h3>Далее</h3>' : ''}
      <button type="button" class="compact-track${index === 0 ? ' current' : ''}" data-action="play-queued" data-index="${player.index + index}"${index === 0 ? ' aria-current="true"' : ''}>
        ${image(track.cover_url, '', 'compact-track-cover')}
        <span class="compact-track-label"><strong>${e(track.title)}</strong><small>${e(trackArtists(track).map(artist=>artist.name).join(', '))}</small></span>
        <span class="compact-track-duration">${formatTime(track.duration_sec)}</span>
      </button>`).join('') : '<p class="muted">Включите трек, чтобы увидеть очередь.</p>'}</div>`;
  hydrateIcons(queuePanel);
}

function toggleQueue(): void {
  if (queuePanel.matches(':popover-open')) { closeQueue(); return; }
  closePlaylistMenu(); closeSongActions();
  (dialog.open ? dialog : app).append(queuePanel);
  queuePanel.showPopover();
  renderQueue();
  updateQueueButtons();
  queuePanel.querySelector<HTMLButtonElement>('[data-action="close-queue"]')?.focus({preventScroll:true});
}

function closePlaylistMenu(restoreFocus = false): void {
  if (playlistMenu.matches(':popover-open')) playlistMenu.hidePopover();
  playlistMenuTrigger?.setAttribute('aria-expanded','false');
  if (restoreFocus) playlistMenuTrigger?.focus();
  playlistMenuTrigger = undefined;
}

function positionPlaylistMenu(): void {
  positionTrackPopover(playlistMenu,playlistMenuTrigger,closePlaylistMenu);
}

function positionTrackPopover(panel: HTMLElement, trigger: HTMLElement | undefined, close: () => void): void {
  if (!panel.matches(':popover-open')) return;
  if (!trigger?.isConnected) { close(); return; }
  const anchor = trigger.getBoundingClientRect();
  if (anchor.bottom < 0 || anchor.top > window.innerHeight) { close(); return; }
  const above = anchor.top - 18, below = window.innerHeight - anchor.bottom - 18;
  const useAbove = above >= Math.min(360,panel.scrollHeight) || above >= below;
  panel.dataset.side = useAbove ? 'above' : 'below';
  panel.style.maxHeight = `${Math.max(72,Math.min(360,useAbove ? above : below))}px`;
  const width = panel.offsetWidth, height = panel.offsetHeight;
  panel.style.left = `${Math.max(10,Math.min(window.innerWidth - width - 10,anchor.right - width))}px`;
  panel.style.top = `${Math.max(10,useAbove ? anchor.top - height - 8 : anchor.bottom + 8)}px`;
}

function openPlaylistMenu(trigger: HTMLElement, track: Track): void {
  const sameTrigger = trigger === playlistMenuTrigger;
  closePlaylistMenu();
  if (sameTrigger) return;
  (dialog.open ? dialog : app).append(playlistMenu);
  playlistMenuTrigger = trigger;
  playlistMenu.dataset.trackId = track.id;
  trigger.setAttribute('aria-expanded','true');
  playlistMenu.innerHTML = `<header class="floating-panel-header"><h2>Добавить в плейлист</h2></header>
    ${library.playlists.length > 5 ? `<input class="text-input playlist-menu-search" type="search" placeholder="Найти плейлист" aria-label="Поиск по плейлистам">` : ''}
    <div class="playlist-menu-list">${library.playlists.map(playlist => {
      const added = playlist.tracks.some(item => item.id === track.id);
      const cover = playlist.cover_url || playlist.tracks[0]?.cover_url || '';
      return `<button type="button" class="compact-track" data-action="add-to-playlist" data-id="${e(track.id)}" data-playlist="${e(playlist.id)}" ${added ? 'disabled' : ''}>
        ${image(cover,'','compact-track-cover')}<strong class="compact-track-label">${e(playlist.title)}</strong>${icon(added ? 'check' : 'plus')}
      </button>`;
    }).join('')}</div>
    <p class="muted playlist-menu-empty" hidden>Плейлисты не найдены.</p>
    ${library.playlists.length ? '' : '<p class="muted">У вас пока нет плейлистов.</p><button type="button" class="secondary-button" data-action="new-playlist">Создать плейлист</button>'}`;
  hydrateIcons(playlistMenu);
  playlistMenu.showPopover();
  positionPlaylistMenu();
  playlistMenu.querySelector<HTMLElement>('input,button:not(:disabled)')?.focus({preventScroll:true});
  animateDropdown(playlistMenu, [...playlistMenu.querySelectorAll<HTMLElement>('.playlist-menu-list button')]);
}

function addPlaylistTrack(playlist: Playlist, track: Track): boolean {
  if (playlist.tracks.some(item => item.id === track.id)) return false;
  const before = playlist.tracks;
  playlist.tracks = [...before,track];
  if (!save()) { playlist.tracks = before; return false; }
  if (currentPlaylist === playlist) updatePlaylistContents(playlist);
  celebrateWave();
  toast(`Добавлено в «${playlist.title}»`);
  return true;
}

function playlistCandidates(playlist: Playlist, candidates: Track[]): string {
  register(candidates);
  return candidates.map(track => `<div class="compact-track">
    <button type="button" class="compact-track-play" data-action="preview-playlist-candidate" data-id="${e(track.id)}" aria-label="Включить ${e(track.title)}">${image(track.cover_url,'','compact-track-cover')}</button>
    <span class="compact-track-label"><strong>${e(track.title)}</strong><small>${e(trackArtists(track).map(artist=>artist.name).join(', '))}</small></span>
    ${button('add-to-playlist','plus','Добавить в этот плейлист',`data-id="${e(track.id)}" data-playlist="${e(playlist.id)}"`)}
  </div>`).join('');
}

function renderPlaylistSuggestions(playlist: Playlist): void {
  const likedBox = main.querySelector<HTMLElement>('[data-playlist-likes]');
  const suggestionsBox = main.querySelector<HTMLElement>('[data-playlist-suggestions]');
  if (!likedBox || !suggestionsBox) return;
  const added = new Set(playlist.tracks.map(track => track.id));
  const liked = library.likes.filter(track => !added.has(track.id));
  const likedIds = new Set(library.likes.map(track => track.id));
  const suggestions = playlistSuggestions.filter(track => !added.has(track.id) && !likedIds.has(track.id) && !disliked.has(track.id));
  likedBox.innerHTML = liked.length ? playlistCandidates(playlist,liked) : '<p class="muted">Здесь появятся песни, которым вы поставите лайк.</p>';
  if (suggestionsBox.dataset.loaded) {
    suggestionsBox.innerHTML = suggestions.length ? playlistCandidates(playlist,suggestions) : '<p class="muted">Пока нет новых рекомендаций для этого плейлиста.</p>';
  }
  hydrateIcons(likedBox); hydrateIcons(suggestionsBox);
}

function updatePlaylistContents(playlist: Playlist): void {
  visibleTracks = register(playlist.tracks);
  hydrateSavedCredits(playlist.tracks);
  const art = main.querySelector<HTMLElement>('[data-playlist-art]')!;
  const cover = playlist.cover_url || playlist.tracks[0]?.cover_url;
  art.classList.toggle('empty-playlist-art', !cover);
  art.innerHTML = cover ? image(cover) : icon('list-music');
  main.querySelector('[data-playlist-count]')!.textContent = `${trackCount(playlist.tracks.length)} · на этом устройстве`;
  main.querySelector<HTMLButtonElement>('[data-action="play-list"]')!.disabled = !playlist.tracks.length;
  const list = main.querySelector<HTMLElement>('[data-playlist-tracks]')!;
  list.innerHTML = playlist.tracks.length ? rows(playlist.tracks,playlist.tracks.length) : '';
  hydrateIcons(art); hydrateIcons(list);
  renderPlaylistSuggestions(playlist);
}

async function loadPlaylistSuggestions(playlist: Playlist, gen: number): Promise<void> {
  const suggestions = main.querySelector<HTMLElement>('[data-playlist-suggestions]')!;
  try {
    let mix: Track[];
    try { mix = (await getDaily()).tracks; }
    catch { mix = await getDiscovery(); }
    if (gen !== generation || currentPlaylist !== playlist) return;
    playlistSuggestions = mix;
    suggestions.dataset.loaded = 'true';
    renderPlaylistSuggestions(playlist);
  } catch {
    if (gen === generation) suggestions.textContent = 'Рекомендации временно недоступны.';
  }
}
let fullPlayerClosing: Animation | undefined;

function collapseFullPlayer(): void {
  if (fullPlayerClosing) return;
  closeSongActions(); closePlaylistMenu(); closeQueue();
  if (!library.settings.animations || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    dialog.close();
    return;
  }
  const slide = dialog.animate(
    [{ transform: getComputedStyle(dialog).transform }, { transform: 'translateY(100%)' }],
    { duration: 320, easing: 'cubic-bezier(.4,0,.65,1)', fill: 'forwards' },
  );
  fullPlayerClosing = slide;
  void slide.finished.then(() => {
    if (fullPlayerClosing !== slide) return;
    fullPlayerClosing = undefined;
    dialog.close();
    slide.cancel();
  }).catch(() => {});
}

function fullPlayer(lyrics = false): void {
  const t = player.current;
  if (!t) { toast('Сначала выберите песню'); return; }
  if (fullPlayerClosing) return;
  closeQueue(); closePlaylistMenu(); closeSongActions();
  translationRequest?.abort(); translatedLines = undefined; translationVisible = false;
  const alreadyOpen = dialog.open && dialog.classList.contains('full-player-dialog');
  if (dialog.open && !alreadyOpen) dialog.close();
  lyricLines = []; plainLyricLines=[]; activeLyric = -1; followLyrics = true;
  dialog.className = `full-player-dialog${lyrics ? ' show-lyrics' : ''}`;
  dialog.innerHTML = `
    <div class="expanded-header">
      ${button('collapse-player','chevron-down','Свернуть плеер',alreadyOpen ? '' : 'autofocus')}
    </div>
    <div class="expanded-player">
      <div class="expanded-deck">
        <div class="expanded-artwork">
          <div class="expanded-cover-frame">
            <div class="expanded-cover-card">
              <div class="expanded-cover-art">${image(t.cover_url,'','expanded-cover',true)}</div>
              <div class="expanded-metadata">
                <h1><a href="#/album/${t.album_id}" data-action="album" data-id="${t.album_id}"><span class="moving-title-text">${e(t.title)}</span></a></h1>
                ${artistLinks(t, 'expanded-artist-link')}
                <span class="preview-note" role="status" data-playback-label></span>
              </div>
            </div>
          </div>
          <div class="expanded-track">
            <div class="expanded-actions">
              <button class="icon-button like-button" data-action="like-current" aria-label="В любимое">${icon('heart')}</button>
              ${button('add-playlist-menu','plus','Добавить в плейлист',`data-id="${e(t.id)}" aria-expanded="false" aria-controls="playlist-menu"`)}
              ${button('queue','list-music','Очередь','aria-controls="playback-queue" aria-expanded="false" data-expanded-queue')}
              ${button('track-menu','ellipsis','Действия с песней',`data-id="${e(t.id)}" aria-expanded="false" aria-controls="song-actions"`)}
            </div>
          </div>
        </div>
        <div class="expanded-transport">
          <div class="expanded-timeline">
            <span data-elapsed>${formatTime(player.time)}</span>
            ${playerRange('seek', player.time, player.duration)}
            <span data-duration>${formatTime(player.duration)}</span>
          </div>
          <div class="transport-buttons">
            <button class="icon-button shuffle-button" data-action="shuffle" aria-label="Перемешать">${icon('shuffle')}</button>
            ${button('previous','skip-back','Предыдущий трек')}
            <button class="full-play" data-action="toggle" aria-label="Воспроизвести">${icon('play')}</button>
            ${button('next','skip-forward','Следующий трек')}
            <button class="icon-button repeat-button" data-action="repeat" aria-label="Повтор">${icon('repeat')}</button>
          </div>
        </div>
        <div class="expanded-options">
          <div class="lyrics-tabs">
            <span class="chip selected desktop-lyrics-tab">Текст песни</span>
            <button class="chip lyrics-view-toggle${lyrics ? ' selected' : ''}" data-action="lyrics-view" aria-pressed="${lyrics}">Текст песни</button>
            <button class="chip" data-action="translation" aria-pressed="false" disabled>Перевод</button>
          </div>
          ${volumeControl()}
        </div>
        <p class="translation-status" role="status" hidden></p>
      </div>
      <section class="lyrics-panel" aria-label="Текст песни">
        <div class="lyrics-tools">
          <span class="follow-lyrics-control" tabindex="0"><button class="icon-button follow-lyrics" data-action="follow-lyrics" aria-label="Вернуться к текущей строке" aria-pressed="true" disabled>
            ${icon('locate-fixed')}
          </button><span class="lyrics-tooltip" aria-hidden="true">К текущей строке</span></span>
        </div>
        <div class="lyrics-scroll" tabindex="0" aria-label="Строки песни">${loading()}</div>
        <div class="lyrics-footer"><span class="lyrics-credit">Тексты · LRCLIB</span><span class="lyrics-credit" data-lyrics-sync hidden>Текст без синхронизации</span></div>
      </section>
    </div>`;
  dialog.setAttribute('aria-label', 'Полноэкранный плеер');
  if (!alreadyOpen) dialog.showModal();
  mountCoverParallax(dialog.querySelector<HTMLElement>('.expanded-cover-frame')!);
  mountPlayerRanges(dialog);
  updatePlayerControls(); updateProgress(); hydrateIcons(dialog); void loadLyrics();
}
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

const titleSelector='.track-name,.player-name-link,.expanded-metadata h1 a';
const titleAnimations=new WeakMap<HTMLElement,Animation>();
function toggleTitle(event: MouseEvent | FocusEvent, enabled: boolean): void {
  const link=(event.target as Element).closest<HTMLElement>(titleSelector);
  if(!link || (event.relatedTarget instanceof Node && link.contains(event.relatedTarget)))return;
  const text=link.querySelector<HTMLElement>('.moving-title-text');if(!text)return;
  if(!enabled){
    if(event.type==='mouseout' && link.matches(':focus-visible'))return;
    if(event.type==='focusout' && link.matches(':hover'))return;
    titleAnimations.get(link)?.cancel();titleAnimations.delete(link);link.classList.remove('title-scrolling');return;
  }
  if(reducedMotion.matches || !library.settings.animations || titleAnimations.has(link))return;
  const range=document.createRange();range.selectNodeContents(text);
  const distance=Math.ceil(range.getBoundingClientRect().width-link.clientWidth);
  if(distance<2)return;
  link.classList.add('title-scrolling');
  const duration=Math.max(1700,distance*31);
  const animation=text.animate([
    {transform:'translateX(0)',offset:0},
    {transform:'translateX(0)',offset:.12},
    {transform:`translateX(-${distance}px)`,offset:.88},
    {transform:`translateX(-${distance}px)`,offset:1}
  ],{duration,direction:'alternate',iterations:Infinity});
  titleAnimations.set(link,animation);
}
document.addEventListener('mouseover',event=>toggleTitle(event,true));
document.addEventListener('mouseout',event=>toggleTitle(event,false));
document.addEventListener('focusin',event=>toggleTitle(event,true));
document.addEventListener('focusout',event=>toggleTitle(event,false));

async function loadLyrics(): Promise<void> {
  const t=player.current, container=dialog.querySelector<HTMLElement>('.lyrics-scroll');
  if(!t || !container || !dialog.open) return;
  lyricsRequest?.abort(); const controller=new AbortController(); lyricsRequest=controller;
  container.innerHTML=loading(); lyricLines=[]; plainLyricLines=[]; activeLyric=-1;
  try {
    const data=await retryLyrics(() => api.lyrics(t.id,controller.signal),controller.signal);
    if(controller.signal.aborted || player.current?.id!==t.id || !dialog.open || !container.isConnected) return;
    lyricLines=data.instrumental?[]:parseLrc(data.synced_lrc||'');
    if(!lyricLines.length&&!data.instrumental&&data.plain_lyrics)plainLyricLines=data.plain_lyrics.split(/\r?\n/).map(line=>line.trim());
    const isPlain=plainLyricLines.some(Boolean);
    dialog.querySelector<HTMLElement>('[data-lyrics-sync]')!.hidden=!isPlain;
    const followControl=dialog.querySelector<HTMLElement>('.follow-lyrics-control')!;
    followControl.querySelector('.lyrics-tooltip')!.textContent=isPlain?'Текст без синхронизации':'К текущей строке';
    if(isPlain)followControl.setAttribute('aria-label','Текст без синхронизации');
    if(data.instrumental) container.innerHTML=empty('Только музыка','У этой композиции нет слов.','audio-lines');
    else if(lyricLines.length) container.innerHTML=lyricLines.map((line,i)=>`<button class="lyric-line" data-action="seek-lyric" data-time="${line.time}" data-line="${i}" aria-label="${e(line.text)}, ${formatTime(line.time)}">${e(line.text)}</button>`).join('');
    else if(isPlain) container.innerHTML=`<div class="plain-lyrics">${plainLyricLines.map((line,i)=>`<p data-plain-line="${i}">${e(line)||'&nbsp;'}</p>`).join('')}</div>`;
    else container.innerHTML=empty('Текст пока не найден','В LRCLIB пока нет текста именно этой версии песни.','mic-2');
    const translate=dialog.querySelector<HTMLButtonElement>('[data-action="translation"]');
    if(translate)translate.disabled=!lyricLines.length&&!isPlain;
    hydrateIcons(container); updateLyrics();
  } catch(error) {
    if(controller.signal.aborted || !container.isConnected) return;
    container.innerHTML=empty('Не удалось загрузить текст',error instanceof Error?error.message:'Попробуйте ещё раз.','circle-alert','<button class="secondary-button" data-action="retry-lyrics">Попробовать ещё раз</button>'); hydrateIcons(container);
  }
}
async function toggleTranslation(button: HTMLButtonElement): Promise<void> {
  const t=player.current;
  if(!t || (!lyricLines.length&&!plainLyricLines.some(Boolean))) return;
  const status=dialog.querySelector<HTMLElement>('.translation-status')!;
  status.hidden=true; status.textContent='';
  if(!translatedLines) {
    translationRequest?.abort();
    const controller = new AbortController();
    translationRequest = controller;
    button.disabled=true;
    button.textContent='Переводим…';
    try {
      const result=await api.translateLyrics(t.id,library.settings.translation,library.settings.translationLanguage,controller.signal);
      if(controller.signal.aborted || !button.isConnected || !dialog.open) return;
      const translated=parseLrc(result.translated_lrc);
      if(result.plain){
        const lines=result.translated_lrc.split('\n');
        if(lines.length!==plainLyricLines.filter(Boolean).length)throw new Error('Строки перевода не совпали с оригиналом.');
        let index=0;
        translatedLines=plainLyricLines.map(line=>line?lines[index++]: '');
      } else {
      if(translated.length!==lyricLines.length || translated.some((line,i)=>line.time!==lyricLines[i].time)){
        throw new Error('Не удалось синхронизировать перевод.');
      }
      translatedLines=translated.map(line=>line.text);
      }
      const original=lyricLines.length?lyricLines.map(line=>line.text):plainLyricLines;
      if(translatedLines.every((line,i)=>line.trim()===original[i]?.trim())){
        translatedLines=undefined;
        status.textContent=`Текст уже на выбранном языке (${languageName(library.settings.translationLanguage)}).`;
        status.hidden=false;
        return;
      }
    } catch(error) {
      if(!controller.signal.aborted && status.isConnected){
        status.textContent=error instanceof Error ? error.message : 'Не удалось загрузить перевод.';
        status.hidden=false;
      }
      return;
    } finally {
      if(button.isConnected) { button.disabled=false; button.textContent='Перевод'; }
    }
  }
  translationVisible=!translationVisible;
  button.classList.toggle('selected',translationVisible);
  button.setAttribute('aria-pressed',String(translationVisible));
  if(translationVisible && !dialog.classList.contains('show-lyrics')) {
    dialog.classList.add('show-lyrics');
    const mobileTab=dialog.querySelector('.lyrics-view-toggle');
    mobileTab?.classList.add('selected'); mobileTab?.setAttribute('aria-pressed','true');
  }
  dialog.querySelectorAll<HTMLElement>('[data-line],[data-plain-line]').forEach(line=>{
    line.querySelector('.lyric-translation')?.remove();
    if(!translationVisible) return;
    const index=Number(line.dataset.line??line.dataset.plainLine);
    const original=lyricLines[index]?.text??plainLyricLines[index];
    if(!translatedLines?.[index]||translatedLines[index].trim()===original?.trim())return;
    const translation=document.createElement('span');
    translation.className='lyric-translation';
    translation.textContent=translatedLines?.[index]??'';
    line.append(translation);
    if(line.dataset.line!==undefined)line.setAttribute('aria-label',`${original}; ${translation.textContent}, ${formatTime(lyricLines[index].time)}`);
  });
  if(!translationVisible) dialog.querySelectorAll<HTMLElement>('[data-line]').forEach(line=>{
    const original=lyricLines[Number(line.dataset.line)];
    line.setAttribute('aria-label',`${original.text}, ${formatTime(original.time)}`);
  });
  activeLyric=-1;updateLyrics();
}
function setLyricsFollowing(enabled: boolean): void {
  followLyrics = enabled;
  dialog.querySelector('.follow-lyrics')?.setAttribute('aria-pressed', String(enabled));
}

function updateLyrics(): void {
  if(!dialog.open || !dialog.classList.contains('full-player-dialog')) return;
  const synchronized=player.mode==='full' && lyricLines.length>0;
  const follow=dialog.querySelector<HTMLButtonElement>('.follow-lyrics');
  if(follow) follow.disabled=!synchronized;
  if(!lyricLines.length) return;
  dialog.querySelectorAll<HTMLButtonElement>('.lyric-line').forEach(line=>{line.disabled=!synchronized;});
  const index=synchronized?activeLine(lyricLines,player.time):-1;
  if(index===activeLyric) return;
  activeLyric=index;
  dialog.querySelectorAll<HTMLElement>('[data-line]').forEach(line=>{
    const active=Number(line.dataset.line)===index; line.classList.toggle('active-line',active);
    if(active) line.setAttribute('aria-current','true'); else line.removeAttribute('aria-current');
  });
  const current=dialog.querySelector<HTMLElement>(`[data-line="${index}"]`), scroll=dialog.querySelector<HTMLElement>('.lyrics-scroll');
  if(current && scroll && scroll.clientHeight>0 && followLyrics) {
    const delta=current.getBoundingClientRect().top-scroll.getBoundingClientRect().top-scroll.clientHeight/2+current.offsetHeight/2;
    scroll.scrollTo({top:scroll.scrollTop+delta,behavior:library.settings.animations&&!matchMedia('(prefers-reduced-motion: reduce)').matches?'smooth':'instant'});
  }
}
let playlistCoverDraft='';
let pendingPlaylistTrack: Track | undefined;
function resizePlaylistDescription(input: HTMLTextAreaElement): void {
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight + 2}px`;
}

function updatePlaylistCoverPreview(form: HTMLFormElement): void {
  const preview = form.querySelector<HTMLElement>('[data-cover-image]')!;
  preview.innerHTML = playlistCoverDraft ? image(playlistCoverDraft) : icon('list-music');
  form.querySelector<HTMLButtonElement>('[data-action="clear-playlist-cover"]')!.hidden = !playlistCoverDraft;
  hydrateIcons(preview);
}
function playlistDialog(id?: string): void {
  const p = library.playlists.find(p => p.id === id);playlistCoverDraft=p?.cover_url||'';
  showDialog(p ? 'Редактировать плейлист' : 'Новый плейлист', `
    <form id="playlist-form" class="playlist-editor" data-id="${e(id || '')}">
      <div class="playlist-cover-editor">
        <button type="button" class="playlist-cover-preview" data-action="choose-playlist-cover" aria-label="Выбрать обложку" title="Выбрать обложку">
          <span data-cover-image>${playlistCoverDraft ? image(playlistCoverDraft) : icon('list-music')}</span>
          <span class="playlist-cover-badge">${icon('plus')}</span>
        </button>
        <input id="playlist-cover-file" type="file" accept="image/jpeg,image/png,image/webp" hidden>
        <button type="button" class="text-button" data-action="clear-playlist-cover" ${playlistCoverDraft ? '' : 'hidden'}>Убрать обложку</button>
      </div>
      <label class="field-label" for="playlist-title">Название</label>
      <input class="text-input" id="playlist-title" name="title" required maxlength="100" placeholder="Например, Ночной маршрут" value="${e(p?.title || '')}">
      <label class="field-label" for="playlist-description">Описание</label>
      <textarea class="text-input" id="playlist-description" name="description" maxlength="1000" placeholder="Для какого настроения эта музыка?">${e(p?.description || '')}</textarea>
      <button class="primary-button" type="submit">${p ? 'Сохранить' : 'Создать плейлист'} ${icon('check')}</button>
    </form>`);
  resizePlaylistDescription(dialog.querySelector<HTMLTextAreaElement>('#playlist-description')!);
}
async function loadPlaylistCover(file:File):Promise<string>{
  if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>10*1024*1024)throw new Error('Выберите JPG, PNG или WebP до 10 МБ');
  const bitmap=await createImageBitmap(file);
  try{
    const canvas=document.createElement('canvas');canvas.width=480;canvas.height=480;const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Не удалось подготовить обложку');
    const side=Math.min(bitmap.width,bitmap.height);ctx.drawImage(bitmap,(bitmap.width-side)/2,(bitmap.height-side)/2,side,side,0,0,480,480);
    const result=canvas.toDataURL('image/jpeg',.8);if(!safeImage(result))throw new Error('Изображение получилось слишком большим. Выберите другую обложку');return result;
  }finally{bitmap.close();}
}
let importTracks: Track[] = [];
let spotifyExportLists: SpotifyExportPlaylist[] = [];
let importRequest: AbortController | undefined;
async function previewImport(form: HTMLFormElement): Promise<void> {
  const input=form.querySelector<HTMLTextAreaElement>('textarea')!;
  const value=input.value.trim();
  if(!value){input.focus();return;}
  const connected=dialog.querySelector<HTMLElement>('.spotify-playlists')?.hidden===false;
  if(connected && /^https:\/\/open\.spotify\.com\/(?:intl-[^/]+\/)?playlist\/[a-zA-Z0-9]{22}(?:[/?#]|$)/.test(value)){
    void previewSpotify(value,'Плейлист Spotify');return;
  }
  importRequest?.abort();
  const controller=new AbortController();
  importRequest=controller; importTracks=[];
  const result=dialog.querySelector<HTMLElement>('#import-result')!;
  const submit=form.querySelector<HTMLButtonElement>('button[type=submit]')!;
  result.innerHTML=loading();submit.disabled=true;
  try {
    const data=await api.importPreview(input.value,controller.signal);
    if(controller.signal.aborted||!result.isConnected||!dialog.open)return;
    importTracks=register(data.tracks);
    drawImportPreview(result,data);
  } catch(error){
    if(!controller.signal.aborted&&result.isConnected)result.textContent=error instanceof Error?error.message:'Не удалось проверить список.';
  } finally {if(submit.isConnected)submit.disabled=false;}
}

function drawImportPreview(result: HTMLElement,data: ImportPreview): void {
    result.innerHTML=`<p class="results-caption">Проверено: ${data.checked}${data.total>data.checked?` из ${data.total}`:''} · найдено: ${data.tracks.length}${data.unavailable?` · недоступные позиции: ${data.unavailable}`:''}</p>${data.limited?'<p class="muted">Доступна часть списка. Для полного переноса подключите Spotify или загрузите файл экспорта.</p>':''}
      ${data.missing?.length?`<details class="import-missing"><summary>Нет совпадения в каталоге (${data.missing.length})</summary><div class="import-preview-list">${data.missing.map(track=>`<p>${e(track.artist)} · ${e(track.title)}</p>`).join('')}</div></details>`:''}
      ${data.tracks.length?`<div class="import-preview-list">${data.tracks.map(track=>`<p><strong>${e(track.title)}</strong> · ${e(track.artist)}</p>`).join('')}</div>
        <label class="import-name">Название плейлиста<input id="import-playlist-title" class="text-input" maxlength="100" value="${e(data.title.slice(0,100))}"></label>
        <div class="dialog-actions"><button class="secondary-button" data-action="import-likes">Добавить в любимое</button><button class="primary-button" data-action="import-playlist">Создать плейлист</button></div>`:'<p class="muted">Совпадений с каталогом нет. Проверьте имена и названия.</p>'}`;
    hydrateIcons(result);
}

async function loadSpotifyLists(): Promise<void> {
  const section=dialog.querySelector<HTMLElement>('#spotify-import');
  if(!section||!authConfig.spotify)return;
  const status=section.querySelector<HTMLElement>('.spotify-status')!;
  try {
    const data=await api.spotifyPlaylists(0);
    if(!section.isConnected||!dialog.open||!data.connected)return;
    const connect=section.querySelector<HTMLElement>('[data-action=spotify-connect]')!;
    connect.hidden=true;
    const options=section.querySelector<HTMLElement>('.spotify-playlists')!;
    options.hidden=false;
    section.querySelector<HTMLElement>('[data-action=spotify-disconnect]')!.hidden=false;
    renderSpotifyLists(options,data.playlists,data.next_offset);
  } catch(error){if(section.isConnected)status.textContent=error instanceof Error?error.message:'Spotify временно недоступен.';}
}
function renderSpotifyLists(list: HTMLElement,playlists: {id:string;name:string}[],next?:number): void {
  list.querySelector('[data-action=spotify-more]')?.remove();
  if(!list.children.length)list.innerHTML='<button class="text-button" data-action="spotify-import" data-id="saved">Любимое в Spotify</button>';
  list.insertAdjacentHTML('beforeend',playlists.map(({id,name})=>
    `<button class="text-button" data-action="spotify-import" data-id="${e(id)}">${e(name)}</button>`).join('')+
    (next==null?'':`<button class="text-button" data-action="spotify-more" data-id="${next}">Ещё плейлисты</button>`));
}
async function previewSpotify(id:string,title:string): Promise<void> {
  importRequest?.abort();
  const controller=new AbortController();
  importRequest=controller;importTracks=[];
  const result=dialog.querySelector<HTMLElement>('#import-result')!;
  const summary:ImportPreview={title,tracks:[],missing:[],checked:0,total:0,unavailable:0};
  let offset=0;
  result.textContent='Получаем треки из Spotify…';
  try{
    while(true){
      const page=await api.spotifyPage(id,offset,controller.signal);
      if(controller.signal.aborted||!result.isConnected||!dialog.open)return;
      summary.tracks.push(...page.tracks);
      summary.missing!.push(...(page.missing??[]));
      summary.checked+=page.checked;summary.total=Math.max(summary.total,page.total??0,summary.checked);
      summary.unavailable!+=page.unavailable??0;
      result.textContent=`Проверено ${summary.checked} из ${summary.total} · найдено ${summary.tracks.length}`;
      if(page.next_offset==null)break;
      offset=page.next_offset;
    }
    summary.tracks=uniqueTracks(summary.tracks);
    importTracks=register(summary.tracks);
    drawImportPreview(result,summary);
  }catch(error){
    if(!controller.signal.aborted&&result.isConnected)result.textContent=error instanceof Error?error.message:'Не удалось прочитать плейлист.';
  }
}

async function readSpotifyExport(file: File): Promise<void> {
  const list=dialog.querySelector<HTMLElement>('#spotify-export-lists')!;
  list.textContent='Читаем файл…';
  spotifyExportLists=[];
  try {
    if(file.size>10*1024*1024)throw new Error('Выберите файл JSON размером до 10 МБ.');
    const parsed=parseSpotifyExport(await file.text());
    if(!list.isConnected||!dialog.open)return;
    if(!parsed.length)throw new Error('В этом файле нет плейлистов. Выберите Playlist*.json или YourLibrary.json из экспорта Spotify.');
    spotifyExportLists=parsed;
    list.innerHTML=parsed.map((playlist,index)=>`<button class="text-button" data-action="import-spotify-export" data-id="${index}">
      ${e(playlist.title)} · ${trackCount(playlist.tracks.length)}</button>`).join('');
  } catch(error){
    if(list.isConnected)list.textContent=error instanceof SyntaxError?'Не удалось прочитать файл JSON.':error instanceof Error?error.message:'Не удалось открыть файл.';
  }
}

async function previewSpotifyExport(list: SpotifyExportPlaylist): Promise<void> {
  importRequest?.abort();
  const controller=new AbortController();
  importRequest=controller;importTracks=[];
  const result=dialog.querySelector<HTMLElement>('#import-result')!;
  const summary:ImportPreview={title:list.title,tracks:[],missing:[],checked:list.unavailable,total:list.tracks.length+list.unavailable,unavailable:list.unavailable};
  result.textContent='Сверяем треки с каталогом…';
  try {
    for(let i=0;i<list.tracks.length;i+=50){
      const data=await api.matchImport(list.tracks.slice(i,i+50),controller.signal);
      if(controller.signal.aborted||!result.isConnected||!dialog.open)return;
      summary.tracks.push(...data.tracks);
      summary.missing!.push(...(data.missing??[]));
      summary.checked+=data.checked;
      result.textContent=`Проверено ${summary.checked} из ${summary.total} · найдено ${summary.tracks.length}`;
    }
    summary.tracks=uniqueTracks(summary.tracks);
    importTracks=register(summary.tracks);
    drawImportPreview(result,summary);
  } catch(error) {
    if(!controller.signal.aborted&&result.isConnected)result.textContent=error instanceof Error?error.message:'Не удалось проверить плейлист.';
  }
}

function saveImport(asLikes: boolean): void {
  if(!importTracks.length)return;
  if(asLikes){
    const before=library.likes;
    const ids=new Set(before.map(track=>track.id));
    const added=importTracks.filter(track=>!ids.has(track.id));
    library.likes=[...added,...before];
    if(!save()){library.likes=before;return;}
    for(const track of added)void api.react({track_id:track.id,action:'like'});
    dailyMix=undefined;waveQueue=undefined;
    dialog.close();libraryFilter='likes';go('library');toast(`Добавлено: ${trackCount(added.length)}`);
    return;
  }
  const title=dialog.querySelector<HTMLInputElement>('#import-playlist-title')?.value.trim().slice(0,100);
  if(!title){dialog.querySelector<HTMLInputElement>('#import-playlist-title')?.focus();return;}
  const playlist={id:crypto.randomUUID(),title,tracks:importTracks,createdAt:Date.now()};
  library.playlists.push(playlist);
  if(!save()){library.playlists.pop();return;}
  dialog.close();go(`playlist/${playlist.id}`);toast('Плейлист импортирован');
}

function importDialog(): void {
  importTracks=[];spotifyExportLists=[];
  showDialog('Перенос музыки', `<section id="spotify-import" class="spotify-import">
      <button class="primary-button" data-action="spotify-connect" ${authConfig.spotify?'':'disabled'}>Подключить Spotify</button>
      <p class="spotify-status" role="status">${authConfig.spotify?'':'Подключение Spotify пока недоступно.'}</p>
      <div class="spotify-playlists" hidden></div>
      <button class="text-button" data-action="spotify-disconnect" hidden>Отключить Spotify</button>
    </section>
    <details class="spotify-export"><summary>Импорт файла Spotify</summary>
      <p>В аккаунте Spotify скачайте данные аккаунта, распакуйте архив и выберите Playlist*.json или YourLibrary.json.</p>
      <a class="text-button" href="https://www.spotify.com/account/privacy/" target="_blank" rel="noopener noreferrer">Данные аккаунта Spotify</a>
      <input id="spotify-export-file" type="file" accept="application/json,.json" aria-label="Файл экспорта Spotify">
      <div class="spotify-playlists" id="spotify-export-lists" aria-live="polite"></div>
    </details><form id="music-import-form"><label for="music-import-input">Ссылка на публичный плейлист Spotify или список из Spotify / Яндекс Музыки</label><textarea id="music-import-input" class="text-input" rows="5" maxlength="15000" placeholder="Исполнитель — Название трека" required></textarea><button type="submit" class="primary-button">Найти треки</button></form><div id="import-result" aria-live="polite"></div><label class="import-option import-file">${icon('library')}<div><strong>Восстановить копию YaMusic</strong><p>Загрузите JSON-файл, сохранённый в настройках. Текущая коллекция дополнится.</p></div>${icon('plus')}<input id="library-import" type="file" accept="application/json,.json"/></label>`);
  void loadSpotifyLists();
}
function closeSongActions(restoreFocus = false): void {
  if (songActions.matches(':popover-open')) songActions.hidePopover();
  songActionsTrigger?.setAttribute('aria-expanded','false');
  if (restoreFocus) songActionsTrigger?.focus({preventScroll:true});
  songActionsTrigger = undefined;
}
function positionSongActions(): void {
  positionTrackPopover(songActions,songActionsTrigger,closeSongActions);
}
function trackMenu(trigger: HTMLElement, id: string): void {
  const t = tracks.get(id) ?? (player.current?.id === id ? player.current : undefined);
  if (!t) return;
  const sameTrigger = trigger === songActionsTrigger;
  closeSongActions(); closePlaylistMenu(); closeQueue();
  if (sameTrigger) return;
  register([t]);
  (dialog.open ? dialog : app).append(songActions);
  songActionsTrigger = trigger;
  trigger.setAttribute('aria-expanded','true');
  songActions.innerHTML = `<header class="song-actions-heading"><strong title="${e(t.title)}">${e(t.title)}</strong><small>${e(t.artist)}</small></header>
    <div class="action-list">
      <button data-action="like" data-id="${e(id)}">${icon('heart')}${library.likes.some(track=>track.id===id)?'Убрать из любимого':'В любимое'}</button>
      <button data-action="dislike" data-id="${e(id)}">${icon('thumbs-down')}${disliked.has(id)?'Снова рекомендовать':'Не нравится'}</button>
      <button data-action="add-playlist-menu" data-id="${e(id)}">${icon('list-plus')}Добавить в плейлист</button>
      <button data-action="artist" data-id="${t.artist_id}">${icon('circle-user-round')}К исполнителю</button>
      <button data-action="album" data-id="${t.album_id}">${icon('disc-3')}К альбому</button>
      <a href="https://www.deezer.com/track/${t.deezer_id}" target="_blank" rel="noopener noreferrer">${icon('arrow-up-right')}Открыть в Deezer</a>
      ${currentView === 'playlist' ? `<button class="danger-text" data-action="remove-playlist-track" data-id="${e(id)}">${icon('trash-2')}Убрать из плейлиста</button>` : ''}
    </div>`;
  hydrateIcons(songActions);
  songActions.showPopover();
  positionSongActions();
  songActions.querySelector<HTMLElement>('button')?.focus({preventScroll:true});
  animateDropdown(songActions, [...songActions.querySelectorAll<HTMLElement>('.action-list > *')]);
}

document.addEventListener('click', async event => {
  const clicked = event.target as HTMLElement;
  if (!clicked.closest('#playback-queue,.player-bar,[data-action="queue"]')) closeQueue();
  if (!clicked.closest('#playlist-menu,[data-action="add-playlist-menu"]')) closePlaylistMenu();
  if (!clicked.closest('#song-actions,[data-action="track-menu"]')) closeSongActions();
  if ((event.target as HTMLElement).closest('.skip-link')) { event.preventDefault(); main.focus(); return; }
  const target = clicked.closest<HTMLElement>('[data-action]');
  if (!target) { if(clicked.closest('#song-actions a')) queueMicrotask(()=>closeSongActions(true)); return; }
  const action = target.dataset.action, id = target.dataset.id || '';
  const fromSongActions=songActions.contains(target), menuAnchor=songActionsTrigger;
  if(fromSongActions)closeSongActions(action !== 'add-playlist-menu');
  const closeForNavigation = () => { if (dialog.open) dialog.close(); };
  if (action === 'play') {
    const track = tracks.get(id); if (track) player.play(track, visibleTracks.length ? visibleTracks : [track]);
  } else if (action === 'play-neuro') {
    const track=id?neuroTracks.find(item=>item.id===id):neuroTracks[0];
    if(track)player.play(track,neuroTracks);
  } else if (action === 'play-queued') {
    player.playQueued(Number(target.dataset.index));
  } else if (action === 'preview-playlist-candidate') {
    const track = tracks.get(id);
    if (track) player.play(track);
  } else if(action==='play-wave-track'){
    const data=await getWave(),track=tracks.get(id);if(track)player.play(track,data.tracks,data.session_id);
  } else if(action==='play-daily-track'){
    const data=await getDaily(),track=tracks.get(id);if(track)player.play(track,data.tracks);
  } else if (action === 'toggle') { if (player.current) player.toggle(); else toast('Выберите песню в каталоге'); }
  else if (action === 'wave' || action === 'daily') {
    if(action==='wave'&&player.context&&player.current)player.toggle();
    else{target.setAttribute('disabled','');try{if(action==='wave'){failedWaveTracks.clear();const data=await getWave();if(data.tracks[0])player.play(data.tracks[0],data.tracks,data.session_id);else toast('Сначала найдите и отметьте любимую музыку');}else{const data=await getDaily();if(data.tracks[0])player.play(data.tracks[0],data.tracks);}}catch(error){toast(error instanceof Error?error.message:'Рекомендации недоступны');}finally{target.removeAttribute('disabled');}}
  } else if (action === 'next') player.next();
  else if (action === 'previous') player.previous();
  else if (action === 'shuffle') {
    player.toggleShuffle();api.prepare(player.queue.slice(player.index+1,player.index+6),true);
  }
  else if (action === 'repeat') player.toggleRepeat();
  else if (action === 'mute') { if (player.volume > 0) { lastVolume = player.volume; player.setVolume(0); } else player.setVolume(lastVolume); library.settings.volume = player.volume; save(); }
  else if (action === 'like' || action === 'like-current') like(action === 'like' ? tracks.get(id) : player.current);
  else if(action==='dislike'){
    const track=tracks.get(id);if(track){
      const undo=disliked.has(id);if(undo)disliked.delete(id);else disliked.add(id);
      await api.react({track_id:id,action:undo?'undislike':'dislike',session_id:player.context});
      if(!player.context)waveQueue=undefined;
      if(dailyMix){if(undo)dailyMix=undefined;else dailyMix.tracks=dailyMix.tracks.filter(t=>t.id!==id);}
      if (!fromSongActions) dialog.close();
      toast(undo?'Песня снова может появляться в рекомендациях':'Больше не будем рекомендовать эту песню');
      if(!undo&&player.current?.id===id)player.next(false,false);else if(player.context)refreshWave();
      if(!undo){const current=player.current;player.queue=player.queue.filter(t=>t.id!==id||t===current);player.index=current?player.queue.indexOf(current):-1;}
      if(currentView==='daily')void detail('daily','',generation);else if(currentView==='home')drawDaily();
    }
  }
  else if (action === 'album' || action === 'artist' || action === 'playlist') { event.preventDefault(); closeForNavigation(); go(`${action}/${encodeURIComponent(id)}`); }
  else if (action === 'mood') { closeForNavigation(); go(`mood/${encodeURIComponent(target.dataset.query || '')}`); }
  else if (action === 'account') account();
  else if (action === 'retry-auth') startSession();
  else if (action === 'auth-logout') void logoutAccount();
  else if(action==='artist-follow') {
    const follow=target as HTMLButtonElement;
    follow.disabled=true;
    const epoch=authEpoch,artistId=Number(id);
    try {
      await authReady;
      const {artists}=await api.favoriteArtists();
      if(epoch!==authEpoch)return;
      const wasFollowing=artists.some(a=>a.id===artistId);
      const ids=artists.map(a=>a.id).filter(a=>a!==artistId);
      if(!wasFollowing)ids.push(artistId);
      const result=await api.saveFavoriteArtists(ids);
      if(epoch!==authEpoch)return;
      setFollowButton(follow,result.artists.some(a=>a.id===artistId));
      await refreshArtistPreferences();
    } catch(error) {
      toast(error instanceof Error?error.message:'Не удалось изменить подписку');
    } finally {if(follow.isConnected)follow.disabled=false;}
  }
  else if(action==='favorite-artists')void openArtistPicker(dialog,showDialog,refreshArtistPreferences,toast);
  else if(action==='clear-search-history'){searchHistory=[];saveSearchHistory();drawSearchStart();}
  else if(action==='remove-search-history'){searchHistory.splice(Number(target.dataset.index),1);saveSearchHistory();drawSearchStart();}
  else if(action==='clear-listening-history'){showDialog('Очистить историю?', '<p class="dialog-description">Список прослушиваний исчезнет с этого устройства. Любимое и плейлисты сохранятся.</p><div class="dialog-actions"><button class="secondary-button" data-action="close">Отмена</button><button class="primary-button" data-action="confirm-clear-history">Очистить</button></div>');}
  else if(action==='confirm-clear-history'){library.history=[];save();dialog.close();historyView();}
  else if (action === 'choose-playlist-cover') dialog.querySelector<HTMLInputElement>('#playlist-cover-file')?.click();
  else if (action === 'clear-playlist-cover') {
    playlistCoverDraft = '';
    const form = target.closest<HTMLFormElement>('#playlist-form');
    if (form) { form.querySelector<HTMLInputElement>('#playlist-cover-file')!.value = ''; updatePlaylistCoverPreview(form); }
  }
  else if (action === 'queue') toggleQueue();
  else if (action === 'close-queue') closeQueue(true);
  else if(action==='blocked-tracks'){try{const data=await api.recommendationStatus();disliked=new Set(data.dislikes);const list=data.blocked_tracks;register(list);showDialog('Не рекомендовать',list.length?`<div class="action-list">${list.map(t=>`<button data-action="dislike" data-id="${e(t.id)}">${icon('plus')}<span>${e(t.title)}<small style="display:block;color:var(--muted)">${e(t.artist)} · Снова рекомендовать</small></span></button>`).join('')}</div>`:empty('В списке пока пусто','Нажмите «Не нравится» в меню песни, чтобы убрать её из рекомендаций.','thumbs-down'));}catch(error){toast(error instanceof Error?error.message:'Не удалось открыть список');}}
  else if (action === 'expand' || action === 'lyrics') fullPlayer(action === 'lyrics');
  else if (action === 'collapse-player') collapseFullPlayer();
  else if (action === 'close') dialog.close();
  else if (action === 'new-playlist') {
    pendingPlaylistTrack = playlistMenu.contains(target) ? tracks.get(playlistMenu.dataset.trackId || '') : undefined;
    playlistDialog();
  }
  else if (action === 'rename-playlist') { pendingPlaylistTrack = undefined; playlistDialog(id); }
  else if (action === 'import') importDialog();
  else if (action === 'spotify-connect') {
    try { const {url}=await api.spotifyStart();location.assign(url); }
    catch(error){toast(error instanceof Error?error.message:'Не удалось подключить Spotify.');}
  }
  else if (action === 'spotify-disconnect') {
    try{await api.spotifyDisconnect();importDialog();}
    catch(error){toast(error instanceof Error?error.message:'Не удалось отключить Spotify.');}
  }
  else if (action === 'spotify-more') {
    const list=target.closest<HTMLElement>('.spotify-playlists')!;
    (target as HTMLButtonElement).disabled=true;
    try{const page=await api.spotifyPlaylists(Number(id));if(list.isConnected)renderSpotifyLists(list,page.playlists,page.next_offset);}
    catch(error){toast(error instanceof Error?error.message:'Не удалось загрузить плейлисты.');}
    finally{(target as HTMLButtonElement).disabled=false;}
  }
  else if (action === 'spotify-import') void previewSpotify(id,target.textContent?.trim()||'Spotify');
  else if (action === 'import-spotify-export') {
    const list=spotifyExportLists[Number(id)];if(list)void previewSpotifyExport(list);
  }
  else if (action === 'import-playlist' || action === 'import-likes') saveImport(action==='import-likes');
  else if (action === 'translation') void toggleTranslation(target as HTMLButtonElement);
  else if (action === 'lyrics-view') {
    const shown=dialog.classList.toggle('show-lyrics');
    target.setAttribute('aria-pressed',String(shown)); target.classList.toggle('selected',shown);
    setLyricsFollowing(true); activeLyric=-1; updateLyrics();
  }
  else if (action === 'seek-lyric') { if(player.mode === 'full') { setLyricsFollowing(true); activeLyric=-1; player.seek(Number(target.dataset.time)); } }
  else if (action === 'follow-lyrics') { setLyricsFollowing(true); activeLyric=-1; updateLyrics(); }
  else if (action === 'retry-lyrics') void loadLyrics();
  else if (action === 'track-menu') trackMenu(target,id);
  else if (action === 'play-list' || action === 'play-likes') { const list = action === 'play-likes' ? library.likes : visibleTracks; if (list[0]) player.play(list[0],list); }
  else if (action === 'search-by-lyrics') openLyricSearch();
  else if (action === 'play-lyric-match') {
    const track=lyricMatches.find(item=>item.id===id);
    if(track){dialog.close();player.play(track,lyricMatches);}
  }
  else if (action === 'search-filter') {
    searchFilter = target.dataset.filter || 'all';
    selectPillButton(target.parentElement!, 'data-filter', searchFilter);
    if (searchQuery || main.querySelector<HTMLInputElement>('#search-input')?.value.trim()) void runSearch();
  } else if (action === 'search-suggestion') { const input = main.querySelector<HTMLInputElement>('#search-input')!; input.value = target.dataset.query || ''; void runSearch(); }
  else if (action === 'library-filter') { libraryFilter = target.dataset.filter || 'all'; libraryView(); }
  else if (action === 'theme') {
    library.settings.theme = target.dataset.theme === 'light' ? 'light' : 'dark';
    save(); applySettings();
    selectPillButton(target.parentElement!, 'data-theme', library.settings.theme);
  }
  else if (action === 'reload') { if (currentView === 'search') void runSearch(); else { discovery = []; navigate(); } }
  else if (action === 'back') navigateBack();
  else if (action === 'export') {
    const blob = new Blob([JSON.stringify(library,null,2)],{type:'application/json'}), url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `yamusic-collection-${new Date().toISOString().slice(0,10)}.json`; a.click(); setTimeout(()=>URL.revokeObjectURL(url),5000); toast('Копия медиатеки сохранена');
  } else if (action === 'add-playlist-menu') {
    const track = tracks.get(id) ?? (player.current?.id === id ? player.current : undefined);
    if (track) { register([track]); openPlaylistMenu(fromSongActions && menuAnchor ? menuAnchor : target,track); }
  } else if (action === 'add-to-playlist') {
    const p = library.playlists.find(p=>p.id === target.dataset.playlist), t = tracks.get(id);
    if (p && t && addPlaylistTrack(p,t) && playlistMenu.contains(target)) closePlaylistMenu(true);
  } else if (action === 'remove-playlist-track') {
    const p = currentPlaylist;
    if (p) {
      const before = p.tracks;
      p.tracks = p.tracks.filter(t=>t.id !== id);
      if (save()) { updatePlaylistContents(p); } else p.tracks = before;
    }
  } else if (action === 'delete-playlist') {
    showDialog('Удалить плейлист?',`<p class="dialog-description">Песни останутся в каталоге и в любимом.</p><div class="dialog-actions"><button class="secondary-button" data-action="close">Отмена</button><button class="primary-button" data-action="confirm-delete-playlist" data-id="${e(id)}">Удалить</button></div>`);
  } else if (action === 'confirm-delete-playlist') { library.playlists = library.playlists.filter(p=>p.id !== id); save(); dialog.close(); go('library'); }
});
async function playNeuroWave(form: HTMLFormElement): Promise<void> {
  const input=form.querySelector<HTMLInputElement>('input')!;
  const query=input.value.trim();
  if(query.length<2){input.focus();return;}
  neuroRequest?.abort();
  neuroTracks=[];
  main.querySelector<HTMLElement>('#neuro-results')!.hidden=true;
  const controller=new AbortController();
  neuroRequest=controller;
  const trigger=form.querySelector<HTMLButtonElement>('button')!;
  trigger.disabled=true;
  const status=document.createElement('p');
  status.className='neuro-status';
  status.setAttribute('role','status');
  status.textContent='Подбираем треки…';
  form.parentElement?.querySelector('.neuro-status')?.remove();
  form.after(status);
  try {
    const {tracks,reference}=await api.neuroWave(query,controller.signal);
    if(controller.signal.aborted||!form.isConnected)return;
    if(!tracks.length){status.textContent='Не нашли подходящих треков. Попробуйте описать настроение иначе.';return;}
    neuroTracks=register(tracks);
    api.prepare(tracks.slice(0,3));
    const results=main.querySelector<HTMLElement>('#neuro-results')!;
    results.innerHTML=sectionHeading(reference?`Похоже на ${reference}`:'Нейро-волна',
      '<button class="primary-button" data-action="play-neuro">'+icon('play')+'Слушать</button>',
      trackCount(tracks.length))+`<div class="track-list">${tracks.map((track,index)=>row(track,index,'play-neuro')).join('')}</div>`;
    results.hidden=false;
    hydrateIcons(results);
    status.remove();
  } catch(error) {
    if(!controller.signal.aborted)status.textContent=error instanceof Error?error.message:'Не удалось подобрать треки.';
  } finally {
    if(neuroRequest===controller)trigger.disabled=false;
  }
}

document.addEventListener('submit', event => {
  const form = event.target as HTMLFormElement;
  if (form.id === 'search-form') { event.preventDefault(); clearTimeout(searchTimer); void runSearch(); }
  else if (form.id === 'lyric-search-form') { event.preventDefault();void findByLyrics(form); }
  else if (form.id === 'music-import-form') { event.preventDefault();void previewImport(form); }
  else if (form.id === 'neuro-form') {
    event.preventDefault();
    void playNeuroWave(form);
  }
  else if (form.id === 'playlist-form') {
    event.preventDefault(); const title = String(new FormData(form).get('title') || '').trim(); if (!title) return;
    const existing = library.playlists.find(p=>p.id === form.dataset.id), previous=existing?{...existing}:undefined;
    const description=String(new FormData(form).get('description')||'').trim().slice(0,1000);
    if(existing){existing.title=title.slice(0,100);existing.description=description;existing.cover_url=playlistCoverDraft;}
    const playlist = existing ?? {id:crypto.randomUUID(),title:title.slice(0,100),description,cover_url:playlistCoverDraft,tracks:pendingPlaylistTrack ? [pendingPlaylistTrack] : [],createdAt:Date.now()};
    if (!existing) library.playlists.push(playlist);
    if(!save()){if(existing&&previous)Object.assign(existing,previous);else library.playlists.pop();return;}
    const addedTrack = !existing && pendingPlaylistTrack;
    pendingPlaylistTrack = undefined;
    dialog.close();
    if (addedTrack && currentView === 'home' && player.context) celebrateWave();
    else go(`playlist/${encodeURIComponent(playlist.id)}`);
    toast(existing ? 'Плейлист обновлён' : 'Плейлист создан');
  }
});
document.addEventListener('input', event => {
  const input = event.target as HTMLInputElement;
  if(input.id==='crossfade'){
    const seconds=Number(input.value);
    library.settings.crossfade=seconds;
    player.setCrossfade(seconds);
    save();
  }
  else if (input.matches('[data-volume]')) { player.setVolume(Number(input.value)); library.settings.volume = player.volume; save(); fillRange(input); }
  else if (input.matches('[data-seek]')) { player.seek(Number(input.value)); fillRange(input); }
  else if (input.id === 'search-input') { clearTimeout(searchTimer); searchTimer = window.setTimeout(()=>void runSearch(),450); }
  else if (input.id === 'playlist-description') resizePlaylistDescription(input as unknown as HTMLTextAreaElement);
  else if (input.matches('.playlist-menu-search')) {
    const query = input.value.trim().toLocaleLowerCase('ru');
    let matches = 0;
    for (const option of playlistMenu.querySelectorAll<HTMLButtonElement>('[data-playlist]')) {
      const title = option.querySelector('strong')!.textContent ?? '';
      option.hidden = !title.toLocaleLowerCase('ru').includes(query);
      if (!option.hidden) matches++;
    }
    playlistMenu.querySelector<HTMLElement>('.playlist-menu-empty')!.hidden = matches > 0;
    positionPlaylistMenu();
  }
});
document.addEventListener('change', async event => {
  const input = event.target as HTMLInputElement;
  if (input.id === 'animations') { library.settings.animations = input.checked; save(); applySettings(); }
  if(input.id==='playlist-cover-file'&&input.files?.[0]){
    const form=dialog.querySelector<HTMLFormElement>('#playlist-form'),submit=form?.querySelector<HTMLButtonElement>('[type="submit"]');if(submit)submit.disabled=true;
    try{const cover=await loadPlaylistCover(input.files[0]);if(form?.isConnected){playlistCoverDraft=cover;updatePlaylistCoverPreview(form);}}catch(error){toast(error instanceof Error?error.message:'Не удалось загрузить обложку');}finally{if(submit)submit.disabled=false;input.value='';}
  }
  if(input.id==='spotify-export-file'&&input.files?.[0])void readSpotifyExport(input.files[0]);
  if (input.id === 'library-import' && input.files?.[0]) {
    const file = input.files[0];
    if (file.size > 5 * 1024 * 1024) { toast('Выберите копию меньше 5 МБ'); return; }
    try {
      const raw = await file.text();
      const parsed = JSON.parse(raw); if (parsed?.version !== 1 || !Array.isArray(parsed.likes) || !Array.isArray(parsed.playlists)) throw new Error('invalid');
      const incoming = restoreLibrary(raw);
      library.likes = uniqueTracks([...library.likes,...incoming.likes]);
      library.history = uniqueTracks([...library.history,...incoming.history]).slice(0,100);
      for (const p of incoming.playlists) {
        const existing = library.playlists.find(item=>item.id === p.id);
        if (existing) existing.tracks = uniqueTracks([...existing.tracks,...p.tracks]); else library.playlists.push(p);
      }
      register([...library.likes,...library.history,...library.playlists.flatMap(p=>p.tracks)]);
      save(); dialog.close(); go('library'); toast('Коллекция восстановлена');
    } catch { toast('Не удалось прочитать копию YaMusic'); }
  }
});
dialog.addEventListener('close',()=>{
  if (!dialog.open) {
    lyricsRequest?.abort(); translationRequest?.abort(); importRequest?.abort(); lyricSearchRequest?.abort();
    if (dialog.contains(songActions)) closeSongActions();
    if (dialog.contains(queuePanel)) closeQueue();
    if (dialog.contains(playlistMenu)) closePlaylistMenu();
    pendingPlaylistTrack = undefined;
  }
});
function positionTrackMenus(): void { positionPlaylistMenu(); positionSongActions(); }
main.addEventListener('scroll',positionTrackMenus,{passive:true});
dialog.addEventListener('scroll',positionTrackMenus,{passive:true});
window.addEventListener('resize',positionTrackMenus);
document.addEventListener('keydown', event=>{
  if (event.key !== 'Escape') return;
  if (playlistMenu.matches(':popover-open')) { event.preventDefault(); closePlaylistMenu(true); }
  else if (songActions.matches(':popover-open')) { event.preventDefault(); closeSongActions(true); }
  else if (queuePanel.matches(':popover-open')) { event.preventDefault(); closeQueue(true); }
});
dialog.addEventListener('cancel', event => {
  if (!dialog.classList.contains('full-player-dialog')) return;
  event.preventDefault();
  collapseFullPlayer();
});
dialog.addEventListener('wheel',event=>{ if((event.target as HTMLElement).closest('.lyrics-scroll')) setLyricsFollowing(false); },{passive:true});
dialog.addEventListener('touchmove',event=>{ if((event.target as HTMLElement).closest('.lyrics-scroll')) setLyricsFollowing(false); },{passive:true});
dialog.addEventListener('keydown',event=>{
  if ((event.target as HTMLElement).closest('.lyrics-scroll') && ['ArrowUp','ArrowDown','PageUp','PageDown','Home','End'].includes(event.key)) {
    setLyricsFollowing(false);
    event.stopPropagation();
  }
});
function isBackdrop(event: MouseEvent): boolean {
  if (event.target !== dialog) return false;
  const bounds = dialog.getBoundingClientRect();
  return event.clientX < bounds.left || event.clientX > bounds.right
    || event.clientY < bounds.top || event.clientY > bounds.bottom;
}
let pressedBackdrop = false;
dialog.addEventListener('pointerdown', event => { pressedBackdrop = isBackdrop(event); });
dialog.addEventListener('pointercancel', () => { pressedBackdrop = false; });
dialog.addEventListener('click', event => {
  if (pressedBackdrop && isBackdrop(event)) dialog.close();
  pressedBackdrop = false;
});
function adjustVolume(direction:number):void {
  player.setVolume(Math.round((player.volume+direction*.05)*100)/100);
  library.settings.volume=player.volume;
  save();
}
let playerSwipe: {id:number;x:number;y:number} | undefined;
let suppressPlayerClick = 0;
playerBar.addEventListener('pointerdown',event=>{
  if(!useMobilePlayer.matches||event.pointerType==='mouse'||!event.isPrimary||!player.current)return;
  if ((event.target as Element).closest('.player-range')) return;
  playerSwipe={id:event.pointerId,x:event.clientX,y:event.clientY};
});
window.addEventListener('pointercancel',event=>{if(playerSwipe?.id===event.pointerId)playerSwipe=undefined;});
window.addEventListener('pointerup',event=>{
  if(playerSwipe?.id!==event.pointerId)return;
  const dx=event.clientX-playerSwipe.x,dy=event.clientY-playerSwipe.y;
  playerSwipe=undefined;
  if(Math.abs(dx)<42 || Math.abs(dx)<Math.abs(dy)*1.35)return;
  suppressPlayerClick=performance.now()+380;
  if(dx<0)player.next();else player.previous(false);
});
playerBar.addEventListener('click',event=>{
  if(performance.now()<suppressPlayerClick){
    event.preventDefault();event.stopPropagation();return;
  }
  if(!player.current||(event.target as Element).closest('button,a,input'))return;
  fullPlayer();
});
document.addEventListener('wheel',event=>{
  if(event.ctrlKey||!event.deltaY||!(event.target as HTMLElement).closest('.volume-group'))return;
  event.preventDefault();adjustVolume(event.deltaY<0?1:-1);
},{passive:false});
document.addEventListener('keydown', event => {
  const target=event.target as HTMLElement;
  if (!authUser || event.ctrlKey || event.metaKey || event.altKey || (dialog.open&&!dialog.classList.contains('full-player-dialog'))) return;
  if (target.closest('input,textarea,select,[contenteditable]')) {
    if (target.matches('[data-volume]') && (event.key==='ArrowUp'||event.key==='ArrowDown')) {
      event.preventDefault();adjustVolume(event.key==='ArrowUp'?1:-1);
    }
    return;
  }
  if (!target.closest('button,a') && (event.code === 'Space' || event.key.toLowerCase() === 'k')) { event.preventDefault(); player.toggle(); }
  if (event.key === 'ArrowRight') { event.preventDefault(); if(!event.repeat)player.next(); }
  if (event.key === 'ArrowLeft') { event.preventDefault(); if(!event.repeat)player.previous(false); }
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.preventDefault();adjustVolume(event.key === 'ArrowUp' ? 1 : -1);
  }
});
// Drag the highlight to select a tab on release.
let navPointer: number | undefined;
let navStartX = 0;
let suppressNavClickUntil = 0;
function moveLens(x: number): void {
  const rect=mobileNav.getBoundingClientRect();
  const available = rect.width - 10, lens = available / 3;
  mobileNav.style.setProperty('--drag-left', `${Math.max(0,Math.min(available-lens,x-rect.left-5-lens/2))}px`);
}
mobileNav.addEventListener('pointerdown',event=> { if(event.pointerType === 'mouse') return; navPointer=event.pointerId; navStartX=event.clientX; mobileNav.classList.add('dragging'); moveLens(event.clientX); mobileNav.setPointerCapture(event.pointerId); });
mobileNav.addEventListener('pointermove',event=> { if(navPointer===event.pointerId) moveLens(event.clientX); });
mobileNav.addEventListener('pointerup',event=> {
  if(navPointer!==event.pointerId) return;
  const rect=mobileNav.getBoundingClientRect(), index=Math.max(0,Math.min(2,Math.floor((event.clientX-rect.left)/rect.width*3)));
  if(Math.abs(event.clientX-navStartX)>10) suppressNavClickUntil=Date.now()+500;
  navPointer=undefined; mobileNav.classList.remove('dragging'); go(navItems[index].page);
});
mobileNav.addEventListener('click',event=> { if(Date.now()<suppressNavClickUntil) { event.preventDefault(); event.stopPropagation(); } },true);
mobileNav.addEventListener('pointercancel',()=> { navPointer=undefined; mobileNav.classList.remove('dragging'); });
player.addEventListener('change',updatePlayerControls);
player.addEventListener('tick',()=>{
  updateProgress();
  if(player.playing)void persistPlayback();
});
player.addEventListener('pause',()=>{
  if(player.mode==='full')void persistPlayback(true);
});
player.addEventListener('seeked',()=>void persistPlayback(true));
player.addEventListener('resume-position',()=>void persistPlayback(true));
window.addEventListener('pagehide',()=>void persistPlayback(true));
document.addEventListener('visibilitychange',()=>{if(document.hidden)void persistPlayback(true);});
function refreshWave():Promise<void>{
  const session=player.context,id=player.current?.id;if(!session||!id)return Promise.resolve();
  recommendationUpdate=recommendationUpdate.catch(()=>{}).then(async()=>{
    if(player.context!==session||player.current?.id!==id)return;
    await api.flushReactions();const data=await api.advanceWave(session,id);
    if(player.context!==session||player.current?.id!==id)return;
    register(data.tracks);waveQueue=data;
    player.replaceAhead(data.tracks.filter(t=>t.id===id||!failedWaveTracks.has(t.id)));
    api.prepare(player.queue.slice(player.index+1,player.index+6),true);
    drawWaveQueue();
  }).catch(()=>{/* Keep the prepared queue playing; a later advance retries. */});
  return recommendationUpdate;
}
player.addEventListener('waveend',()=>{
  if(waveContinuation)return;
  const session=player.context,id=player.current?.id;
  if(!session||!id)return;
  const unchanged=()=>player.context===session&&player.current?.id===id&&player.audio.paused;
  const continuation=(async()=>{
    await refreshWave();
    if(!unchanged())return;
    if(player.queue[player.index+1]){player.next(true);return;}
    waveQueue=undefined;
    const data=await getWave();
    if(!unchanged())return;
    const next=data.tracks.find(t=>t.id!==id&&!failedWaveTracks.has(t.id));
    if(next)player.play(next,data.tracks.filter(t=>!failedWaveTracks.has(t.id)),data.session_id);
    else toast('Пока не удалось подобрать следующий доступный трек');
  })().catch(()=>toast('Не удалось продолжить волну. Нажмите «Далее», чтобы повторить.'))
    .finally(()=>{if(waveContinuation===continuation)waveContinuation=undefined;});
  waveContinuation=continuation;
});
player.addEventListener('reaction',event=>{
  const reaction=(event as CustomEvent<Omit<Reaction,'event_id'>>).detail;
  recommendationUpdate=recommendationUpdate.catch(()=>{}).then(()=>api.react(reaction));
});
player.addEventListener('trackchange',event=> {
  const track=(event as CustomEvent<Track>).detail;
  renderPlayer();
  void api.track(track.id).then(full=>{
    applyTrackMetadata(full);save();
    if(player.current?.id===full.id)renderPlayer();
  }).catch(()=>{});
  if(!restoringPlayback)void persistPlayback(true,player.mode==='full'?player.time:0);
  api.prepare(player.queue.slice(player.index+(restoringPlayback?0:1),player.index+6),true);
  if(player.context&&!restoringPlayback)refreshWave();
  if(dialog.open && dialog.classList.contains('full-player-dialog')) fullPlayer(dialog.classList.contains('show-lyrics'));
});
let historyTrackId='';
player.addEventListener('playing',()=>{const track=player.current;if(track&&historyTrackId!==track.id){historyTrackId=track.id;library.history=uniqueTracks([track,...library.history]).slice(0,100);save();if(currentView==='history')historyView();else if(currentView==='home'){const section=document.querySelector('#recent-section');if(section){section.innerHTML=sectionHeading('Недавно слушали','<a class="text-button" href="#/history">Вся история '+icon('arrow-right')+'</a>')+rows(library.history,4);hydrateIcons(section as HTMLElement);}}}});
player.addEventListener('playererror',event=>{
  const current=player.current;
  if(player.context&&current&&player.mode==='unavailable'&&!failedWaveTracks.has(current.id)&&failedWaveTracks.size<5){
    failedWaveTracks.add(current.id);
    player.next(false,false);
    return;
  }
  toast((event as CustomEvent<string>).detail);
});
player.addEventListener('playing',()=>failedWaveTracks.clear());
player.addEventListener('playbacknotice',event=>toast((event as CustomEvent<string>).detail));
window.addEventListener('hashchange',navigate);
window.addEventListener('yamusic-session-expired',()=>{
  if(!authUser)return;
  authUser=null;resetAccountRecommendations();player.reset();renderPlayer();renderSession();
});
window.addEventListener('offline',()=>toast('Нет интернета. Ваша медиатека сохранена, для музыки нужно подключение.'));
window.addEventListener('online',()=>toast('Снова на связи'));
document.addEventListener('error',event=> {
  const img = event.target;
  if (!(img instanceof HTMLImageElement)) return;
  if (img.closest('.telegram-avatar')) { img.remove(); return; }
  if (app.contains(img)) { img.style.visibility='hidden'; img.parentElement?.classList.add('image-unavailable'); }
},true);
mountPillGroups();
renderPlayer(); startSession();

import './style.css';
import './features.css';
import { icon, hydrateIcons } from './icons.ts';
import { api } from './api.ts';
import type { WaveQueue, Mixes, Reaction, AuthUser, AuthConfig, TelegramLogin, ResumeSnapshot, ImportPreview } from './api.ts';
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
import { mountPlayerRanges, playerRange, showCurrentVolume } from './player-range.ts';
import { mountCoverParallax } from './cover-parallax.ts';
import { mountSidebar } from './sidebar.ts';
import { animateDeck, animateLyricEcho, animatePlayerButton, scrollToLyric, stopLyricsScroll } from './player-motion.ts';
import { interfaceMotion, springFrames } from './springs.ts';
import { readRecentSearch, recordSearchItem, refreshSearchArtist, type SearchHistorySection } from './recent-search.ts';
import { applyAccountLibrary, LibrarySync } from './account-library.ts';
import { PlaybackDevices } from './playback-devices.ts';
import { desktopUpdate, Downloads, invokeDesktop, localDesktop, windowsDesktop } from './desktop.ts';

const app = document.querySelector<HTMLDivElement>('#app')!;
const dialog = document.querySelector<HTMLDialogElement>('#dialog')!;
let library = restoreLibrary(localStorage.getItem(STORAGE_KEY));
let librarySync: LibrarySync | undefined;
let libraryUser: number | undefined;
let playbackDevices: PlaybackDevices | undefined;
let downloads: Downloads | undefined;
const player = new Player(library.settings.volume);
player.setCrossfade(library.settings.crossfade);
const playbackModesKey = 'yamusic.playback-modes.v1';
try {
  const modes = JSON.parse(localStorage.getItem(playbackModesKey) ?? 'null');
  player.shuffle = modes?.shuffle === true;
  if (modes?.repeat === 'one' || modes?.repeat === 'all') player.repeat = modes.repeat;
} catch { /* Keep the playback defaults if storage is unavailable. */ }

function savePlaybackModes(): void {
  if (player.mirroring) return;
  try {
    localStorage.setItem(playbackModesKey, JSON.stringify({ shuffle: player.shuffle, repeat: player.repeat }));
  } catch { /* Playback can continue without storage. */ }
}
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
let searchByLyrics = false;
const expandedSearchHistory = new Set<SearchHistorySection>();
const searchModePlaceholder = () => searchByLyrics ? 'Введите строчку, которую помните' : 'Трек, исполнитель или альбом';
const SEARCH_HISTORY_KEY='yamusic.search-history.v1';
let searchHistory=restoreSearchHistory(localStorage.getItem(SEARCH_HISTORY_KEY));
let searchHistoryTimer=0;
let searchRequest: AbortController | undefined;
let searchTimer = 0;
let detailRequest: AbortController | undefined;
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
let personalMixes:Mixes|undefined;
let mixesPromise:Promise<Mixes>|undefined;
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
async function getMixes(): Promise<Mixes> {
  const epoch=authEpoch;
  return mixesPromise??=(async()=>{
    await syncProfile();
    const data=await api.mixes();
    if(epoch!==authEpoch)throw new Error('Профиль изменился. Обновите подборки.');
    for(const mix of data.mixes)mix.tracks=register(mix.tracks.filter(track=>!disliked.has(track.id)));
    personalMixes=data;
    return data;
  })().finally(()=>{if(epoch===authEpoch)mixesPromise=undefined;});
}
function drawWaveQueue():void{
  const note=document.querySelector('.hero-footnote');
  if(note&&waveQueue)note.textContent=waveQueue.personalized?'Подстраивается под ваш вкус':'Знакомимся с вашим вкусом · ставьте лайки';
}
function drawMixes(): void {
  const target=document.querySelector<HTMLElement>('#daily-cards');
  if(!target||!personalMixes)return;
  target.innerHTML=personalMixes.mixes.map((mix,index)=>`
    <a href="#/daily/${e(mix.id)}" class="music-card">
      <span class="card-image mood-art ${['evening','night','focus','ambient','evening'][index]}">${mix.tracks[0]?.cover_url?image(mix.tracks[0].cover_url):icon('list-music')}</span>
      <strong class="card-title">${e(mix.title)}</strong><span>${e(mix.description)}</span>
    </a>`).join('');
  hydrateIcons(target);
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
  try {
    localStorage.setItem(libraryUser===undefined ? STORAGE_KEY : `${STORAGE_KEY}.${libraryUser}`, JSON.stringify(library));
    librarySync?.capture(library,searchHistory);
    return true;
  }
  catch { toast('Не хватает места для медиатеки. Попробуйте уменьшить обложку или сохранить копию коллекции.'); return false; }
}
function applySettings(): void {
  document.documentElement.dataset.theme = library.settings.theme;
  document.documentElement.dataset.motion = library.settings.animations ? 'on' : 'off';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', library.settings.theme === 'dark' ? '#151617' : '#f3f3f1');
  wave?.setEnabled(library.settings.animations);
}

async function openDownloads(account: number): Promise<void> {
  const downloadList=new Downloads(account);
  downloads=downloadList;
  if(localDesktop)player.offlineSource=id=>downloads?.source(id);
  await downloadList.refresh();
  if(downloads===downloadList&&currentView==='downloads')downloadsView();
}

function downloadsView(): void {
  const id=location.hash.split('/')[2]??'';
  const playlist=downloads?.playlists[id];
  const entries=downloads?.entries??{};
  const members=playlist?playlist.tracks.flatMap(id=>entries[id]?[entries[id]]:[]):Object.values(entries);
  const list=members.map(({track,artwork})=>({
    ...track,cover_url:artwork||track.cover_url,
  }));
  visibleTracks=register(list);
  main.innerHTML=`<div class="page-heading"><h1>${e(playlist?.title??'Скачанное')}</h1><div class="heading-actions">${localDesktop?
    '<a class="secondary-button" href="https://yamusic.pigboss.xyz/">Вернуться онлайн</a>':
    '<button class="secondary-button" data-action="downloads-folder">Выбрать папку</button>'}</div></div>
    ${playlist?'<a class="text-button" href="#/downloads">Все загрузки</a>':`
      ${downloads?.folder?`<p class="download-folder">${e(downloads.folder)}</p>`:''}
      <div class="filter-row">${Object.entries(downloads?.playlists??{}).filter(([,item])=>item.tracks.some(id=>id in entries))
        .map(([id,item])=>`<a class="chip" href="#/downloads/${encodeURIComponent(id)}">${e(item.title)}</a>`).join('')}</div>`}
    ${list.length?`<button class="primary-button" data-action="play-list">${icon('play')}Слушать</button><div class="track-list">${list.map((track,index)=>`<div class="download-row">${row(track,index)}${button('remove-download','trash-2','Удалить скачанный трек',`data-id="${e(track.id)}"`)}</div>`).join('')}</div>`:empty('Загрузок пока нет','Скачайте трек или плейлист в YaMusic, чтобы слушать его офлайн.','download')}`;
  hydrateIcons(main);
}

async function queueDownloads(list: Track[], trigger: HTMLElement, playlist?:{id:string;title:string}): Promise<void> {
  const target=downloads;
  if(!target||!list.length)return;
  trigger.setAttribute('disabled','');
  let failed=0;
  try {
    for(const track of uniqueTracks(list)){
      if(downloads!==target)break;
      try{await target.save(track);}catch{failed++;}
    }
    if(playlist&&downloads===target)await target.savePlaylist(playlist.id,playlist.title,list);
    toast(failed?`Не удалось скачать ${trackCount(failed)}`:'Загрузка готова');
    if(currentView==='downloads')downloadsView();
  } catch(error) { toast(String(error)); }
  finally { trigger.removeAttribute('disabled'); }
}

function showUpdateNotification(): void {
  const version=desktopUpdate();
  if(!version||localDesktop)return;
  const old=document.querySelector('.desktop-update');
  if(old)return;
  const message=document.createElement('aside');
  message.className='desktop-update';
  message.setAttribute('role','status');
  message.innerHTML=`<span>Версия ${e(version)} скачана</span><button class="primary-button" data-action="install-update">Установить</button>${button('dismiss-update','x','Закрыть')}`;
  document.body.append(message);hydrateIcons(message);
  const actions=document.querySelector<HTMLElement>('[data-update-actions]');
  if(actions){actions.innerHTML=updateAction();hydrateIcons(actions);}
}

function updateAction(): string {
  const version=desktopUpdate();
  return version?`<button class="secondary-button" data-action="install-update">Установить ${e(version)}</button>`:'';
}

function downloadListButton(): string {
  return windowsDesktop&&!localDesktop&&visibleTracks.length?
    '<button class="secondary-button" data-action="download-list">'+icon('download')+'Скачать</button>':'';
}

function desktopSettings(): string {
  if(!windowsDesktop||localDesktop)return '';
  return `<section class="settings-group">
    <h2>Приложение Windows</h2>
    <div class="setting-row"><span class="setting-label">${icon('download')}<span>Папка загрузок<small>${e(downloads?.folder??'')}</small></span></span>
      <button class="secondary-button" data-action="downloads-folder">Выбрать</button></div>
    <div class="setting-row"><a href="#/downloads">Скачанное</a><button class="secondary-button" data-action="open-offline">Открыть офлайн</button></div>
    <div class="setting-row"><span class="setting-label">${icon('refresh-cw')}<span>Обновления<small>Проверяются при запуске</small></span></span><span data-update-actions>${updateAction()}</span></div>
  </section>`;
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
      <div class="sidebar-header">
        <a class="brand" href="#/home" aria-label="YaMusic — главная">${icon('audio-lines')}<span class="sidebar-label">YaMusic<span class="brand-dot">.</span></span></a>
        <button class="icon-button sidebar-toggle" type="button" aria-controls="desktop-navigation" aria-label="Свернуть боковое меню" aria-expanded="true">${icon('chevron-left')}</button>
      </div>
      <nav id="desktop-navigation" class="desktop-navigation tab-pill-group" aria-label="Основная навигация">${navItems.map(n => `<a href="#/${n.page}" data-page="${n.page}" class="navigation-link" aria-label="${n.label}" title="${n.label}">${icon(n.glyph)}<span class="sidebar-label">${n.label}</span></a>`).join('')}</nav>
      <div class="settings-account"><a href="#/settings" data-page="settings" aria-label="Настройки" title="Настройки">${icon('settings-2')}<span class="sidebar-label">Настройки</span></a><button data-action="account" data-account-avatar aria-label="Мой аккаунт" title="Мой аккаунт">${accountAvatar()}</button></div>
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

function row(track: Track, index = 0): string {
  const liked = library.likes.some(t => t.id === track.id);
  return `<div class="track-row ${player.current?.id === track.id ? 'current-track' : ''}" data-track-row="${e(track.id)}">
    <span class="track-number">${String(index + 1).padStart(2, '0')}</span>
    <button class="track-cover" data-action="play" data-id="${e(track.id)}" aria-label="Включить ${e(track.title)}">${image(track.cover_url)}<span class="cover-play">${icon('play')}</span></button>
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
    <section class="section daily-section">${sectionHeading('Подборки для вас')}<div class="card-rail" id="daily-cards">${loading()}</div></section>
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
  void getMixes().then(()=>{if(gen===generation)drawMixes();}).catch(()=>{if(gen===generation)document.querySelector('#daily-cards')!.innerHTML='<p class="muted">Микс пока недоступен</p>';});
}

function search(): void {
  main.innerHTML = `<div class="page-heading"><div><span class="eyebrow">ВЕСЬ МИР МУЗЫКИ</span><h1>Поиск</h1></div></div>
    <form class="search-form" id="search-form" role="search">${icon('search')}
      <input id="search-input" name="q" type="search" placeholder="${searchModePlaceholder()}" autocomplete="off" aria-label="Поиск музыки" maxlength="200" value="${e(searchQuery)}"/>
      <button class="search-mode" type="button" data-action="search-by-lyrics" aria-pressed="${searchByLyrics}">${icon('sparkles')}По тексту</button>
    </form>
    <div id="search-filters" class="filter-row" ${searchByLyrics ? 'hidden' : ''}>
      <div class="tab-pill-group" role="group" aria-label="Что искать">${[['all','Всё'],['track','Треки'],['album','Альбомы'],['artist','Исполнители']].map(([id,title])=>`<button class="chip ${searchFilter === id ? 'selected' : ''}" data-action="search-filter" data-filter="${id}" aria-pressed="${searchFilter === id}">${title}</button>`).join('')}</div>
    </div><div id="search-results" aria-live="polite"></div>`;
  main.querySelector('#search-form')!.classList.toggle('lyrics-mode', searchByLyrics);
  if (searchQuery && searchResults) {
    visibleTracks = searchResults.tracks;
    drawSearchResults();
  } else if (searchQuery && searchByLyrics) drawLyricsSearchPrompt();
  else if (searchQuery) void runSearch();
  else drawSearchStart();
  hydrateIcons(main);
  syncTabPill(main.querySelector<HTMLElement>('.tab-pill-group')!);
}

function saveSearchHistory(): void {
  try {
    localStorage.setItem(libraryUser === undefined ? SEARCH_HISTORY_KEY : `${SEARCH_HISTORY_KEY}.${libraryUser}`, JSON.stringify(searchHistory));
    librarySync?.capture(library, searchHistory);
  } catch { /* Browsing remains available with full storage. */ }
}

function rememberCurrentSearch(): void {
  if (!searchQuery) return;
  searchHistory = rememberSearch(searchHistory, searchQuery);
  saveSearchHistory();
}

const historyTitles = { tracks: 'Недавние треки', albums: 'Альбомы', artists: 'Исполнители' };
const historySections = ['tracks', 'albums', 'artists'] as const;
const searchHistorySpring = springFrames(260, 24, 420);

function searchHistoryContent(kind: SearchHistorySection, recent: ReturnType<typeof readRecentSearch>): string {
  const limit = expandedSearchHistory.has(kind) ? recent[kind].length : 5;
  if (kind === 'tracks') return rows(recent.tracks.slice(0, limit));
  const cards = kind === 'albums' ? recent.albums.slice(0, limit).map(albumCard) : recent.artists.slice(0, limit).map(artistCard);
  return `<div class="search-history-rail${expandedSearchHistory.has(kind) ? ' is-expanded' : ''}">${cards.join('')}</div>`;
}

function drawSearchStart(): void {
  const results = main.querySelector<HTMLElement>('#search-results');
  if (!results) return;
  results.inert = false;
  const recent = readRecentSearch(authUser?.id);
  visibleTracks = recent.tracks;
  const sections = historySections.map(kind => {
    if (!recent[kind].length) return '';
    const open = expandedSearchHistory.has(kind);
    const action = recent[kind].length > 5 ? `<button class="text-button" type="button" data-action="search-history-expand" data-kind="${kind}" aria-label="${open ? 'Свернуть' : 'Показать все'} · ${historyTitles[kind]}" aria-controls="search-history-${kind}" aria-expanded="${open}">${open ? 'Свернуть' : 'Показать все'} ${icon(open ? 'chevron-down' : 'arrow-right')}</button>` : '';
    return `<section class="section search-history">${sectionHeading(historyTitles[kind],action)}<div id="search-history-${kind}">${searchHistoryContent(kind,recent)}</div></section>`;
  }).join('');
  const queries = searchHistory.length ? `<section class="section search-history">${sectionHeading('Запросы','<button class="text-button" data-action="clear-search-history">Очистить</button>')}
    <div class="search-history-items">${searchHistory.map((q,index)=>`<span class="history-chip"><button type="button" data-action="search-suggestion" data-query="${e(q)}">${e(q)}</button><button type="button" class="remove-query" data-action="remove-search-history" data-index="${index}" aria-label="Убрать ${e(q)} из истории">${icon('x')}</button></span>`).join('')}</div></section>` : '';
  if (sections || queries) results.innerHTML = sections + queries;
  else {
    loadMoodCovers();
    results.innerHTML = `<section class="section">${sectionHeading('Что послушаем?', '', 'Выберите настроение или найдите что-то своё')}<div class="card-rail">${moods.map(moodCard).join('')}</div></section>`;
  }
  hydrateIcons(results);
}

function toggleSearchHistory(button: HTMLElement): void {
  const kind = historySections.find(section => section === button.dataset.kind);
  const content = kind && main.querySelector<HTMLElement>(`#search-history-${kind}`);
  if (!kind || !content) return;
  const from = content.getBoundingClientRect().height;
  content.getAnimations().forEach(animation => animation.cancel());
  const open = !expandedSearchHistory.has(kind);
  if (open) expandedSearchHistory.add(kind); else expandedSearchHistory.delete(kind);
  button.setAttribute('aria-expanded', String(open));
  button.setAttribute('aria-label', `${open ? 'Свернуть' : 'Показать все'} · ${historyTitles[kind]}`);
  button.innerHTML = `${open ? 'Свернуть' : 'Показать все'} ${icon(open ? 'chevron-down' : 'arrow-right')}`;
  content.innerHTML = searchHistoryContent(kind, readRecentSearch(authUser?.id));
  hydrateIcons(button);
  hydrateIcons(content);
  if (interfaceMotion()) {
    const to = content.getBoundingClientRect().height;
    if (from !== to) {
      content.animate(searchHistorySpring.map(p => ({
        height: `${Math.max(0, from + (to - from) * p)}px`, overflow: 'clip',
      })), 420);
    }
    if (open) [...content.querySelectorAll<HTMLElement>('.track-row, .music-card')].slice(5, 10).forEach((item, i) => {
      item.animate([{ opacity: 0, translate: '0 6px' }, { opacity: 1, translate: '0 0' }], {
        duration: 280, delay: 35 * i, fill: 'backwards', easing: 'ease-out',
      });
    });
  }
}

function rememberOpenedResult(target: HTMLElement): void {
  if (currentView !== 'search' || !searchResults || !target.closest('#search-results')) return;
  const id = target.dataset.id;
  const account = authUser?.id;
  const action = target.dataset.action;
  if (action === 'play' || target.matches('.track-name')) {
    const track = searchResults.tracks.find(item => item.id === (target.closest<HTMLElement>('[data-track-row]')?.dataset.trackRow ?? id));
    if (track) recordSearchItem(account, 'tracks', track);
  }
  if (action === 'album') {
    const track = searchResults.tracks.find(item => String(item.album_id) === id);
    const album = searchResults.albums.find(item => String(item.id) === id);
    if (album) recordSearchItem(account, 'albums', album);
    else if (track) recordSearchItem(account, 'albums', { id: track.album_id, title: track.album, artist: track.artist, artist_id: track.artist_id, cover_url: track.cover_url, track_count: 0 });
  } else if (action === 'artist') {
    const artist = searchResults.artists.find(item => String(item.id) === id);
    if (artist) recordSearchItem(account, 'artists', artist);
    else {
      const credit = searchResults.tracks.flatMap(trackArtists).find(item => String(item.id) === id);
      if (credit) recordSearchItem(account, 'artists', { id: credit.id, name: credit.name, picture_url: '' });
    }
  }
}

function drawLyricsSearchPrompt(): void {
  const results = main.querySelector<HTMLElement>('#search-results');
  if (!results) return;
  results.inert = false;
  results.innerHTML = '<button type="submit" form="search-form" class="secondary-button lyrics-search-submit">Найти трек</button>';
}

function toggleSearchByLyrics(): void {
  const input = main.querySelector<HTMLInputElement>('#search-input')!;
  const form = input.form!;
  const filters = main.querySelector<HTMLElement>('#search-filters')!;
  clearTimeout(searchTimer);
  clearTimeout(searchHistoryTimer);
  searchRequest?.abort();
  if (searchResults) rememberCurrentSearch();
  searchResults = undefined;
  visibleTracks = [];
  searchByLyrics = !searchByLyrics;
  searchQuery = input.value.trim();
  form.classList.toggle('lyrics-mode', searchByLyrics);
  form.querySelector('[data-action="search-by-lyrics"]')!.setAttribute('aria-pressed', String(searchByLyrics));
  input.placeholder = searchModePlaceholder();
  filters.hidden = searchByLyrics;
  input.focus();
  if (searchByLyrics && interfaceMotion()) {
    form.animate([
      { borderColor: 'rgba(255,255,255,.45)', boxShadow: '0 0 0 0 rgba(255,255,255,0)' },
      { borderColor: 'rgba(255,255,255,.92)', boxShadow: '0 0 0 3px rgba(255,255,255,.09), 0 0 12px rgba(255,255,255,.09)', offset: .42 },
      { borderColor: 'rgba(255,255,255,.48)', boxShadow: '0 0 0 1px rgba(255,255,255,.025)' },
    ], { duration: 910, easing: 'ease-in-out', id: 'lyrics-border-pulse' });
  } else {
    form.getAnimations().find(animation => animation.id === 'lyrics-border-pulse')?.cancel();
    syncTabPill(filters.querySelector<HTMLElement>('.tab-pill-group')!);
  }
  if (!searchQuery) drawSearchStart();
  else if (searchByLyrics) drawLyricsSearchPrompt();
  else void runSearch();
}

async function runSearch(): Promise<void> {
  const container = main.querySelector<HTMLElement>('#search-results');
  if (!container) return;
  container.inert = false;
  const query = (main.querySelector<HTMLInputElement>('#search-input')?.value ?? '').trim();
  const lyrics = searchByLyrics;
  clearTimeout(searchTimer);
  clearTimeout(searchHistoryTimer);
  searchQuery = query;
  searchRequest?.abort();
  searchResults = undefined;
  visibleTracks = [];
  if (!query) { drawSearchStart(); return; }
  if (lyrics && query.length < 2) {
    container.innerHTML = '<p class="muted">Введите хотя бы два символа.</p>';
    return;
  }
  container.innerHTML = lyrics ? '<p class="muted">Ищем песню по словам…</p>' : loading();
  const controller = new AbortController();
  searchRequest = controller;
  const gen = generation;
  try {
    let result: SearchResults;
    if (lyrics) {
      const { tracks } = await api.smartSearch(query, controller.signal);
      result = { tracks, artists: [], albums: [], total: tracks.length, source: 'lyrics' };
    } else {
      result = await api.search(query, searchFilter, 0, controller.signal);
    }
    if (gen !== generation || controller.signal.aborted) return;
    searchResults = result;
    visibleTracks = register(result.tracks);
    drawSearchResults();
    searchHistoryTimer = window.setTimeout(rememberCurrentSearch, 1500);
  } catch (error) {
    if (gen !== generation || controller.signal.aborted) return;
    container.innerHTML = errorState(error);
    hydrateSavedCredits(result.tracks.slice(0, 24));
    hydrateIcons(main);
  }
}
function drawSearchResults(): void {
  const data = searchResults; if (!data) return;
  const container = document.querySelector('#search-results')!;
  if (searchByLyrics && !data.tracks.length) {
    container.innerHTML = empty('Совпадений не нашлось', 'Попробуйте другую строку или добавьте имя исполнителя.', 'search');
  } else if (!data.tracks.length && !data.albums.length && !data.artists.length) {
    container.innerHTML = empty('Пока ничего не нашлось', 'Попробуйте другое название или имя исполнителя.', 'search');
  } else if (searchByLyrics) {
    container.innerHTML = sectionHeading('Треки') + rows(data.tracks);
  } else {
    container.innerHTML = `<p class="results-caption">Результаты по запросу «${e(searchQuery)}»</p>${data.artists.length ? `<section class="section artists-section">${sectionHeading('Исполнители')}<div class="artist-rail">${data.artists.slice(0, searchFilter === 'all' ? 4 : 12).map(artistCard).join('')}</div></section>` : ''}${data.tracks.length ? `<section class="section">${sectionHeading('Треки', '<span class="subtle-label">Каталог Deezer</span>')}${rows(data.tracks, searchFilter === 'all' ? 6 : 24)}</section>` : ''}${data.albums.length ? `<section class="section">${sectionHeading('Альбомы')}<div class="${searchFilter === 'all' ? 'card-rail' : 'card-grid'}">${data.albums.slice(0, searchFilter === 'all' ? 5 : 24).map(albumCard).join('')}</div></section>` : ''}<p class="page-footnote">Каталог Deezer · доступны первые ${data.tracks.length + data.artists.length + data.albums.length} результатов</p>`;
  }
  hydrateIcons(main);
}

let libraryFilter = 'all';
function libraryView(): void {
  hydrateSavedCredits([...library.likes,...library.history.slice(0,5),...library.playlists.flatMap(p=>p.tracks.slice(0,1))]);
  visibleTracks = library.likes;
  if (!main.querySelector("#library-results")) main.innerHTML = `<div class="page-heading"><div><span class="eyebrow">ТО, ЧТО БЛИЗКО</span><h1>Медиатека</h1></div><div class="heading-actions">${windowsDesktop?'<a class="secondary-button" href="#/downloads">Скачанное</a>':''}<a class="secondary-button library-settings" href="#/settings" aria-label="Настройки" title="Настройки">${icon('settings-2')}</a><button class="secondary-button" data-action="import" aria-label="Импорт коллекции">${icon('import')}<span>Импорт</span></button><button class="secondary-button" data-action="new-playlist" aria-label="Создать плейлист">${icon('plus')}<span>Плейлист</span></button></div></div><div class="filter-row"><div class="tab-pill-group" role="group" aria-label="Раздел медиатеки">${[['all','Всё'],['playlists','Плейлисты'],['likes','Мне нравится'],['artists','Исполнители']].map(([id,label])=>`<button class="chip ${libraryFilter === id ? 'selected' : ''}" data-action="library-filter" data-filter="${id}" aria-pressed="${libraryFilter === id}">${label}</button>`).join('')}</div><span class="local-library-note">В вашем аккаунте</span></div><div id="library-results"></div>`;
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
  main.innerHTML=`<div class="page-heading"><div><span class="eyebrow">ВАША МУЗЫКА</span><h1>История</h1></div>${library.history.length?'<div class="history-heading-actions"><button class="text-button" data-action="clear-listening-history">Очистить</button><button class="primary-button" data-action="play-list">'+icon('play')+'Слушать</button></div>':''}</div><p class="results-caption">Последние 100 разных песен</p>${library.history.length?rows(library.history,100):empty('Здесь пока тихо','Включите музыку — прослушанные песни появятся здесь.','music-2','<a class="primary-button" href="#/search">Найти музыку</a>')}`;
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
  main.innerHTML = `<div class="page-heading"><div><span class="eyebrow">ВАШЕ ПРОСТРАНСТВО</span><h1>Настройки</h1></div></div><div class="settings-content"><button class="profile-summary" data-action="account"><span class="profile-avatar" data-account-avatar>${accountAvatar()}</span><span><strong>${authUser?e(authUser.first_name||authUser.username||"Мой профиль"):"Мой профиль"}</strong><small>${authUser?"Telegram подключён":"Войти через Telegram"}</small></span>${icon('chevron-right')}</button><section class="settings-group"><h2>Оформление</h2><div class="setting-row"><div class="setting-label">${icon('palette')}<span>Тема</span></div><div class="segmented tab-pill-group" role="group" aria-label="Цветовая тема"><button data-action="theme" data-theme="dark" class="${library.settings.theme === 'dark' ? 'selected' : ''}" aria-pressed="${library.settings.theme === 'dark'}">Тёмная</button><button data-action="theme" data-theme="light" class="${library.settings.theme === 'light' ? 'selected' : ''}" aria-pressed="${library.settings.theme === 'light'}">Светлая</button></div></div><label class="setting-row"><span class="setting-label">${icon('waves')}<span><span id="animations-label">Анимации</span><small id="animations-description">Живая волна и анимация интерфейса</small></span></span><span class="spring-switch"><input id="animations" type="checkbox" role="switch" aria-labelledby="animations-label" aria-describedby="animations-description" ${library.settings.animations ? 'checked' : ''}><span class="spring-switch-thumb" aria-hidden="true"></span></span></label></section><section class="settings-group"><h2>Воспроизведение</h2><label class="setting-row crossfade-setting"><span class="setting-label"><span><span id="crossfade-label">Плавный переход</span><small id="crossfade-description">Новый трек начинает звучать перед концом предыдущего</small></span></span>${jellySlider(library.settings.crossfade)}</label></section><section class="settings-group"><h2>Тексты песен</h2><div class="setting-row"><span class="setting-label">${icon('mic-2')}Сервис перевода</span>${translationTrigger('translation-provider', 'Сервис перевода', translationLabels[library.settings.translation])}</div><div class="setting-row"><span class="setting-label">Язык перевода</span>${translationTrigger('translation-language', 'Язык перевода', languageName(library.settings.translationLanguage))}</div></section><section class="settings-group"><h2>Рекомендации</h2><div class="setting-row"><span class="setting-label">${icon('waves')}<span>Любимые исполнители<small>Помогите волне лучше узнать вас</small></span></span><button class="text-button" data-action="favorite-artists">Выбрать ${icon('chevron-right')}</button></div><div class="setting-row"><span class="setting-label">${icon('thumbs-down')}<span>Не рекомендовать</span></span><button class="text-button" data-action="blocked-tracks">Посмотреть список ${icon('chevron-right')}</button></div></section><section class="settings-group"><h2>Медиатека</h2><div class="setting-row"><span class="setting-label">${icon('library')}<span>Ваша коллекция<small>${library.likes.length} любимых · ${library.playlists.length} плейлистов</small></span></span><button class="text-button" data-action="export">Сохранить копию ${icon('download')}</button></div><div class="setting-row"><span class="setting-label">${icon('import')}<span>Перенос музыки</span></span><button class="text-button" data-action="import">Открыть ${icon('arrow-right')}</button></div></section>${desktopSettings()}<div class="settings-about">${icon('audio-lines')}<span><strong>YaMusic</strong><small>В вашем ритме · версия 0.1</small></span></div></div>`;
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
      const data=personalMixes??await getMixes();
      if(gen!==generation)return;
  const controller = new AbortController();
  detailRequest = controller;
      const mix=data.mixes.find(item=>item.id===(id||'daily'));
      if(!mix){main.innerHTML=empty('Подборка не найдена','','list-music');return;}
      visibleTracks=mix.tracks;
      const message=mix.id==='artist'||mix.id==='style'
        ? 'Послушайте музыку и отмечайте любимое, чтобы появилась подборка.'
        : 'Подборка ещё готовится.';
      document.querySelector('.topbar-title')!.textContent=mix.title;
      main.innerHTML=`<div class="collection-header"><div class="collection-art mood-art evening">${mix.tracks[0]?.cover_url?image(mix.tracks[0].cover_url):icon('audio-lines')}</div><div><h1>${e(mix.title)}</h1><p>${e(mix.description)} · ${trackCount(mix.tracks.length)}</p><button class="primary-button" data-action="play-list" ${mix.tracks.length?'':'disabled'}>${icon('play')}Слушать всё</button></div></div>${mix.tracks.length?rows(mix.tracks):`<p class="muted">${message}</p>`}`;
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
              ${downloadListButton()}<button class="secondary-button" data-action="rename-playlist" data-id="${e(p.id)}">Редактировать</button>
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
      const data = await api.album(Number(id), controller.signal); if (gen !== generation) return;
      visibleTracks = register(data.tracks);
      main.innerHTML = `<div class="collection-header"><div class="collection-art">${image(data.album.cover_url)}</div><div><span class="eyebrow">АЛЬБОМ</span><h1>${e(data.album.title)}</h1><button class="artist-link" data-action="artist" data-id="${data.album.artist_id}">${e(data.album.artist)} ${icon('arrow-up-right')}</button><p>${trackCount(data.tracks.length)} · Deezer</p><button class="primary-button" data-action="play-list" ${data.tracks.length ? '' : 'disabled'}>${icon('play')}Слушать</button></div></div>${rows(data.tracks)}`;
    } else {
      const data = await api.artist(Number(id), controller.signal); if (gen !== generation) return;
      refreshSearchArtist(authUser?.id, data.artist);
      visibleTracks = register(data.tracks);
      hydrateSavedCredits(data.tracks.slice(0, 30));
      main.innerHTML = `<div class="collection-header artist-header"><div class="collection-art">${image(data.artist.picture_url)}</div><div><span class="eyebrow">ИСПОЛНИТЕЛЬ</span><h1>${e(data.artist.name)}</h1><div class="collection-actions"><button class="primary-button" data-action="play-list" ${data.tracks.length ? '' : 'disabled'}>${icon('play')}Слушать</button><button class="secondary-button" data-action="artist-follow" data-id="${data.artist.id}" aria-pressed="false" disabled>Подписаться</button></div></div></div><section class="section">${sectionHeading('Треки')}${rows(data.tracks, 30)}</section><section class="section">${sectionHeading('Альбомы')}<div class="card-grid">${data.albums.map(albumCard).join('')}</div></section>`;
      const follow=main.querySelector<HTMLButtonElement>('[data-action="artist-follow"]')!;
      void authReady.then(()=>api.favoriteArtists()).then(({artists})=>{if(follow.isConnected)setFollowButton(follow,artists.some(a=>a.id===data.artist.id));}).catch(()=>{if(follow.isConnected)follow.disabled=false;});
    }
    if (gen === generation) hydrateIcons(main);
  } catch (error) { if (gen === generation) { main.innerHTML = errorState(error); hydrateIcons(main); } }
      if (data.more_tracks) {
        const section = follow.closest('.artist-header')?.nextElementSibling;
        if (section && !data.tracks.length) section.insertAdjacentHTML('beforeend', loading());
        void api.artist(Number(id), controller.signal, false).then(full => {
          if (gen !== generation || controller.signal.aborted || !(section instanceof HTMLElement) || !section.isConnected) return;
          visibleTracks = register(full.tracks);
          const play = main.querySelector<HTMLButtonElement>('[data-action="play-list"]');
          if (play) play.disabled = !full.tracks.length;
          section.innerHTML = sectionHeading('Треки') + rows(full.tracks, 30);
          hydrateIcons(section);
          updatePlayerControls();
        }).catch(() => {
          if (gen === generation && !controller.signal.aborted) section?.querySelector('.loading-state')?.remove();
        });
      } else hydrateSavedCredits(data.tracks);

}

function navigate(): void {
  if(!authUser)return;
  closeTranslationMenus?.(); closeTranslationMenus = undefined;
  closePlaylistMenu();closeSongActions();currentPlaylist=undefined;playlistSuggestions=[];
  if(currentView==='search'&&searchResults)rememberCurrentSearch();
  clearTimeout(searchHistoryTimer);
  generation++; detailRequest?.abort(); searchRequest?.abort(); clearTimeout(searchTimer); wave?.destroy(); wave = undefined;
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const page = parts[0] || 'home';
  currentView = page;
  updateBackButton(page);
  const navPage = ['album','artist','mood'].includes(page) ? 'search' : ['playlist','history','downloads'].includes(page) ? 'library' : page==='daily'?'home':page;
  document.querySelectorAll<HTMLElement>('[data-page]').forEach(link => {
    const selected = link.dataset.page === navPage;
    link.classList.toggle('selected', selected);
    if (selected) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
  syncTabPill(app.querySelector<HTMLElement>('.desktop-navigation')!, true);
  syncTabPill(mobileNav, true);
  document.querySelector('.topbar-title')!.textContent = ({home:'Для вас',search:'Поиск',library:'Медиатека',settings:'Настройки',album:'Альбом',artist:'Исполнитель',playlist:'Плейлист',mood:'Подборка',daily:'Подборка',history:'История',downloads:'Скачанное'} as Record<string,string>)[page] || 'YaMusic';
  main.className = `view-${page}`; main.scrollTop = 0; visibleTracks = [];
  if (page === 'home') home(); else if (page === 'search') search(); else if (page === 'library') libraryView(); else if (page === 'settings') settings();
  else if(page==='history')historyView();
  else if(page==='downloads'&&windowsDesktop)downloadsView();
  else if(page==='daily')void detail('daily',location.hash.split('/')[2]||'daily',generation);
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
function syncDeviceLabels(): void {
  const state=playbackDevices?.state;
  const active=state?.active;
  const activeName=active?(active===playbackDevices?.id?'здесь':state?.devices?.[active]?.label):undefined;
  const label=activeName?(state?.playback?.playing?`Играет: ${activeName}`:`На паузе: ${activeName}`):'Устройства';
  for(const control of document.querySelectorAll<HTMLElement>('[data-action="devices"]')){
    control.title=label;control.setAttribute('aria-label',label);
  }
  for(const status of document.querySelectorAll<HTMLElement>('[data-device-status]')){
    status.textContent=active?label:'';
    status.title=active?label:'';
  }
  if(dialog.open&&dialog.classList.contains('devices-dialog'))renderDeviceList();
}

function renderDeviceList(): void {
  const target=dialog.querySelector<HTMLElement>('[data-device-list]');
  if(!target)return;
  const state=playbackDevices?.state;
  const markup=state?Object.entries(state.devices).map(([id,device])=>{
    const selected=state.active===id;
    return `<button class="secondary-button device-option" data-action="transfer-device" data-id="${e(id)}" ${selected||!state.playback?'disabled':''}>${icon('monitor-speaker')}<span>${id===playbackDevices?.id?'Это устройство':e(device.label)}</span>${selected?'<small>Воспроизведение</small>':''}</button>`;
  }).join(''):'<p class="muted">Подключаемся…</p>';
  if(target.dataset.markup===markup)return;
  target.dataset.markup=markup;target.innerHTML=markup;hydrateIcons(target);
}

function renderPlayer(): void {
  const t = player.current;
  playerBar.classList.toggle('has-track', !!t);
  playerBar.innerHTML = `<div class="player-information"><button class="player-art" data-action="expand" ${t ? '' : 'disabled'} aria-label="Открыть плеер">${t ? image(t.cover_url, '', '', true) : icon('disc-3')}</button><div class="player-track-name">${t ? `<button class="player-name-link" data-action="expand"><span class="moving-title-text">${e(t.title)}</span></button><span class="mobile-track-artist">${e(trackArtists(t).map(a=>a.name).join(', '))}</span>${artistLinks(t, "player-artist-link")}<span class="mobile-device-status" data-device-status></span>` : '<strong>С чего начнём?</strong><span>Найдите музыку по настроению</span>'}</div><button class="icon-button like-button player-like" data-action="like-current" aria-label="В любимое" ${t ? '' : 'disabled'}>${icon('heart')}</button>${t ? button('add-playlist-menu','plus','Добавить в плейлист',`data-id="${e(t.id)}" aria-expanded="false" aria-controls="playlist-menu" data-player-add`) : ''}</div><div class="player-transport"><div class="transport-buttons"><button class="icon-button shuffle-button" data-action="shuffle" aria-label="Перемешать" aria-pressed="${player.shuffle}">${icon('shuffle')}</button>${button('previous','skip-back','Предыдущий трек')}<button class="transport-play" data-action="toggle" aria-label="Воспроизвести">${icon('play')}</button>${button('next','skip-forward','Следующий трек')}<button class="icon-button repeat-button" data-action="repeat" aria-label="Повтор выключен">${icon('repeat')}</button></div><div class="player-timeline"><span data-elapsed>0:00</span>${playerRange('seek', player.time, player.duration, !t)}<span data-duration>${formatTime(player.duration)}</span></div></div><div class="player-end"><span class="device-status" data-device-status></span>${volumeControl()}<div class="player-extras">${button('devices','monitor-speaker','Устройства')}${button('lyrics','mic-2','Текст песни')}${button('queue','list-music','Очередь','aria-controls="playback-queue" aria-expanded="false"')}</div></div><div class="mobile-player-actions">${!localDesktop?button('devices','monitor-speaker','Устройства'):''}<button class="icon-button" data-action="toggle" aria-label="Воспроизвести" data-mobile-play>${icon('play')}</button></div><div class="mobile-progress">${playerRange('seek', player.time, player.duration, !t)}</div>`;
  mountPlayerRanges(playerBar);
  if(playlistMenuTrigger&&!playlistMenuTrigger.isConnected)closePlaylistMenu();
  updatePlayerControls(); updateQueueButtons(); hydrateIcons(playerBar); updateProgress(); syncDeviceLabels();
}
function replaceIcon(el: HTMLElement | null, name: string): void {
  if (!el || el.dataset.glyph === name) return;
  el.dataset.glyph = name;
  el.innerHTML = icon(name);
  hydrateIcons(el);
}
function updatePlayerControls(): void {
  const t = player.current;
  const glyph = player.playing ? 'pause' : 'play';
  document.querySelectorAll<HTMLElement>('[data-playback-label]').forEach(el=>{
    const loading = player.mode === 'loading';
    const message = loading ? 'Находим аудио…' : player.mode === 'unavailable' ? 'Трек недоступен · попробуйте ещё раз' : '';
    el.parentElement!.classList.toggle('loading-audio', loading);
    if (el.textContent !== message) el.textContent = message;
  });
  document.querySelectorAll<HTMLElement>('.transport-play, [data-mobile-play], .full-play').forEach(el => {
    replaceIcon(el, glyph); el.setAttribute('aria-label', player.playing ? 'Пауза' : 'Воспроизвести');
    (el as HTMLButtonElement).disabled = !t;
  });
  document.querySelectorAll<HTMLButtonElement>('.shuffle-button').forEach(el=>{
    const inWave = Boolean(player.context);
    el.disabled = inWave;
    el.classList.toggle('active',player.shuffle && !inWave);
    el.setAttribute('aria-pressed',String(player.shuffle && !inWave));
    el.title = inWave ? 'Моя волна сама выбирает порядок треков' : 'Перемешать';
  });
  renderQueue();
  document.querySelectorAll<HTMLElement>('.repeat-button').forEach(el=> { el.classList.toggle('active',player.repeat !== 'off'); el.setAttribute('aria-pressed', String(player.repeat !== 'off')); el.setAttribute('aria-label', `Повтор: ${player.repeat === 'one' ? 'одна песня' : player.repeat === 'all' ? 'вся очередь' : 'выключен'}`); replaceIcon(el, player.repeat === 'one' ? 'repeat-1' : 'repeat'); });
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
  personalMixes=undefined;
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
  personalMixes=undefined;mixesPromise=undefined;discovery=[];discoveryPromise=undefined;disliked.clear();lastAnalyzedCount=0;
  player.context=undefined;recommendationUpdate=Promise.resolve();
  waveContinuation=undefined;failedWaveTracks.clear();
}
function openAccountLibrary(user: AuthUser): void {
  if(libraryUser===user.id&&librarySync)return;
  librarySync?.close();
  const legacy=restoreLibrary(localStorage.getItem(STORAGE_KEY));
  const legacySearch=restoreSearchHistory(localStorage.getItem(SEARCH_HISTORY_KEY));
  const local=localStorage.getItem(`${STORAGE_KEY}.${user.id}`);
  const deviceVolume=library.settings.volume;
  library=restoreLibrary(local);
  if(local===null)library.settings.volume=deviceVolume;
  searchHistory=restoreSearchHistory(localStorage.getItem(`${SEARCH_HISTORY_KEY}.${user.id}`));
  libraryUser=user.id;
  player.setVolume(library.settings.volume);
  player.setCrossfade(library.settings.crossfade);
  applySettings();
  const migratedKey='yamusic.library-legacy-account.v1';
  const migrationKey=`${migratedKey}.${user.id}`;
  const owner=localStorage.getItem(migratedKey);
  const canMigrate=(!owner||owner===String(user.id))&&localStorage.getItem(migrationKey)!=='done'&&localStorage.getItem(STORAGE_KEY)!==null;
  const sync=new LibrarySync(user.id,(snapshot,pending)=>{
    if(librarySync!==sync)return;
    const next=applyAccountLibrary(snapshot,library.settings.volume,pending);
    const before=JSON.stringify(library);
    const sameSearch=JSON.stringify(searchHistory)===JSON.stringify(next.searchHistory);
    const settingsChanged=JSON.stringify(library.settings)!==JSON.stringify(next.library.settings);
    disliked=new Set(snapshot.dislikes);
    library=next.library;
    searchHistory=next.searchHistory;
    sync.observe(library,searchHistory);
    if(canMigrate&&!pending.some(change=>change.import_legacy)) localStorage.setItem(migrationKey,'done');
    if(before===JSON.stringify(library)&&sameSearch)return;
    save();
    saveSearchHistory();
    register([...library.likes,...library.history,...library.playlists.flatMap(item=>item.tracks)]);
    if(settingsChanged){player.setCrossfade(library.settings.crossfade);applySettings();}
    updateLikes();
    if(currentView==='library')libraryView();
    else if(currentView==='history')historyView();
    else if(currentView==='settings'&&settingsChanged&&!dialog.open&&!main.contains(document.activeElement))settings();
    else if(currentView==='playlist'&&!dialog.open){
      const id=decodeURIComponent(location.hash.split('/')[2]||'');
      const nextPlaylist=library.playlists.find(item=>item.id===id);
      if(nextPlaylist) updatePlaylistContents(nextPlaylist);
      else void detail('playlist',id,generation);
    } else if(currentView==='home') drawRecent();
    else if(currentView==='search'&&!searchQuery&&!sameSearch) drawSearchStart();
  });
  librarySync=sync;
  if(canMigrate){
    localStorage.setItem(migratedKey,String(user.id));
    const receiptKey='yamusic.library-legacy-receipt.v1';
    const receipt=localStorage.getItem(receiptKey)||crypto.randomUUID();
    localStorage.setItem(receiptKey,receipt);
    library={...legacy,settings:{...legacy.settings,volume:library.settings.volume}};
    player.setCrossfade(library.settings.crossfade);
    applySettings();
    searchHistory=legacySearch;
    sync.seed(legacy,legacySearch,receipt);
  }
  sync.observe(library,searchHistory);
  sync.refresh();
}

function drawRecent(): void {
  const section=document.querySelector<HTMLElement>('#recent-section');
  if(!section)return;
  section.innerHTML=library.history.length?sectionHeading('Недавно слушали','<a class="text-button" href="#/history">Вся история '+icon('arrow-right')+'</a>')+rows(library.history,4):'';
  hydrateIcons(section);
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
    openAccountLibrary(authUser);
    playbackDevices??=new PlaybackDevices(player,syncDeviceLabels,updateProgress,toast);
    if(windowsDesktop&&!downloads){
      const account=authUser.id;
      void invokeDesktop('offline_set_account',{account}).then(()=>{if(authUser?.id===account)return openDownloads(account);}).catch(()=>{});
    }
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
  playbackDevices?.close();playbackDevices=undefined;
  downloads=undefined;
  librarySync?.close();librarySync=undefined;libraryUser=undefined;
  library=restoreLibrary(null);searchHistory=[];searchResults=undefined;searchQuery='';searchByLyrics=false;expandedSearchHistory.clear();
  clearTimeout(searchTimer);clearTimeout(searchHistoryTimer);
  if(dialog.open)dialog.close();
  closeQueue(); closePlaylistMenu(); closeSongActions();
  closeTranslationMenus?.(); closeTranslationMenus = undefined;
  wave?.destroy(); wave=undefined;
  generation++; searchRequest?.abort();
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
  showDialog('Мой профиль',`<div class="account-dialog"><div class="account-emblem">${authUser.avatar_url?image(authUser.avatar_url,name,'account-avatar',true):icon('circle-user-round')}</div><h3>${e(name)}</h3>${authUser.username?`<p class="account-username">@${e(authUser.username)}</p>`:''}<span class="account-connected">${icon('send')}Telegram подключён</span><dl class="account-details"><div><dt>Telegram ID</dt><dd>${e(String(authUser.telegram_id))}</dd></div></dl><p>Медиатека, история, настройки и воспроизведение привязаны к вашему профилю.</p><button class="secondary-button" data-action="auth-logout">Выйти из профиля</button></div>`,'account-profile-dialog');
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
    if(!player.mirroring)player.pause();
    await persistPlayback(true);
    await api.authLogout();
    if(windowsDesktop)await invokeDesktop('offline_set_account',{account:null}).catch(()=>{});
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
  if(authUser?.id!==user || player.current || playbackDevices?.state?.active)return;
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
  if(!track||!user||restoringPlayback||player.mirroring)return;
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
  await Promise.allSettled([wavePromise,mixesPromise]);
  waveQueue=undefined;personalMixes=undefined;
  if(player.context)void refreshWave();
  if(currentView==='home'){
    if(!player.context)void getWave().then(drawWaveQueue).catch(()=>{});
    void getMixes().then(drawMixes).catch(()=>{});
  }
}
let renderedQueue = '';
let queueTrigger: HTMLElement | undefined;

function closeQueue(restoreFocus = false): void {
  if (!queuePanel.matches(':popover-open')) return;
  queuePanel.hidePopover();
  updateQueueButtons();
  if (restoreFocus) (queueTrigger?.isConnected ? queueTrigger : playerBar.querySelector<HTMLElement>('[data-action="queue"]'))?.focus();
  queueTrigger = undefined;
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

function toggleQueue(trigger: HTMLElement): void {
  if (queuePanel.matches(':popover-open')) { closeQueue(); return; }
  closePlaylistMenu(); closeSongActions();
  (dialog.open ? dialog : app).append(queuePanel);
  queueTrigger = trigger;
  queuePanel.showPopover();
  renderQueue();
  updateQueueButtons();
  queuePanel.querySelector<HTMLButtonElement>('[data-action="close-queue"]')?.focus({preventScroll:true});
  queuePanel.dataset.side = 'above';
  animateDropdown(queuePanel, [...queuePanel.querySelectorAll<HTMLElement>('.compact-track')]);
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
  main.querySelector('[data-playlist-count]')!.textContent = trackCount(playlist.tracks.length);
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
    try { mix = (await getMixes()).mixes[0]?.tracks ?? []; }
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

function fullPlayer(lyrics = true): void {
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
    <div class="expanded-header">${button('devices','monitor-speaker','Устройства')}<span class="device-status" data-device-status></span>
      ${volumeControl()}
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
        <div class="lyrics-tabs">
          <button class="chip${lyrics ? ' selected' : ''}" data-action="lyrics-view" aria-pressed="${lyrics}" aria-controls="player-lyrics">Текст песни</button>
          <button class="chip" data-action="translation" aria-pressed="false" disabled ${lyrics ? '' : 'hidden'}>Перевод</button>
        </div>
        <p class="translation-status" role="status" hidden></p>
      </div>
      <section id="player-lyrics" class="lyrics-panel" aria-label="Текст песни" ${lyrics ? '' : 'hidden'}>
        <div class="lyrics-tools">
          <span class="follow-lyrics-control" tabindex="0"><button class="icon-button follow-lyrics" data-action="follow-lyrics" aria-label="Вернуться к текущей строке" aria-pressed="true" disabled>
            ${icon('locate-fixed')}
          </button><span class="lyrics-tooltip" aria-hidden="true">К текущей строке</span></span>
        </div>
        <div class="lyrics-scroll" tabindex="0" aria-label="Строки песни">${loading()}</div>
        <div class="lyrics-footer"><span class="lyrics-credit">Тексты · LRCLIB</span><span class="lyrics-credit" data-lyrics-sync hidden>Текст без синхронизации</span></div>
      </section>
    </div>
    <div class="expanded-audio-status"><span class="audio-spinner" aria-hidden="true"></span><span role="status" data-playback-label></span></div>`;
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
  stopLyricsScroll(container);
  container.innerHTML=loading(); lyricLines=[]; plainLyricLines=[]; activeLyric=-1;
  try {
    const cached=downloads?.entries[t.id]?.lyrics;
    if(localDesktop&&!cached)throw new Error('Текст этой песни не скачан.');
    const data=cached??await retryLyrics(() => api.lyrics(t.id,controller.signal),controller.signal);
    if(controller.signal.aborted || player.current?.id!==t.id || !dialog.open || !container.isConnected) return;
    lyricLines=data.instrumental?[]:parseLrc(data.synced_lrc||'');
    if(!lyricLines.length&&!data.instrumental&&data.plain_lyrics)plainLyricLines=data.plain_lyrics.split(/\r?\n/).map(line=>line.trim());
    const isPlain=plainLyricLines.some(Boolean);
    dialog.querySelector<HTMLElement>('[data-lyrics-sync]')!.hidden=!isPlain;
    const followControl=dialog.querySelector<HTMLElement>('.follow-lyrics-control')!;
    followControl.querySelector('.lyrics-tooltip')!.textContent=isPlain?'Текст без синхронизации':'К текущей строке';
    if(isPlain)followControl.setAttribute('aria-label','Текст без синхронизации');
    if(data.instrumental) container.innerHTML=empty('Только музыка','У этой композиции нет слов.','audio-lines');
    else if(lyricLines.length) container.innerHTML=lyricLines.map((line,i)=>`<button class="lyric-line" data-action="seek-lyric" data-time="${line.time}" data-line="${i}" aria-label="${e(line.text)}, ${formatTime(line.time)}"><span class="lyric-text">${e(line.text)}</span></button>`).join('');
    else if(isPlain) container.innerHTML=`<div class="plain-lyrics">${plainLyricLines.map((line,i)=>`<p data-plain-line="${i}">${e(line)||'&nbsp;'}</p>`).join('')}</div>`;
    else container.innerHTML=empty('Текст пока не найден','В LRCLIB пока нет текста именно этой версии песни.','mic-2');
    const translate=dialog.querySelector<HTMLButtonElement>('[data-action="translation"]');
    if(translate)translate.disabled=localDesktop||(!lyricLines.length&&!isPlain);
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
    if (interfaceMotion()) translation.animate([{ opacity: 0, translate: '0 5px' }, { opacity: 0.78, translate: '0 0' }], { duration: 260, easing: 'ease-out' });
    if(line.dataset.line!==undefined)line.setAttribute('aria-label',`${original}; ${translation.textContent}, ${formatTime(lyricLines[index].time)}`);
  });
  if(!translationVisible) dialog.querySelectorAll<HTMLElement>('[data-line]').forEach(line=>{
    const original=lyricLines[Number(line.dataset.line)];
    line.setAttribute('aria-label',`${original.text}, ${formatTime(original.time)}`);
  });
  activeLyric=-1;updateLyrics(false);
}
function setLyricsFollowing(enabled: boolean): void {
  followLyrics = enabled;
  const scroll = dialog.querySelector<HTMLElement>('.lyrics-scroll');
  if (!enabled && scroll) stopLyricsScroll(scroll);
  dialog.querySelector('.follow-lyrics')?.setAttribute('aria-pressed', String(enabled));
}

function toggleLyricsView(button: HTMLElement): void {
  const deck = dialog.querySelector<HTMLElement>('.expanded-deck')!;
  const panel = dialog.querySelector<HTMLElement>('.lyrics-panel')!;
  const previous = deck.getBoundingClientRect();
  deck.getAnimations().forEach(animation => animation.cancel());
  const shown = dialog.classList.toggle('show-lyrics');
  button.setAttribute('aria-pressed', String(shown));
  button.classList.toggle('selected', shown);
  panel.hidden = !shown;
  dialog.querySelector<HTMLButtonElement>('[data-action="translation"]')!.hidden = !shown;
  animateDeck(deck, previous);
  setLyricsFollowing(shown);
  if (shown) {
    activeLyric = -1;
    updateLyrics(false);
    if (interfaceMotion()) panel.animate([{ opacity: 0, translate: '0 8px' }, { opacity: 1, translate: '0 0' }], { duration: 300, easing: 'ease-out' });
  }
}

function updateLyrics(animate = true): void {
  if(!dialog.open || !dialog.classList.contains('show-lyrics')) return;
  const synchronized=player.mode==='full' && lyricLines.length>0;
  const follow=dialog.querySelector<HTMLButtonElement>('.follow-lyrics');
  if(follow) follow.disabled=!synchronized;
  if(!lyricLines.length) return;
  dialog.querySelectorAll<HTMLButtonElement>('.lyric-line').forEach(line=>{line.disabled=!synchronized;});
  const index=synchronized?activeLine(lyricLines,player.time):-1;
  if(index===activeLyric) return;
  const previous = activeLyric;
  activeLyric=index;
  dialog.querySelectorAll<HTMLElement>('[data-line]').forEach(line=>{
    const position = Number(line.dataset.line);
    const active = position === index;
    line.classList.toggle('active-line', active);
    line.classList.toggle('past-line', position < index);
    line.classList.toggle('next-line', position === index + 1);
    if(active) line.setAttribute('aria-current','true'); else line.removeAttribute('aria-current');
  });
  const current=dialog.querySelector<HTMLElement>(`[data-line="${index}"]`), scroll=dialog.querySelector<HTMLElement>('.lyrics-scroll');
  if (current && animate && index === previous + 1 && previous >= 0) {
    const departing = scroll?.querySelector<HTMLElement>(`[data-line="${previous}"]`);
    if (departing) animateLyricEcho(departing);
  }
  if(current && scroll && scroll.clientHeight>0 && followLyrics) {
    scrollToLyric(scroll, current);
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
    personalMixes=undefined;waveQueue=undefined;
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
      <button data-action="like" data-id="${e(id)}">${icon('heart')}${library.likes.some(track=>track.id===id)?'Убрать из любимого':'В любимое'}</button>${windowsDesktop&&!localDesktop?`<button data-action="download-track" data-id="${e(id)}">${icon('download')}Скачать</button>`:''}
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
  rememberOpenedResult(target);
  if (target.matches('.transport-buttons button, .hero-controls button, [data-mobile-play], .player-extras button, .expanded-actions button, .mute-button')) {
    const controls = target.closest('.player-bar, .full-player-dialog');
    queueMicrotask(() => {
      const button = target.isConnected ? target : controls?.querySelector<HTMLElement>(`button[data-action="${action}"]`);
      if (button) animatePlayerButton(button);
    });
  }
  const fromSongActions=songActions.contains(target), menuAnchor=songActionsTrigger;
  if(fromSongActions)closeSongActions(action !== 'add-playlist-menu');
  const closeForNavigation = () => { if (dialog.open) dialog.close(); };
  if (action === 'play') {
    const track = tracks.get(id); if (track) player.play(track, visibleTracks.length ? visibleTracks : [track]);
  } else if (action === 'play-queued') {
    player.playQueued(Number(target.dataset.index));
  } else if (action === 'preview-playlist-candidate') {
    const track = tracks.get(id);
    if (track) player.play(track);
  } else if(action==='play-wave-track'){
    const data=await getWave(),track=tracks.get(id);if(track)player.play(track,data.tracks,data.session_id);
  } else if(action==='download-track'){
    const track=tracks.get(id);
    if(track)void queueDownloads([track],target);
  } else if(action==='download-list'){
    const mix=currentView==='daily'?personalMixes?.mixes.find(mix=>mix.id===(location.hash.split('/')[2]||'daily')):undefined;
    const playlist=currentView==='playlist'?currentPlaylist:mix?{id:`mix-${mix.id}`,title:mix.title}:undefined;
    void queueDownloads(visibleTracks,target,playlist);
  } else if(action==='downloads-folder'){
    void downloads?.chooseFolder().then(()=>{if(currentView==='downloads')downloadsView();else if(currentView==='settings')settings();}).catch(error=>toast(String(error)));
  } else if(action==='remove-download'){
    void downloads?.remove(id).then(()=>{if(currentView==='downloads')downloadsView();}).catch(error=>toast(String(error)));
  } else if(action==='open-offline'){
    void invokeDesktop('open_offline').catch(error=>toast(String(error)));
  } else if(action==='install-update'){
    void persistPlayback(true).finally(()=>invokeDesktop('install_update')).catch(error=>toast(String(error)));
  } else if(action==='dismiss-update'){
    target.closest('.desktop-update')?.remove();
  } else if (action === 'devices') {
    showDialog('Устройства', '<div class="device-list" data-device-list></div>', 'devices-dialog');renderDeviceList();
  } else if (action === 'transfer-device') {
    playbackDevices?.transfer(id);dialog.close();
  } else if (action === 'toggle') { if (player.current) player.toggle(); else toast('Выберите песню в каталоге'); }
  else if (action === 'wave') {
    if(action==='wave'&&player.context&&player.current)player.toggle();
    else{target.setAttribute('disabled','');try{failedWaveTracks.clear();const data=await getWave();if(data.tracks[0])player.play(data.tracks[0],data.tracks,data.session_id);else toast('Сначала найдите и отметьте любимую музыку');}catch(error){toast(error instanceof Error?error.message:'Рекомендации недоступны');}finally{target.removeAttribute('disabled');}}
  } else if (action === 'next') player.next();
  else if (action === 'previous') player.previous();
  else if (action === 'shuffle') {
    player.toggleShuffle();api.prepare(player.queue.slice(player.index+1,player.index+6),true);
    savePlaybackModes();
  }
  else if (action === 'repeat') { player.toggleRepeat(); savePlaybackModes(); }
  else if (action === 'mute') { if (player.volume > 0) { lastVolume = player.volume; player.setVolume(0); } else player.setVolume(lastVolume); if(!player.mirroring){library.settings.volume = player.volume;save();} }
  else if (action === 'like' || action === 'like-current') like(action === 'like' ? tracks.get(id) : player.current);
  else if(action==='dislike'){
    const track=tracks.get(id);if(track){
      const undo=disliked.has(id);if(undo)disliked.delete(id);else disliked.add(id);
      await api.react({track_id:id,action:undo?'undislike':'dislike',session_id:player.context});
      if(!player.context)waveQueue=undefined;
      if(personalMixes){if(undo)personalMixes=undefined;else for(const mix of personalMixes.mixes)mix.tracks=mix.tracks.filter(track=>track.id!==id);}
      if (!fromSongActions) dialog.close();
      toast(undo?'Песня снова может появляться в рекомендациях':'Больше не будем рекомендовать эту песню');
      if(!undo&&player.current?.id===id)player.next(false,false);else if(player.context)refreshWave();
      if(!undo){const current=player.current;player.queue=player.queue.filter(t=>t.id!==id||t===current);player.index=current?player.queue.indexOf(current):-1;}
      if(currentView==='daily')void detail('daily',location.hash.split('/')[2]||'daily',generation);else if(currentView==='home')drawMixes();
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
  else if (action === 'clear-search-history') {
    searchHistory = []; saveSearchHistory(); drawSearchStart();
    main.querySelector<HTMLInputElement>('#search-input')?.focus({ preventScroll: true });
  }
  else if (action === 'remove-search-history') {
    const index = Number(target.dataset.index);
    searchHistory.splice(index, 1); saveSearchHistory(); drawSearchStart();
    (main.querySelector<HTMLElement>(`[data-action="remove-search-history"][data-index="${Math.min(index, searchHistory.length - 1)}"]`)
      ?? main.querySelector<HTMLInputElement>('#search-input'))?.focus({ preventScroll: true });
  }
  else if(action==='clear-listening-history'){showDialog('Очистить историю?', '<p class="dialog-description">Список прослушиваний исчезнет с этого устройства. Любимое и плейлисты сохранятся.</p><div class="dialog-actions"><button class="secondary-button" data-action="close">Отмена</button><button class="primary-button" data-action="confirm-clear-history">Очистить</button></div>');}
  else if(action==='confirm-clear-history'){library.history=[];librarySync?.clearHistory();save();dialog.close();historyView();}
  else if (action === 'choose-playlist-cover') dialog.querySelector<HTMLInputElement>('#playlist-cover-file')?.click();
  else if (action === 'clear-playlist-cover') {
    playlistCoverDraft = '';
    const form = target.closest<HTMLFormElement>('#playlist-form');
    if (form) { form.querySelector<HTMLInputElement>('#playlist-cover-file')!.value = ''; updatePlaylistCoverPreview(form); }
  }
  else if (action === 'queue') toggleQueue(target);
  else if (action === 'close-queue') closeQueue(true);
  else if(action==='blocked-tracks'){try{const data=await api.recommendationStatus();disliked=new Set(data.dislikes);const list=data.blocked_tracks;register(list);showDialog('Не рекомендовать',list.length?`<div class="action-list">${list.map(t=>`<button data-action="dislike" data-id="${e(t.id)}">${icon('plus')}<span>${e(t.title)}<small style="display:block;color:var(--muted)">${e(t.artist)} · Снова рекомендовать</small></span></button>`).join('')}</div>`:empty('В списке пока пусто','Нажмите «Не нравится» в меню песни, чтобы убрать её из рекомендаций.','thumbs-down'));}catch(error){toast(error instanceof Error?error.message:'Не удалось открыть список');}}
  else if (action === 'expand' || action === 'lyrics') fullPlayer();
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
  else if (action === 'lyrics-view') toggleLyricsView(target);
  else if (action === 'seek-lyric') { if(player.mode === 'full') { setLyricsFollowing(true); activeLyric=-1; player.seek(Number(target.dataset.time)); } }
  else if (action === 'follow-lyrics') { setLyricsFollowing(true); activeLyric=-1; updateLyrics(); }
  else if (action === 'retry-lyrics') void loadLyrics();
  else if (action === 'track-menu') trackMenu(target,id);
  else if (action === 'play-list' || action === 'play-likes') { const list = action === 'play-likes' ? library.likes : visibleTracks; if (list[0]) player.play(list[0],list); }
  else if (action === 'search-by-lyrics') toggleSearchByLyrics();
  else if (action === 'search-history-expand') toggleSearchHistory(target);
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
document.addEventListener('submit', event => {
  const form = event.target as HTMLFormElement;
  if (form.id === 'search-form') { event.preventDefault(); clearTimeout(searchTimer); void runSearch(); }
  else if (form.id === 'music-import-form') { event.preventDefault();void previewImport(form); }
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
  else if (input.matches('[data-volume]')) { player.setVolume(Number(input.value)); if(!player.mirroring){library.settings.volume = player.volume;save();} fillRange(input); showCurrentVolume(input); }
  else if (input.matches('[data-seek]')) { player.seek(Number(input.value)); fillRange(input); }
  else if (input.id === 'search-input') {
    clearTimeout(searchTimer); clearTimeout(searchHistoryTimer); searchRequest?.abort();
    if (searchResults && searchQuery !== input.value.trim()) rememberCurrentSearch();
    searchQuery = input.value.trim(); searchResults = undefined; visibleTracks = [];
    if (!searchQuery || searchByLyrics) {
      if (searchQuery) drawLyricsSearchPrompt(); else drawSearchStart();
    } else {
      const results = main.querySelector<HTMLElement>('#search-results')!;
      results.inert = true;
      searchTimer = window.setTimeout(() => void runSearch(), 260);
    }
  }
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
    lyricsRequest?.abort(); translationRequest?.abort(); importRequest?.abort();
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
function adjustVolume(direction: number, input?: HTMLInputElement | null): void {
  player.setVolume(Math.round((player.volume+direction*.05)*100)/100);
  if (!player.mirroring) {
    library.settings.volume=player.volume;
    save();
  }
  showCurrentVolume(input);
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
  if(!player.current||(event.target as Element).closest('button,a,input,.player-range'))return;
  fullPlayer();
});
document.addEventListener('wheel',event=>{
  const input = (event.target as HTMLElement).closest('.volume-group')?.querySelector<HTMLInputElement>('[data-volume]');
  if(event.ctrlKey||!event.deltaY||!input)return;
  event.preventDefault();adjustVolume(event.deltaY<0?1:-1,input);
},{passive:false});
document.addEventListener('keydown', event => {
  const target=event.target as HTMLElement;
  if ((!authUser && !localDesktop) || event.ctrlKey || event.metaKey || event.altKey || (dialog.open&&!dialog.classList.contains('full-player-dialog'))) return;
  if (target.closest('input,textarea,select,[contenteditable]')) {
    if (target instanceof HTMLInputElement && target.matches('[data-volume]') && (event.key==='ArrowUp'||event.key==='ArrowDown')) {
      event.preventDefault();adjustVolume(event.key==='ArrowUp'?1:-1,target);
    }
    return;
  }
  if (!target.closest('button,a') && (event.code === 'Space' || event.key.toLowerCase() === 'k')) { event.preventDefault(); player.toggle(); }
  if (event.key === 'ArrowRight') { event.preventDefault(); if(!event.repeat)player.next(); }
  if (event.key === 'ArrowLeft') { event.preventDefault(); if(!event.repeat)player.previous(false); }
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    const input = (dialog.open ? dialog : playerBar).querySelector<HTMLInputElement>('[data-volume]');
    event.preventDefault();adjustVolume(event.key === 'ArrowUp' ? 1 : -1,input);
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
  if(player.playing&&!player.mirroring)void persistPlayback();
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
  if (!localDesktop) hydrateSavedCredits([track]);
  if(!restoringPlayback)void persistPlayback(true,player.mode==='full'?player.time:0);
  api.prepare(player.queue.slice(player.index+(restoringPlayback?0:1),player.index+6),true);
  if(player.context&&!restoringPlayback)refreshWave();
  if(dialog.open && dialog.classList.contains('full-player-dialog')) fullPlayer(dialog.classList.contains('show-lyrics'));
});
let historyTrackId='';
player.addEventListener('playing',()=>{
  const track=player.current;
  if(player.mirroring||!track||historyTrackId===track.id)return;
  historyTrackId=track.id;
  library.history=uniqueTracks([track,...library.history]).slice(0,100);
  librarySync?.heard(track);
  save();
  if(currentView==='history')historyView();
  else if(currentView==='home')drawRecent();
});
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
window.addEventListener('hashchange',()=>{if(localDesktop)downloadsView();else navigate();});
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
mountSidebar(app.querySelector<HTMLElement>('.sidebar')!);
mountPillGroups();
renderPlayer();
if(localDesktop){
  shell.hidden=false;loginScreen.hidden=true;
  document.body.classList.add('offline-desktop');
  void invokeDesktop<number|null>('offline_account').then(async account=>{
    if(account!==null)await openDownloads(account);
    downloadsView();
  }).catch(error=>toast(String(error)));
}else{
  if(windowsDesktop){
    window.addEventListener('yamusic-update',showUpdateNotification);
    window.addEventListener('offline',()=>{ if(downloads) void invokeDesktop('open_offline').catch(()=>{}); });
    void invokeDesktop('desktop_ready').then(showUpdateNotification).catch(()=>{});
  }
  startSession();
}

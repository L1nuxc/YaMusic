import type { Track } from './types.ts';
import { nextIndex, trackArtists } from './model.ts';
import { ListeningProgress } from './listening.ts';
import { coverPalette, neutralPalette } from './palette.ts';

export interface VisualAudio {
  bass: number;
  mids: number;
  highs: number;
  pulse: number;
  pace: number;
}

const FULL_BUFFER_AFTER = 30;

const silence: VisualAudio = { bass: 0, mids: 0, highs: 0, pulse: 0, pace: 0 };

export interface LivePlayback {
  track: Track;
  queue: Track[];
  context?: string;
  position: number;
  playing: boolean;
  volume: number;
  shuffle: boolean;
  repeat: 'off' | 'all' | 'one';
}

export class Player extends EventTarget {
  audio = new Audio();
  private spare?: HTMLAudioElement;
  private fadeSeconds = 0;
  private masterVolume: number;
  private mixer?: GainNode;
  private audioGains = new WeakMap<HTMLAudioElement, GainNode>();
  private prepared?: { audio: HTMLAudioElement; trackId: string; starting: boolean; failed: boolean };
  private fade?: { start: number; duration: number };
  private fadeFrame = 0;
  get volume(): number { return this.remote?.volume ?? this.masterVolume; }
  get mirroring(): boolean { return this.remote !== undefined; }
  private remote?: LivePlayback & { sampledAt: number };
  remoteControl?: (action: string, value?: number) => void;
  offlineSource?: (trackId: string) => string | undefined;
  queue: Track[] = [];
  index = -1;
  playing = false;
  loading = false;
  mode: 'full'|'loading'|'unavailable' = 'full';
  palette = neutralPalette;
  shuffle = false;
  repeat: 'off' | 'all' | 'one' = 'off';
  context?:string;
  private originalOrder: Track[] = [];
  private listening=new ListeningProgress();
  private completed=false;
  private finished=false;
  private retryCount = 0;
  private retryTime = 0;
  private restoredPosition: number | undefined;
  private sequence = 0;
  private streamBuffers = new WeakMap<HTMLAudioElement, { id: string; token: string; continued: boolean }>();
  private pendingSeek?: number;
  private seekingTo?: number;
  private seekDownload?: AbortController;
  private seekObjectUrl?: string;
  get seekPosition(): number { return this.pendingSeek ?? this.time; }
  get seekingForPlayback(): boolean { return this.pendingSeek !== undefined; }
  private audioContext?: AudioContext;
  private analyser?: AnalyserNode;
  private frequencies?: Uint8Array<ArrayBuffer>;
  private rhythmBaseline = 0;
  private lastBeat = 0;
  private beatInterval = 0;
  private connectingAudio = false;
  private errorSequence = -1;
  get current(): Track | undefined { return this.queue[this.index]; }
  get duration(): number { return this.current?.duration_sec || (!this.remote && Number.isFinite(this.audio.duration) ? this.audio.duration : 0); }
  get time(): number {
    if(this.remote){
      const elapsed=this.remote.playing?(performance.now()-this.remote.sampledAt)/1000:0;
      return Math.min(this.duration,this.remote.position+elapsed);
    }
    return this.restoredPosition ?? (this.retryTime || this.audio.currentTime || 0);
  }

  constructor(volume: number) {
    super();
    this.masterVolume = volume;
    this.bindAudio(this.audio);
    this.audio.preload = 'metadata';
    this.applyVolumes();
    if ('mediaSession' in navigator) {
      const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
        ['play', () => this.resume()], ['pause', () => this.pause()],
        ['previoustrack', () => this.previous()], ['nexttrack', () => this.next()],
        ['seekto', d => this.seek(d.seekTime ?? 0)],
        ['seekbackward', d => this.seek(this.time - (d.seekOffset ?? 5))],
        ['seekforward', d => this.seek(this.time + (d.seekOffset ?? 5))],
      ];
      for (const [action, handler] of handlers) {
        try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* Unsupported action. */ }
      }
    }
  }

  private bindAudio(audio: HTMLAudioElement): void {
    const on = (event: string, handler: () => void) => audio.addEventListener(event, () => {
      if (this.audio === audio) handler();
    });
    on('playing', () => {
      this.mode = 'full'; this.playing = true; this.loading = false;
      this.change(); this.mediaState(); this.dispatchEvent(new Event('playing'));
    });
    on('pause', () => {
      if (audio.ended || this.remote) return;
      this.cancelCrossfade();
      this.playing = false; this.change(); this.mediaState(); this.dispatchEvent(new Event('pause'));
    });
    on('waiting', () => { this.loading = true; this.change(); });
    on('loadedmetadata', () => {
      if (this.retryTime > 0) {
        this.pendingSeek = this.retryTime;
        this.retryTime = 0;
      }
      this.applyPendingSeek();
      this.tick();
    });
    on('durationchange', () => this.applyPendingSeek());
    on('progress', () => this.dispatchEvent(new Event('bufferprogress')));
    on('timeupdate', () => { this.tick(); this.updateCrossfade(); });
    on('seeking', () => { this.cancelCrossfade(); this.listening.anchor(this.time,performance.now()); });
    on('seeked', () => {
      const target = this.seekingTo;
      this.seekingTo = undefined;
      if (target !== undefined && this.pendingSeek === target) {
        if (Math.abs(audio.currentTime - target) > 0.5 && !this.seekObjectUrl) {
          this.downloadForSeek();
          return;
        }
        this.pendingSeek = undefined;
        this.change();
        this.tick();
      }
      this.listening.anchor(this.time,performance.now());
      this.dispatchEvent(new Event('seeked'));
    });
    on('ended', () => { if (!this.seekDownload && !this.commitCrossfade()) this.next(true); });
    on('error', () => {
      this.cancelCrossfade();
      // Signed CDN links can be revoked before their advertised expiry. Renew
      // once, retaining position; never leave the player in a retry loop.
      if (this.seekDownload) return;
      const established = this.audio.readyState >= 1 || this.time > 0 || this.mode === 'full';
      if (this.current && established && this.retryCount++ === 0) {
        const resume = !this.audio.paused || this.loading || this.playing;
        this.retryTime = this.seekPosition;
        this.clearSeek();
        this.loading = resume; this.playing = false;
        this.audio.src = this.streamUrl(this.current.id, this.audio, true, this.retryTime > 0);
        this.change();
        if (resume) this.resume();
        return;
      }
      this.unavailable('Полная версия сейчас недоступна. Нажмите воспроизведение, чтобы попробовать ещё раз.');
    });
    audio.addEventListener('waiting', () => {
      if(this.prepared?.audio===audio&&this.fade)this.cancelCrossfade();
    });
    audio.addEventListener('error', () => {
      if (this.prepared?.audio !== audio) return;
      this.prepared.failed = true;
      this.fade = undefined;
      audio.pause();
      this.applyVolumes();
    });
  }
  play(track: Track, tracks: Track[] = [track], context?:string): void {
    if(this.remote){this.remoteControl?.('local_play');return;}
    this.finish(false);this.context=context;
    const candidates = tracks.some(t => t.id === track.id) ? tracks : [track, ...tracks];
    const queue = candidates;
    const index = queue.findIndex(t => t.id === track.id);
    if (index < 0) {
      this.dispatchEvent(new CustomEvent('playererror', { detail: 'Песня отсутствует в очереди.' })); return;
    }
    this.originalOrder = [...queue];
    this.queue = [...queue]; this.index = index;
    if (!this.context && this.shuffle) {
      this.queue = [queue[index], ...queue.filter((_,position)=>position !== index)];
      this.index = 0;
      this.shuffleAhead();
    }
    this.load();
  }
  restore(track: Track, queue: Track[], position: number, context?: string): void {
    this.context=context;
    this.queue=queue.some(item=>item.id===track.id)?[...queue]:[track,...queue];
    this.originalOrder=[...this.queue];
    this.index=this.queue.findIndex(item=>item.id===track.id);
    this.load(false,position);
  }
  reset(): void {
    this.remote=undefined;
    this.clearSeek();
    this.cancelCrossfade();
    this.sequence++;
    this.queue=[];this.originalOrder=[];this.index=-1;this.context=undefined;
    this.retryTime=0;this.pendingSeek=undefined;this.restoredPosition=undefined;this.playing=false;this.loading=false;this.mode='full';
    this.audio.pause();this.audio.removeAttribute('src');this.audio.load();this.change();
  }
  private load(autoplay = true, position = 0): void {
    const track = this.current; if (!track) return;
    this.clearSeek();
    this.cancelCrossfade();
    this.sequence++;
    this.mode='loading';
    this.audio.pause();
    this.loading=autoplay;
    this.mode=autoplay?'loading':'full';
    this.retryCount = 0; this.retryTime = 0; this.pendingSeek = undefined;
    this.restoredPosition = autoplay ? undefined : position;
    if(autoplay)this.audio.src = this.streamUrl(track.id);
    else if(this.audio.getAttribute('src')){this.audio.removeAttribute('src');this.audio.load();}
    this.announceTrack(track);
    if(autoplay)this.resume();
  }
  private announceTrack(track: Track): void {
    this.rhythmBaseline = 0; this.lastBeat = 0; this.beatInterval = 0;
    this.listening.reset(this.time,performance.now());this.completed=false;this.finished=false;
    const sequence=this.sequence;
    void coverPalette(track.cover_url).then(palette => {
      if (sequence !== this.sequence) return;
      this.palette = palette;
      document.documentElement.style.setProperty('--cover-color', `rgb(${palette.primary.join(' ')})`);
      this.dispatchEvent(new Event('palettechange'));
    });
    if ('mediaSession' in navigator && 'MediaMetadata' in window) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: track.title, artist: trackArtists(track).map(a=>a.name).join(', '), album: track.album, artwork: track.cover_url ? [{ src: track.cover_url, sizes: '500x500', type: 'image/jpeg' }] : [] });
    }
    this.dispatchEvent(new CustomEvent('trackchange', { detail: track })); this.change();
  }
  resume(): void {
    if(this.remote){if(!this.remote.playing)this.remoteControl?.('toggle');return;}
    if(this.restoredPosition!==undefined && this.current){
      this.retryTime=this.restoredPosition;this.restoredPosition=undefined;
      this.loading=true;this.mode='loading';
      this.audio.src=this.streamUrl(this.current.id, this.audio, false, this.retryTime > 0);
      this.change();
    }
    if (this.mode === 'unavailable') { this.load(); return; }
    this.connectVisualAudio();
    const attempt = this.sequence;
    const source = this.audio.src;
    void this.audio.play().catch((error: DOMException) => {
      if (attempt !== this.sequence || source !== this.audio.src || error.name === 'AbortError') return;
      this.loading = false; this.playing = false; this.change();
      if (error.name === 'NotAllowedError') this.dispatchEvent(new CustomEvent('playererror', { detail: 'Нажмите воспроизведение ещё раз, чтобы браузер разрешил звук.' }));
    });
  }
  private unavailable(message: string): void {
    this.loading = false; this.playing = false; this.mode = 'unavailable'; this.change(); this.mediaState();
    if (this.errorSequence === this.sequence) return;
    this.errorSequence = this.sequence;
    this.dispatchEvent(new CustomEvent('playererror', { detail: message }));
  }
  /** Audio is only rerouted after the browser has allowed the context to run. */
  private connectVisualAudio(): void {
    if (this.offlineSource?.(this.current?.id??'') || this.connectingAudio || typeof AudioContext === 'undefined') return;
    this.connectingAudio = true;
    try {
      const context = this.audioContext ??= new AudioContext();
      void context.resume().then(() => {
        if (context.state !== 'running' || this.analyser) return;
        const analyser = context.createAnalyser(); analyser.fftSize = 1024; analyser.smoothingTimeConstant = .48;
        this.mixer = context.createGain();
        this.mixer.connect(analyser);
        analyser.connect(context.destination);
        this.analyser = analyser; this.frequencies = new Uint8Array(analyser.frequencyBinCount);
        this.attachAudio(this.audio);
        if(this.spare)this.attachAudio(this.spare);
        this.applyVolumes();
      }).catch(() => { /* Browsers may deny Web Audio; regular media playback stays available. */ })
        .finally(() => { this.connectingAudio = false; });
    } catch { this.connectingAudio = false; }
  }
  visualAudio(): VisualAudio {
    if (!this.playing || !this.analyser || !this.frequencies || this.audioContext?.state !== 'running') return silence;
    this.analyser.getByteFrequencyData(this.frequencies);
    const binHz = this.audioContext.sampleRate / this.analyser.fftSize;
    const bassEnd = Math.max(3, Math.round(210 / binHz));
    const midEnd = Math.min(this.frequencies.length, Math.round(2200 / binHz));
    const highEnd = Math.min(this.frequencies.length, Math.round(9500 / binHz));
    const meanLevel = (start: number, end: number): number => {
      if (end <= start) return 0;
      let sum = 0;
      for (let i = start; i < end; i++) sum += this.frequencies![i];
      return Math.pow(sum / ((end - start) * 255), 1.3);
    };
    const bass = meanLevel(1, bassEnd);
    const mids = meanLevel(bassEnd, midEnd);
    const highs = meanLevel(midEnd, highEnd);
    const rhythm = bass * .56 + mids * .28 + highs * .16;
    const now = performance.now();
    const since = now - this.lastBeat;
    if (rhythm > .16 && rhythm > this.rhythmBaseline + .047 && since > 220) {
      if (this.lastBeat && since < 950) this.beatInterval = this.beatInterval ? .7 * this.beatInterval + .3 * since : since;
      this.lastBeat = now;
    }
    this.rhythmBaseline += (rhythm - this.rhythmBaseline) * .16;
    return {
      bass, mids, highs,
      pulse: this.lastBeat ? Math.exp(-(now - this.lastBeat) / 125) : 0,
      pace: this.beatInterval && since < 1500 ? Math.max(0, Math.min(1, (680 - this.beatInterval) / 410)) : 0,
    };
  }
  private attachAudio(audio: HTMLAudioElement): void {
    const context=this.audioContext;
    if (!context || !this.mixer || this.audioGains.has(audio)) return;
    const gain=context.createGain();
    context.createMediaElementSource(audio).connect(gain);
    gain.connect(this.mixer);
    this.audioGains.set(audio,gain);
  }
  private streamUrl(id: string, audio = this.audio, refresh = false, full = false): string {
    this.streamBuffers.delete(audio);
    const offline = this.offlineSource?.(id);
    if (offline) return offline;
    const params = new URLSearchParams();
    if (refresh) params.set('refresh', '1');
    else if (this.context) params.set('wave', '1');
    if (!full && (this.queue.find(track => track.id === id)?.duration_sec ?? 0) > FULL_BUFFER_AFTER) {
      const token = crypto.randomUUID();
      this.streamBuffers.set(audio, { id, token, continued: false });
      params.set('buffer', token);
    }
    return `/api/stream/${encodeURIComponent(id)}${params.size ? '?'+params : ''}`;
  }
  private continueBuffering(): void {
    const buffer = this.streamBuffers.get(this.audio);
    if (!buffer || buffer.continued || this.remote) return;
    buffer.continued = true;
    void fetch(`/api/stream/${encodeURIComponent(buffer.id)}/continue?buffer=${buffer.token}`, { method: 'POST' })
      .then(response => { if (!response.ok) throw new Error('Unable to continue buffering'); })
      .catch(() => { buffer.continued = false; });
  }
  private clearSeek(): void {
    this.seekDownload?.abort();
    this.seekDownload = undefined;
    if (this.seekObjectUrl) URL.revokeObjectURL(this.seekObjectUrl);
    this.seekObjectUrl = undefined;
    this.pendingSeek = undefined;
    this.seekingTo = undefined;
  }
  private applyPendingSeek(): void {
    const target = this.pendingSeek;
    if (target === undefined || this.seekingTo === target || this.seekDownload || this.audio.readyState === 0 && !Number.isFinite(this.audio.duration)) return;
    const { seekable, duration } = this.audio;
    let canSeek = Boolean(this.seekObjectUrl || this.offlineSource?.(this.current?.id ?? '') || !seekable);
    for (let index = 0; seekable && index < seekable.length; index++) {
      if (target >= seekable.start(index) && target <= seekable.end(index) + 0.3) canSeek = true;
    }
    if (!canSeek || !Number.isFinite(duration)) {
      this.downloadForSeek();
      return;
    }
    if (target >= FULL_BUFFER_AFTER) this.continueBuffering();
    const position = Math.min(target, duration);
    if (Math.abs(this.audio.currentTime - position) < 0.01) {
      this.pendingSeek = undefined;
      return;
    }
    this.pendingSeek = position;
    this.seekingTo = position;
    this.audio.currentTime = position;
    // Simple media mocks and browsers returning immediately from a no-op seek.
    if (!this.audio.seeking && Math.abs(this.audio.currentTime - position) < 0.01) {
      this.pendingSeek = undefined;
      this.seekingTo = undefined;
    }
  }
  private downloadForSeek(): void {
    const track = this.current;
    if (!track || this.remote || this.seekDownload || this.seekObjectUrl || this.offlineSource?.(track.id)) return;
    const controller = new AbortController();
    const audio = this.audio;
    const resume = !audio.paused || audio.ended || (this.loading && !this.playing);
    this.seekDownload = controller;
    this.change();
    void fetch(`/api/stream/${encodeURIComponent(track.id)}`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]),
    }).then(async response => {
      if (!response.ok || !response.headers.get('Content-Type')?.startsWith('audio/')) throw new Error('Audio unavailable');
      const body = await response.blob();
      if (controller.signal.aborted) return;
      this.seekObjectUrl = URL.createObjectURL(body);
      this.streamBuffers.delete(audio);
      const shouldPlay = !audio.paused || (resume && audio.ended);
      this.seekingTo = undefined;
      audio.src = this.seekObjectUrl;
      // Keep the desired position through the source change and let metadata seek before playback.
      this.seekDownload = undefined;
      if (shouldPlay) this.resume();
    }).catch(() => {
      if (controller.signal.aborted) return;
      this.seekDownload = undefined;
      this.pendingSeek = undefined;
      this.seekingTo = undefined;
      this.change();
      this.tick();
      this.dispatchEvent(new CustomEvent('playbacknotice', { detail: 'Не удалось загрузить выбранный участок трека.' }));
    });
  }
  private applyVolumes(progress = 0): void {
    const set = (audio: HTMLAudioElement, level: number) => {
      const gain=this.audioGains.get(audio);
      if(gain){ audio.volume=1; gain.gain.value=level*this.masterVolume; }
      else audio.volume=level*this.masterVolume;
    };
    set(this.audio,1-progress);
    if(this.spare)set(this.spare,progress);
  }
  setCrossfade(seconds: number): void {
    this.fadeSeconds=Math.max(0,Math.min(8,Math.round(seconds)||0));
    this.cancelCrossfade();
    this.updateCrossfade();
  }
  private followingIndex(): number | null {
    return nextIndex(this.index,this.queue.length,this.context?'off':this.repeat,false,true);
  }
  private updateCrossfade(): void {
    if(this.pendingSeek !== undefined || !this.fadeSeconds || !this.playing || this.audio.paused || this.audio.seeking || !Number.isFinite(this.audio.duration))return;
    const index=this.followingIndex();
    const track=index===null||index===this.index?undefined:this.queue[index];
    if(!track){if(this.prepared)this.cancelCrossfade();return;}
    if(this.prepared && this.prepared.trackId!==track.id)this.cancelCrossfade();
    const duration = this.audio.duration + 4 >= this.duration ? this.audio.duration : this.duration;
    const remaining=duration-this.audio.currentTime;
    if(!this.prepared && remaining<=this.fadeSeconds+12 && remaining>0){
      if(!this.spare){
        this.spare=new Audio();
        this.spare.preload='auto';
        this.bindAudio(this.spare);
        this.attachAudio(this.spare);
      }
      this.prepared={audio:this.spare,trackId:track.id,starting:false,failed:false};
      this.applyVolumes();
      this.spare.src=this.streamUrl(track.id, this.spare);
      this.spare.load();
    }
    const prepared=this.prepared;
    if(!prepared || prepared.failed)return;
    if(this.fade){
      const progress=Math.max(0,Math.min(1,(this.audio.currentTime-this.fade.start)/this.fade.duration));
      this.applyVolumes(progress);
      if(progress<1 && !this.fadeFrame && typeof requestAnimationFrame==='function'){
        this.fadeFrame=requestAnimationFrame(()=>{this.fadeFrame=0;this.updateCrossfade();});
      }
      return;
    }
    if(prepared.starting || remaining>this.fadeSeconds || remaining<.3 || prepared.audio.readyState<3)return;
    prepared.starting=true;
    void prepared.audio.play().then(()=>{
      if(this.prepared!==prepared||prepared.failed)return;
      if(this.audio.paused||this.audio.ended){this.cancelCrossfade();return;}
      const left=duration-this.audio.currentTime;
      if(left<.15){this.cancelCrossfade();return;}
      this.fade={start:this.audio.currentTime,duration:left};
      this.updateCrossfade();
    }).catch(()=>{
      if(this.prepared===prepared){
        prepared.failed=true;
        this.fade=undefined;
        prepared.audio.pause();
        this.applyVolumes();
      }
    });
  }
  private cancelCrossfade(): void {
    const prepared=this.prepared;
    this.prepared=undefined;
    this.fade=undefined;
    if(this.fadeFrame){cancelAnimationFrame(this.fadeFrame);this.fadeFrame=0;}
    if(prepared){
      prepared.audio.pause();
      prepared.audio.removeAttribute('src');
      prepared.audio.load();
    }
    this.applyVolumes();
  }
  private commitCrossfade(): boolean {
    const index=this.followingIndex(), prepared=this.prepared;
    if(index===null || !prepared || !this.fade || prepared.failed || prepared.audio.paused ||
      this.queue[index]?.id!==prepared.trackId)return false;
    this.finish(true);
    const outgoing=this.audio;
    this.clearSeek();
    this.audio=prepared.audio;this.spare=outgoing;this.index=index;
    this.prepared=undefined;
    this.cancelCrossfade();
    outgoing.pause();outgoing.removeAttribute('src');outgoing.load();
    this.sequence++;this.retryCount=0;this.retryTime=0;this.pendingSeek=undefined;this.restoredPosition=undefined;
    this.mode='full';this.playing=true;this.loading=false;
    this.announceTrack(this.queue[index]);
    this.mediaState();
    this.dispatchEvent(new Event('playing'));
    this.tick();
    return true;
  }
  mirror(playback: LivePlayback): void {
    const trackChanged=this.current?.id!==playback.track.id;
    const controlsChanged=!this.remote || this.playing!==playback.playing || this.volume!==playback.volume ||
      this.context!==playback.context || this.shuffle!==playback.shuffle || this.repeat!==playback.repeat ||
      this.queue.length!==playback.queue.length || this.queue.some((item,index)=>item.id!==playback.queue[index]?.id);
    const entering=!this.remote;
    this.remote={...playback,sampledAt:performance.now()};
    if(entering) {
      this.sequence++;
      this.clearSeek();
      this.cancelCrossfade();
      this.audio.pause();this.audio.removeAttribute('src');this.audio.load();
      this.restoredPosition=undefined;this.retryTime=0;this.pendingSeek=undefined;
    }
    this.queue=playback.queue.some(track=>track.id===playback.track.id)?playback.queue:[playback.track,...playback.queue];
    this.index=this.queue.findIndex(track=>track.id===playback.track.id);
    this.context=playback.context??undefined;
    this.shuffle=playback.shuffle;this.repeat=playback.repeat;
    this.mode='full';this.playing=playback.playing;this.loading=false;
    if(trackChanged)this.announceTrack(playback.track);
    else if(controlsChanged)this.change();
    this.mediaState();
    this.dispatchEvent(new Event('tick'));
  }
  stopMirroring(): void {
    if(!this.remote)return;
    const position=this.time;
    this.remote=undefined;
    this.restoredPosition=position;
    this.playing=false;this.loading=false;
    this.change();this.mediaState();
  }
  pause(): void {
    if(this.remote){if(this.remote.playing)this.remoteControl?.('toggle');return;}
    this.cancelCrossfade(); this.audio.pause();
  }
  toggle(): void {
    if(this.remote){this.remoteControl?.('toggle');return;}
    if (this.current) { if (this.audio.paused) this.resume(); else this.pause(); }
  }
  next(ended = false, feedback = true): void {
    if(this.remote){if(!ended)this.remoteControl?.('next');return;}
    this.cancelCrossfade();
    this.finish(ended||!feedback);
    const index = nextIndex(this.index, this.queue.length, this.context ? 'off' : this.repeat, false, ended);
    if (index === null) {
      this.audio.pause(); this.playing = false; this.loading = false; this.change();
      if (this.context) this.dispatchEvent(new Event('waveend'));
      return;
    }
    this.index = index; this.load();
  }
  playQueued(index: number): void {
    if(this.remote){this.remoteControl?.('queued',index);return;}
    if (!Number.isInteger(index) || index < this.index || !this.queue[index]) return;
    if (index === this.index) { this.toggle(); return; }
    this.finish(false);
    this.index = index;
    this.load();
  }
  previous(restartCurrent = true): void {
    if(this.remote){this.remoteControl?.('previous',restartCurrent?1:0);return;}
    if (restartCurrent && this.time > 3) { this.seek(0); return; }
    if (this.index > 0) { this.finish(false);this.index--; this.load(); } else this.seek(0);
  }
  seek(time: number): void {
    if(this.remote){this.remoteControl?.('seek',time);return;}
    if(!this.current)return;
    if(this.restoredPosition!==undefined){
      this.restoredPosition=Math.max(0,Math.min(this.duration,time));
      this.tick();this.dispatchEvent(new Event('resume-position'));return;
    }
    if (!Number.isFinite(time)) return;
    this.pendingSeek = Math.max(0, Math.min(this.duration, time));
    this.applyPendingSeek();
    this.tick();
  }
  setVolume(value: number): void {
    if(this.remote){this.remoteControl?.('volume',value);return;}
    this.masterVolume=Math.max(0,Math.min(1,value));
    if(this.fade)this.updateCrossfade();else this.applyVolumes();
    this.change();
  }
  toggleRepeat(): void {
    if(this.remote){this.remoteControl?.('repeat');return;}
    this.repeat = this.repeat === 'off' ? 'all' : this.repeat === 'all' ? 'one' : 'off'; this.updateCrossfade(); this.change();
  }
  toggleShuffle(): void {
    if(this.remote){this.remoteControl?.('shuffle');return;}
    if (this.context) return;
    this.shuffle = !this.shuffle;
    if (this.shuffle) this.shuffleAhead();
    else {
      const order = new Map(this.originalOrder.map((track, index) => [track.id, index]));
      const remaining = this.queue.slice(this.index + 1).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      this.queue = [...this.queue.slice(0, this.index + 1), ...remaining];
    }
    this.updateCrossfade();
    this.change();
  }
  private shuffleAhead(): void {
    for (let index = this.queue.length - 1; index > this.index + 1; index--) {
      const other = this.index + 1 + Math.floor(Math.random() * (index - this.index));
      [this.queue[index], this.queue[other]] = [this.queue[other], this.queue[index]];
    }
  }
  private change(): void { this.dispatchEvent(new Event('change')); }
  private tick(): void {
    this.listening.sample(this.time,performance.now(),!this.audio.paused,this.audio.seeking);
    if (!this.finished && this.listening.seconds >= FULL_BUFFER_AFTER) this.continueBuffering();
    const duration=this.current?.duration_sec||this.duration;
    if(!this.completed&&this.mode==='full'&&this.listening.ratio(duration)>0.8){this.completed=true;this.reaction('complete');}
    this.dispatchEvent(new Event('tick'));
  }
  private finish(ended:boolean):void{
    if(!this.current||this.finished)return;
    this.tick();this.finished=true;
    if(!ended&&!this.completed&&this.mode==='full'&&this.listening.seconds>0.5&&this.listening.seconds<30)this.reaction('early_skip');
  }
  private reaction(action:'complete'|'early_skip'):void{
    if(this.current)this.dispatchEvent(new CustomEvent('reaction',{detail:{track_id:this.current.id,action,listen_ratio:this.listening.ratio(this.current.duration_sec),listened_sec:this.listening.seconds,session_id:this.context}}));
  }
  replaceAhead(list:Track[]):void{
    const current=this.current;if(!current||list[0]?.id!==current.id)return;
    const before=this.queue.slice(Math.max(0,this.index-10),this.index);
    this.queue=[...before,...list];this.index=before.length;this.updateCrossfade();this.change();
  }
  private mediaState(): void { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = this.playing ? 'playing' : 'paused'; }
}

import { api, type DeviceCommand, type DeviceState } from './api.ts';
import type { Player } from './player.ts';

export class PlaybackDevices {
  readonly id=crypto.randomUUID();
  private readonly label=location.protocol==='tauri:'||'__YAMUSIC_WINDOWS__' in window
    ? 'YaMusic для Windows' : matchMedia('(pointer: coarse)').matches ? 'Мобильный браузер' : 'Браузер на компьютере';
  state?: DeviceState;
  private running?: Promise<void>;
  private timer=0;
  private animation=0;
  private stopped=false;
  private wasActive=false;
  private startRequested=false;
  private controls: DeviceCommand[]=[];
  private transferTarget?: string;

  constructor(private player: Player, private update: ()=>void, private progress: ()=>void, private message: (text:string)=>void) {
    player.remoteControl=(action,value)=>{
      if(action==='local_play'){this.message('Выберите «Это устройство» в плеере, чтобы слушать здесь.');return;}
      if(action==='volume'||action==='seek')this.controls=this.controls.filter(command=>command.action!==action);
      this.controls.push({action,value});
      this.pulse();
    };
    player.addEventListener('playing',this.onPlaying);
    player.addEventListener('pause',this.pulse);
    player.addEventListener('seeked',this.pulse);
    window.addEventListener('pagehide',this.leave);
    window.addEventListener('pageshow',this.pulse);
    this.timer=window.setInterval(this.pulse,1100);
    this.animation=window.setInterval(()=>{if(player.mirroring)this.progress();},250);
    this.pulse();
  }

  private onPlaying=():void=>{this.startRequested=true;this.pulse();};

  private send(event:object, keepalive=false) {
    return api.devices({id:this.id,label:this.label,...event},keepalive);
  }

  private leave=():void=>{void this.send({kind:'leave'},true).catch(()=>{});};

  private pulse=():void=>{
    if(this.running||this.stopped)return;
    this.running=this.sync().catch(()=>{}).finally(()=>{this.running=undefined;});
  };

  transfer(target: string): void { this.transferTarget=target;this.pulse(); }

  private async sync(): Promise<void> {
    const player=this.player;
    const revision=this.state?.revision??0;
    let state: DeviceState;
    if(this.transferTarget){
      const target=this.transferTarget;
      this.transferTarget=undefined;
      state=await this.send({kind:'transfer',target,revision});
    }else if(this.controls.length){
      const command=this.controls.shift()!;
      state=await this.send({kind:'control',command,revision});
    }else{
      const track=player.current;
      const playback=track&&!player.mirroring?{
        track,queue:player.queue.length<=250?player.queue:player.queue.slice(Math.max(0,player.index-20),player.index+230),
        context:player.context,position:player.time,playing:player.playing,volume:player.volume,
        shuffle:player.shuffle,repeat:player.repeat,
      }:undefined;
      const start=this.startRequested;
      state=await this.send({kind:'pulse',playback,revision,start});
      if(start&&state.active)this.startRequested=false;
    }
    if(this.stopped)return;
    this.state=state;
    const playback=state.playback;
    if(state.active&&playback&&(state.active!==this.id||state.transferring)){
      if(this.wasActive&&state.active!==this.id)this.startRequested=false;
      this.wasActive=false;
      const position=playback.position+(playback.playing?Math.min(state.age,4_000)/1000:0);
      player.mirror({...playback,position});
    }else if(state.active===this.id){
      if(playback&&!this.wasActive&&player.mirroring){
        const position=player.time;
        player.stopMirroring();
        player.restore(playback.track,playback.queue,position,playback.context??undefined);
        if(playback.playing)player.resume();
      }
      this.wasActive=true;
      for(const command of state.commands)this.run(command);
    }else{
      this.wasActive=false;
      player.stopMirroring();
      if(player.playing)this.startRequested=true;
    }
    this.update();
  }

  private run({action,value}: DeviceCommand): void {
    switch(action){
      case 'toggle':this.player.toggle();break;
      case 'next':this.player.next();break;
      case 'previous':this.player.previous(value!==0);break;
      case 'seek':if(value!==undefined)this.player.seek(value);break;
      case 'volume':if(value!==undefined)this.player.setVolume(value);break;
      case 'shuffle':this.player.toggleShuffle();break;
      case 'repeat':this.player.toggleRepeat();break;
      case 'queued':if(value!==undefined)this.player.playQueued(value);break;
    }
  }

  close(): void {
    this.stopped=true;
    this.leave();
    clearInterval(this.timer);
    clearInterval(this.animation);
    this.player.removeEventListener('playing',this.onPlaying);
    this.player.removeEventListener('pause',this.pulse);
    this.player.removeEventListener('seeked',this.pulse);
    window.removeEventListener('pagehide',this.leave);
    window.removeEventListener('pageshow',this.pulse);
    this.player.remoteControl=undefined;
    this.player.stopMirroring();
  }
}

// Count elapsed playback, never a jump caused by seeking or a stalled buffer.
export class ListeningProgress {
  seconds=0;
  private position=0;
  private clock=0;
  reset(position=0,clock=0):void{this.seconds=0;this.anchor(position,clock);}
  anchor(position:number,clock:number):void{this.position=position;this.clock=clock;}
  sample(position:number,clock:number,playing:boolean,seeking:boolean):void{
    const delta=position-this.position, elapsed=Math.max(0,(clock-this.clock)/1000);
    if(playing&&!seeking&&delta>0&&delta<=elapsed*1.5+0.15)this.seconds+=delta;
    this.anchor(position,clock);
  }
  ratio(duration:number):number{return duration>0?Math.min(1,this.seconds/duration):0;}
}

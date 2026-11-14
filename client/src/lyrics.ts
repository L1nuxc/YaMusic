export interface LyricLine { time: number; text: string }
export interface LyricsResult {
  track_id: string; synced_lrc: string | null; plain_lyrics: string | null;
  instrumental: boolean; provider_id: number | null; status: 'synced'|'plain'|'instrumental'|'not_found'; source: string;
}
/** Retry short provider/network outages, and cancel the delay on a song change. */
export async function retryLyrics<T>(request: () => Promise<T>, signal: AbortSignal): Promise<T> {
  const delays=[650,1500];
  for(let attempt=0;;attempt++){
    signal.throwIfAborted();
    try { return await request(); }
    catch(error){
      signal.throwIfAborted();
      const status=(error as {status?:number} | null)?.status;
      if(attempt===delays.length || (status!==undefined && status!==408 && status!==429 && status<500))throw error;
      await new Promise<void>((resolve,reject)=>{
        const abort=()=>{clearTimeout(timer);reject(signal.reason);};
        const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},delays[attempt]);
        signal.addEventListener('abort',abort,{once:true});
      });
    }
  }
}
export function parseLrc(lrc: string): LyricLine[] {
  const offset = Number(lrc.match(/\[offset:([+-]?\d+)\]/i)?.[1] || 0) / 1000;
  const result: LyricLine[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const times = [...raw.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    const text = raw.replace(/\[[^\]]*\]/g,'').replace(/<\d+:\d+(?:\.\d+)?>/g,'').trim();
    if (!text) continue;
    for (const match of times) {
      if (Number(match[2]) >= 60) continue;
      result.push({ time: Math.max(0,Number(match[1])*60+Number(match[2])+Number(`0.${match[3]||0}`)-offset), text });
    }
  }
  return result.sort((a,b)=>a.time-b.time);
}
export function activeLine(lines: LyricLine[], time: number): number {
  let low=0, high=lines.length-1, result=-1;
  while(low<=high) { const mid=(low+high)>>>1; if(lines[mid].time<=time){result=mid;low=mid+1;}else high=mid-1; }
  return result;
}

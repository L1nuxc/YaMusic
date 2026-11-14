import { neutralPalette, type Palette, type RGB } from './palette.ts';
import type { VisualAudio } from './player.ts';

/** Canvas ribbons use real audio energy, while idle motion stays slow and unobtrusive. */
export class Wave {
  private frame = 0;
  private last = 0;
  private time = 0;
  private bands = [0, 0, 0];
  private pulse = 0;
  private celebrationAt = -Infinity;
  private colors: RGB[] = [[...neutralPalette.primary], [...neutralPalette.secondary]];
  private enabled = true;
  private visible = !document.hidden;
  private motion = matchMedia('(prefers-reduced-motion: reduce)');
  private observer: ResizeObserver;
  private intersection: IntersectionObserver;
  private onscreen = true;
  constructor(private canvas: HTMLCanvasElement, private isPlaying: () => boolean,
    private audio: () => VisualAudio & { palette: Palette }) {
    this.observer = new ResizeObserver(() => { this.resize(); this.draw(); });
    this.observer.observe(canvas);
    this.intersection = new IntersectionObserver(([entry]) => { this.onscreen = entry.isIntersecting; this.schedule(); });
    this.intersection.observe(canvas);
    document.addEventListener('visibilitychange', this.visibility);
    this.motion.addEventListener('change', this.schedule);
    this.resize(); this.schedule();
  }
  setEnabled(enabled: boolean): void { this.enabled = enabled; this.schedule(); this.draw(); }
  celebrate(): void {
    if (this.enabled && this.visible && this.onscreen && !this.motion.matches) this.celebrationAt = performance.now();
  }
  private resize(): void {
    const scale = Math.min(devicePixelRatio || 1, 1.5);
    this.canvas.width = Math.max(1, Math.round(this.canvas.clientWidth * scale));
    this.canvas.height = Math.max(1, Math.round(this.canvas.clientHeight * scale));
  }
  private visibility = (): void => { this.visible = !document.hidden; this.schedule(); };
  private schedule = (): void => {
    cancelAnimationFrame(this.frame); this.last = 0;
    if (this.enabled && this.visible && this.onscreen && !this.motion.matches) this.frame = requestAnimationFrame(this.animate);
    else this.draw();
  };
  private animate = (at: number): void => {
    if (at - this.last >= 1000 / 45) {
      const input = this.audio();
      const playing = this.isPlaying();
      [input.bass, input.mids, input.highs].forEach((level, layer) => {
        const target = playing ? level : 0;
        const current = this.bands[layer];
        this.bands[layer] += (target - current) * (target > current ? .57 : .2);
      });
      this.pulse = playing ? input.pulse : 0;
      [input.palette.primary, input.palette.secondary].forEach((color, layer) =>
        color.forEach((value, channel) => this.colors[layer][channel] += (value - this.colors[layer][channel]) * .07));
      const [bass, mids, highs] = this.bands;
      this.time += Math.min((at - (this.last || at)) / 1000, .06) *
        (.24 + bass * .7 + mids * .65 + highs * .35 + input.pace * 1.4);
      this.last = at; this.draw();
    }
    this.frame = requestAnimationFrame(this.animate);
  };
  private draw(): void {
    const ctx = this.canvas.getContext('2d'); if (!ctx) return;
    const w = this.canvas.width, h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    const light = document.documentElement.dataset.theme === 'light';
    const steps = Math.min(220, Math.ceil(w / 5));
    const age = this.enabled && !this.motion.matches ? (performance.now()-this.celebrationAt)/1000 : Infinity;
    const cheer = age<.9 ? Math.sin(Math.min(1,age/.12)*Math.PI/2)*Math.exp(-age*3) +
      (age>.16 ? .42*Math.sin(Math.min(1,(age-.16)/.09)*Math.PI/2)*Math.exp(-(age-.16)*5) : 0) : 0;
    for (let layer = 0; layer < 3; layer++) {
      const level = this.bands[layer];
      const beat = this.pulse * [1, .6, .25][layer] + cheer * [.95,.7,.52][layer];
      const phase = this.time * (1 + layer * .26) + layer * 1.65;
      // Album colors mixed with graphite retain contrast for both themes.
      const rgb = this.colors[layer % 2].map(value => Math.round(value * .78 + (light ? 25 : 225) * .22));
      const glow = ctx.createRadialGradient(w * (.38 + layer * .12), h * .48, 0, w * .5, h * .5, w * .45);
      glow.addColorStop(0, `rgba(${rgb.join(',')},${(light ? .04 : .06) + level * .12 + beat * .045})`);
      glow.addColorStop(1, `rgba(${rgb.join(',')},0)`);
      ctx.fillStyle = glow; ctx.fillRect(0, 0, w, h);
      const lines = w < 850 ? 24 : 32;
      const half = (lines - 1) / 2;
      for (let line = 0; line < lines; line++) {
        const spread = (line - half) / half;
        const gradient = ctx.createLinearGradient(0, 0, w, 0);
        const alpha = (1 - Math.abs(spread) * .68) * (layer ? .11 : .21) * (1 + level * 1.15 + beat * .7);
        const color = rgb.join(',');
        // Both ends fade before the canvas bounds; no visible hard clipping.
        gradient.addColorStop(0, `rgba(${color},0)`); gradient.addColorStop(.08, `rgba(${color},0)`);
        gradient.addColorStop(.25, `rgba(${color},${alpha * .6})`); gradient.addColorStop(.5, `rgba(${color},${alpha})`);
        gradient.addColorStop(.75, `rgba(${color},${alpha * .6})`); gradient.addColorStop(.92, `rgba(${color},0)`); gradient.addColorStop(1, `rgba(${color},0)`);
        ctx.strokeStyle = gradient; ctx.lineWidth = line % 6 === 0 ? 1.25 : .7;
        ctx.beginPath();
        for (let i = 0; i <= steps; i++) {
          const u = i / steps, x = u * w, envelope = Math.sin(Math.PI * u);
          const body = Math.sin(u * Math.PI * (2.2 + layer * .52) + phase + spread * .28);
          const ripples = Math.cos(u * Math.PI * (4.5 + layer * 2.5) - phase * .78 + spread * 1.1);
          const y = h * .51 + envelope * h * (
            body * (.105 + level * .12 + beat * .065) +
            ripples * (.022 + level * .05) +
            spread * (.12 + level * .075 + beat * .045) * Math.sin(u * Math.PI * 2 + phase * .55 + .7)
          );
          if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }
    if (cheer>0) {
      const color=this.colors[0].map(value=>Math.round(value*.74+(light ? 35 : 250)*.26)).join(',');
      const radius=Math.min(w*.32,h*.49)*Math.pow(age/.9,.68);
      for(let i=0;i<12;i++){
        const angle=i*Math.PI/6;
        const distance=radius*(i%2 ? 1 : 1.25);
        ctx.fillStyle=`rgba(${color},${cheer*(i%2 ? .45 : .72)})`;
        ctx.beginPath();
        ctx.arc(w*.5+Math.cos(angle)*distance*1.8,h*.5+Math.sin(angle)*distance*.76,(i%3+1)*.85,0,Math.PI*2);
        ctx.fill();
      }
    }
    // A wide radial glow still has alpha at the short vertical canvas edges.
    // Fade the whole composition there so it merges with the page in every size.
    ctx.save();
    ctx.globalCompositeOperation = 'destination-in';
    const fade = ctx.createLinearGradient(0, 0, 0, h);
    fade.addColorStop(0, 'rgba(0,0,0,0)'); fade.addColorStop(.22, 'rgba(0,0,0,1)');
    fade.addColorStop(.76, 'rgba(0,0,0,1)'); fade.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = fade; ctx.fillRect(0, 0, w, h); ctx.restore();
  }
  destroy(): void { cancelAnimationFrame(this.frame); this.observer.disconnect(); this.intersection.disconnect(); document.removeEventListener('visibilitychange', this.visibility); this.motion.removeEventListener('change', this.schedule); }
}

import { interfaceMotion, springState, stepSpring, unit } from './springs.ts';

export function crossfadeLabel(seconds: number): string {
  return seconds ? `${seconds} с` : 'Выкл.';
}

export function jellySlider(seconds: number): string {
  return `<span class="crossfade-value">
    <span class="jelly-slider" style="--jelly-position:${seconds / 8}">
      <span class="jelly-rail" aria-hidden="true"></span>
      <svg class="jelly-filter" width="0" height="0" aria-hidden="true"><defs>
        <filter id="crossfade-goo" x="-50%" y="-100%" width="200%" height="300%" color-interpolation-filters="sRGB">
          <feGaussianBlur stdDeviation="5" result="blur"/>
          <feColorMatrix in="blur" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -10" result="goo"/>
          <feComposite in="SourceGraphic" in2="goo" operator="atop"/>
        </filter>
      </defs></svg>
      <span class="jelly-shapes" aria-hidden="true"><span class="jelly-thumb"></span><span class="jelly-drop"></span></span>
      <span class="jelly-label" aria-hidden="true">${crossfadeLabel(seconds)}</span>
      <input id="crossfade" type="range" min="0" max="8" step="1" value="${seconds}" aria-labelledby="crossfade-label" aria-describedby="crossfade-description" aria-valuetext="${crossfadeLabel(seconds)}">
    </span>
    <output for="crossfade">${crossfadeLabel(seconds)}</output>
  </span>`;
}

export function mountJellySlider(input: HTMLInputElement): void {
  const slider = input.closest<HTMLElement>('.jelly-slider')!;
  const label = slider.querySelector<HTMLElement>('.jelly-label')!;
  const output = slider.parentElement!.querySelector<HTMLOutputElement>('output')!;
  const ratio = () => input.valueAsNumber / Number(input.max);
  const position = springState(ratio());
  const bubble = springState(0);
  const lag = springState(position.position);
  const press = springState(1);
  let pointer: number | undefined;
  let pointerTarget = position.position;
  let keyboard = false;
  let hover = false;
  let released = false;
  let frame = 0;
  let last = 0;

  function updatePointer(event: PointerEvent): void {
    const rect = slider.getBoundingClientRect();
    const raw = (event.clientX - rect.left - 12) / Math.max(1, rect.width - 24);
    const extra = raw - unit(raw);
    pointerTarget = unit(raw) + Math.sign(extra) * Math.min(0.075, Math.abs(extra) * 0.4);
  }

  function render(now: number): void {
    frame = 0;
    const dt = Math.max(0, now - last) / 1000;
    last = now;
    const dragging = pointer !== undefined;
    const target = dragging ? pointerTarget : ratio();
    const rise = dragging || keyboard ? 1 : 0;
    const scale = dragging ? 1.16 : hover ? 1.08 : 1;
    const motion = interfaceMotion();
    if (motion) {
      stepSpring(position, target, dragging ? 900 : released ? 300 : 420, dragging ? 50 : released ? 14 : 34, dt);
      stepSpring(lag, position.position, 260, 18, dt);
      stepSpring(bubble, rise, 420, 22, dt);
      stepSpring(press, scale, 520, 16, dt);
    } else {
      position.position = lag.position = ratio();
      bubble.position = rise;
      press.position = 1;
      position.velocity = lag.velocity = bubble.velocity = press.velocity = 0;
    }
    const stretch = 1 + Math.min(Math.abs(position.velocity) * 0.035, 0.4);
    slider.style.setProperty('--jelly-position', String(position.position));
    slider.style.setProperty('--jelly-lag', String(lag.position));
    slider.style.setProperty('--jelly-rise', String(unit(bubble.position)));
    slider.style.setProperty('--jelly-scale-x', String(stretch * press.position));
    slider.style.setProperty('--jelly-scale-y', String(press.position / stretch));
    slider.style.setProperty('--jelly-tilt', `${Math.max(-20, Math.min(20, (lag.position - position.position) * 135))}deg`);
    const unsettled = Math.abs(position.position - target) + Math.abs(lag.position - position.position) +
      Math.abs(bubble.position - rise) + Math.abs(press.position - scale) +
      Math.abs(position.velocity) + Math.abs(lag.velocity) + Math.abs(bubble.velocity) + Math.abs(press.velocity);
    if (motion && slider.isConnected && unsettled > 0.001) frame = requestAnimationFrame(render);
  }

  function update(): void {
    if (frame) return;
    last = performance.now();
    frame = requestAnimationFrame(render);
  }

  input.addEventListener('input', () => {
    const value = crossfadeLabel(input.valueAsNumber);
    label.textContent = output.textContent = value;
    input.setAttribute('aria-valuetext', value);
    update();
  });
  input.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    pointer = event.pointerId;
    keyboard = released = false;
    updatePointer(event);
    update();
  });
  input.addEventListener('pointermove', event => {
    if (pointer !== event.pointerId) return;
    updatePointer(event);
    update();
  });
  const end = (event: PointerEvent) => {
    if (pointer !== event.pointerId) return;
    pointer = undefined;
    released = true;
    update();
  };
  input.addEventListener('pointerup', end);
  input.addEventListener('pointercancel', end);
  input.addEventListener('lostpointercapture', end);
  input.addEventListener('pointerenter', event => { hover = event.pointerType === 'mouse'; update(); });
  input.addEventListener('pointerleave', () => { hover = false; update(); });
  input.addEventListener('focus', () => { keyboard = input.matches(':focus-visible'); update(); });
  input.addEventListener('keydown', () => { keyboard = true; released = false; update(); });
  input.addEventListener('blur', () => { keyboard = false; pointer = undefined; update(); });
}

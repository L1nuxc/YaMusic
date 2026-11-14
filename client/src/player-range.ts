import { formatTime } from './model.ts';
import { unit } from './springs.ts';

export function playerRange(kind: 'seek' | 'volume', value: number, max: number, disabled = false): string {
  const seek = kind === 'seek';
  return `<div class="player-range">
    <input type="range" data-${kind} min="0" max="${max}" step="${seek ? '0.1' : '0.01'}" value="${value}"
      aria-label="${seek ? 'Позиция в треке' : 'Громкость'}"${disabled ? ' disabled' : ''}/>
    <span class="player-range-tooltip" aria-hidden="true" hidden></span>
  </div>`;
}

export function mountPlayerRanges(root: HTMLElement): void {
  for (const range of root.querySelectorAll<HTMLElement>('.player-range')) {
    const input = range.querySelector('input')!;
    const tooltip = range.querySelector<HTMLElement>('.player-range-tooltip')!;
    const hide = () => { tooltip.hidden = true; };
    const preview = (event: PointerEvent) => {
      const max = Number(input.max);
      if (event.pointerType !== 'mouse' || input.disabled || !max) { hide(); return; }
      const bounds = input.getBoundingClientRect();
      const radius = parseFloat(getComputedStyle(input).getPropertyValue('--range-thumb-size')) / 2;
      const progress = unit((event.clientX - bounds.left - radius) / Math.max(1, bounds.width - radius * 2));
      const value = progress * max;
      tooltip.textContent = input.hasAttribute('data-seek') ? formatTime(value) : `${Math.round(value * 100)}%`;
      tooltip.style.left = `${radius + progress * (bounds.width - radius * 2)}px`;
      tooltip.hidden = false;
    };
    input.addEventListener('pointerenter', preview);
    input.addEventListener('pointermove', preview);
    input.addEventListener('pointerleave', hide);
    input.addEventListener('pointercancel', hide);
  }
}

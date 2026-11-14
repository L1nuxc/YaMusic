import { formatTime } from './model.ts';
import { unit } from './springs.ts';

const volumeFeedback = new WeakMap<HTMLInputElement, () => void>();

export function showCurrentVolume(input: HTMLInputElement | null | undefined): void {
  if (input) volumeFeedback.get(input)?.();
}

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
    const seek = input.hasAttribute('data-seek');
    let feedbackTimer = 0;
    const hide = () => {
      window.clearTimeout(feedbackTimer);
      feedbackTimer = 0;
      tooltip.hidden = true;
    };
    const show = (progress: number, value: number) => {
      const radius = parseFloat(getComputedStyle(input).getPropertyValue('--range-thumb-size')) / 2;
      tooltip.textContent = seek ? formatTime(value) : `${Math.round(value * 100)}%`;
      tooltip.style.left = `${radius + progress * (input.offsetWidth - radius * 2)}px`;
      tooltip.hidden = false;
    };
    if (!seek) volumeFeedback.set(input, () => {
      if (!input.offsetWidth) return;
      window.clearTimeout(feedbackTimer);
      show(input.valueAsNumber, input.valueAsNumber);
      feedbackTimer = window.setTimeout(hide, 900);
    });
    const preview = (event: PointerEvent) => {
      if (feedbackTimer) return;
      const max = Number(input.max);
      if (event.pointerType !== 'mouse' || input.disabled || !max) { hide(); return; }
      const bounds = input.getBoundingClientRect();
      const radius = parseFloat(getComputedStyle(input).getPropertyValue('--range-thumb-size')) / 2;
      const progress = unit((event.clientX - bounds.left - radius) / Math.max(1, bounds.width - radius * 2));
      const value = progress * max;
      show(progress, value);
    };
    input.addEventListener('pointerenter', preview);
    input.addEventListener('pointermove', preview);
    input.addEventListener('pointerleave', hide);
    input.addEventListener('pointercancel', hide);
  }
}

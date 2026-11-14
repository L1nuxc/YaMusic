import { interfaceMotion, springFrames, springState, stepSpring } from './springs.ts';

const pressSpring = springFrames(520, 16, 380);
const layoutSpring = springFrames(260, 24, 450);
const presses = new WeakMap<HTMLElement, Animation>();

export function animatePlayerButton(button: HTMLElement): void {
  if (!interfaceMotion()) return;
  presses.get(button)?.cancel();
  presses.set(button, button.animate(pressSpring.map(p => ({ scale: String(0.83 + p * 0.17) })), 380));
}

export function animateDeck(deck: HTMLElement, previous: DOMRect): void {
  if (!interfaceMotion() || !previous.width) return;
  const current = deck.getBoundingClientRect();
  const dx = previous.left - current.left;
  const dy = previous.top - current.top;
  deck.animate(layoutSpring.map(p => ({ translate: `${dx * (1 - p)}px ${dy * (1 - p)}px` })), 450);
}

export function animateLyric(line: HTMLElement): void {
  if (!interfaceMotion()) return;
  line.animate(layoutSpring.map(p => ({
    translate: `${-5 * (1 - p)}px ${4 * (1 - p)}px`,
    scale: String(0.988 + p * 0.012),
  })), 450);
}

const scrolls = new WeakMap<HTMLElement, number>();

export function stopLyricsScroll(scroll: HTMLElement): void {
  cancelAnimationFrame(scrolls.get(scroll) ?? 0);
  scrolls.delete(scroll);
}

export function scrollToLyric(scroll: HTMLElement, line: HTMLElement): void {
  stopLyricsScroll(scroll);
  const top = line.offsetTop + line.offsetHeight / 2 - scroll.clientHeight / 2;
  const target = Math.max(0, Math.min(scroll.scrollHeight - scroll.clientHeight, top));
  const start = scroll.scrollTop;
  if (!interfaceMotion() || Math.abs(start - target) < 2) {
    scroll.scrollTop = target;
    return;
  }
  const state = springState(start);
  let previous = performance.now();
  function tick(now: number): void {
    if (!scroll.isConnected || !scroll.clientHeight || !scroll.closest('dialog[open]')) {
      scrolls.delete(scroll);
      return;
    }
    const position = stepSpring(state, target, 95, 20, (now - previous) / 1000);
    previous = now;
    if (!interfaceMotion() || Math.abs(target - position) + Math.abs(state.velocity) < 1) {
      scroll.scrollTop = target;
      scrolls.delete(scroll);
      return;
    }
    scroll.scrollTop = position;
    scrolls.set(scroll, requestAnimationFrame(tick));
  }
  scrolls.set(scroll, requestAnimationFrame(tick));
}

import { interfaceMotion, springFrames, springState, stepSpring } from './springs.ts';

const pressSpring = springFrames(380, 22, 350);
const layoutSpring = springFrames(260, 24, 450);
const presses = new WeakMap<HTMLElement, Animation>();

export function animatePlayerButton(button: HTMLElement): void {
  if (!interfaceMotion()) return;
  const glyph = button.querySelector('.icon');
  if (!glyph) return;
  const current = parseFloat(getComputedStyle(glyph).scale) || 1;
  presses.get(button)?.cancel();
  const frames: Keyframe[] = [
    { scale: String(current), offset: 0, easing: 'ease-out' },
    ...pressSpring.map((p, i) => ({
      scale: String(0.88 + p * 0.12),
      offset: 0.19 + 0.81 * i / (pressSpring.length - 1),
    })),
  ];
  presses.set(button, glyph.animate(frames, 420));
}

export function animateDeck(deck: HTMLElement, previous: DOMRect): void {
  if (!interfaceMotion() || !previous.width) return;
  const current = deck.getBoundingClientRect();
  const dx = previous.left - current.left;
  const dy = previous.top - current.top;
  deck.animate(layoutSpring.map(p => ({ translate: `${dx * (1 - p)}px ${dy * (1 - p)}px` })), 450);
}

export function animateLyricEcho(previous: HTMLElement): void {
  if (!interfaceMotion()) return;
  const text = previous.querySelector<HTMLElement>('.lyric-text');
  if (!text) return;
  text.querySelector('.lyric-echo')?.remove();
  const echo = document.createElement('span');
  echo.className = 'lyric-echo';
  echo.setAttribute('aria-hidden', 'true');
  echo.textContent = text.textContent;
  text.append(echo);
  const animation = echo.animate([
    { opacity: 0.35, translate: '0 0' },
    { opacity: 0, translate: '0 7px' },
  ], { duration: 380, easing: 'cubic-bezier(.2,.75,.2,1)' });
  animation.onfinish = animation.oncancel = () => echo.remove();
}

type LyricsScroll = { frame: number; target: number };
const scrolls = new WeakMap<HTMLElement, LyricsScroll>();

export function stopLyricsScroll(scroll: HTMLElement): void {
  cancelAnimationFrame(scrolls.get(scroll)?.frame ?? 0);
  scrolls.delete(scroll);
}

export function scrollToLyric(scroll: HTMLElement, line: HTMLElement): void {
  const top = line.offsetTop + line.offsetHeight / 2 - scroll.clientHeight / 2;
  const target = Math.max(0, Math.min(scroll.scrollHeight - scroll.clientHeight, top));
  const start = scroll.scrollTop;
  if (!interfaceMotion()) {
    stopLyricsScroll(scroll);
    scroll.scrollTop = target;
    return;
  }
  const running = scrolls.get(scroll);
  if (running) {
    running.target = target;
    return;
  }
  if (Math.abs(start - target) < 1) return;
  const motion = { frame: 0, target };
  const state = springState(start);
  let previous = performance.now();
  function tick(now: number): void {
    if (!scroll.isConnected || !scroll.clientHeight || !scroll.closest('dialog[open]')) {
      scrolls.delete(scroll);
      return;
    }
    const position = stepSpring(state, motion.target, 118, 22, Math.max(0, now - previous) / 1000);
    previous = now;
    if (!interfaceMotion() || Math.abs(motion.target - position) < 0.5 && Math.abs(state.velocity) < 5) {
      scroll.scrollTop = motion.target;
      scrolls.delete(scroll);
      return;
    }
    scroll.scrollTop = position;
    motion.frame = requestAnimationFrame(tick);
  }
  motion.frame = requestAnimationFrame(tick);
  scrolls.set(scroll, motion);
}

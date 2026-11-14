import { interfaceMotion, springState, stepSpring, unit } from './springs.ts';

// Hover motion from DesignBookmark's Parallax Ticket.
const tilt = 5;
const depth = 7;
const stiffness = 220;
const damping = 18;

export function mountCoverParallax(stage: HTMLElement): void {
  const card = stage.querySelector<HTMLElement>('.expanded-cover-card')!;
  const x = springState(0);
  const y = springState(0);
  let targetX = 0;
  let targetY = 0;
  let frame = 0;
  let previous = 0;

  function tick(now: number): void {
    frame = 0;
    if (!stage.isConnected || !stage.closest('dialog[open]') || !interfaceMotion() || !stage.offsetWidth) {
      x.position = x.velocity = y.position = y.velocity = targetX = targetY = 0;
      card.removeAttribute('style');
      return;
    }
    const dt = (now - previous) / 1000;
    previous = now;
    stepSpring(x, targetX, stiffness, damping, dt);
    stepSpring(y, targetY, stiffness, damping, dt);
    const settled = Math.abs(x.position - targetX) + Math.abs(y.position - targetY)
      + Math.abs(x.velocity) + Math.abs(y.velocity) < 0.002;
    if (settled) {
      x.position = targetX;
      y.position = targetY;
      x.velocity = y.velocity = 0;
    }
    const offsetX = x.position;
    const offsetY = y.position;
    card.style.setProperty('--cover-rx', `${-offsetY * tilt}deg`);
    card.style.setProperty('--cover-ry', `${offsetX * tilt}deg`);
    card.style.setProperty('--cover-x', `${offsetX * depth}px`);
    card.style.setProperty('--cover-y', `${offsetY * depth}px`);
    if (!settled) frame = requestAnimationFrame(tick);
  }

  function animate(): void {
    if (frame) return;
    previous = performance.now();
    frame = requestAnimationFrame(tick);
  }

  stage.addEventListener('pointermove', event => {
    if (event.pointerType !== 'mouse' || !interfaceMotion() || !card.getClientRects().length) return;
    const bounds = stage.getBoundingClientRect();
    targetX = unit((event.clientX - bounds.left) / bounds.width) * 2 - 1;
    targetY = unit((event.clientY - bounds.top) / bounds.height) * 2 - 1;
    animate();
  });
  const reset = () => { targetX = targetY = 0; animate(); };
  stage.addEventListener('pointerleave', reset);
  stage.addEventListener('pointercancel', reset);
}

// Spring parameters from Design Bookmark's Spring Dropdown and Toggle Switch.
export function springState(position: number) {
  return { position, velocity: 0 };
}

const frameSeconds = 1 / 60;

export function stepSpring(state: ReturnType<typeof springState>, target: number, stiffness: number, damping: number, seconds: number): number {
  const dt = Math.min(seconds, 1 / 30) / 4;
  for (let i = 0; i < 4; i++) {
    state.velocity += (stiffness * (target - state.position) - damping * state.velocity) * dt;
    state.position += state.velocity * dt;
  }
  return state.position;
}

export function springFrames(stiffness: number, damping: number, duration: number): number[] {
  const state = springState(0);
  const frames = Math.round(duration / (frameSeconds * 1000));
  return Array.from({ length: frames + 1 }, (_, i) => {
    if (i === 0) return 0;
    if (i === frames) return 1;
    return stepSpring(state, 1, stiffness, damping, frameSeconds);
  });
}

export const unit = (value: number): number => Math.max(0, Math.min(1, value));
export const systemReducedMotion = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;
export const interfaceMotion = (): boolean => !systemReducedMotion() && document.documentElement.dataset.motion !== 'off';

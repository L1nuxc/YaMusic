import { interfaceMotion, springFrames } from './springs.ts';

const lead = springFrames(620, 40, 500);
const trail = springFrames(170, 19, 500);
const sidebarHighlight = springFrames(380, 28, 420);
const running = new WeakMap<HTMLElement, Animation>();

export function syncTabPill(group: HTMLElement, animate = false): void {
  const selected = group.querySelector<HTMLElement>(':scope > [aria-pressed="true"], :scope > [aria-current="page"]');
  let pill = group.querySelector<HTMLElement>(':scope > .tab-pill');
  if (!selected) {
    if (pill) pill.hidden = true;
    return;
  }
  if (!group.offsetWidth) return;
  if (!pill) {
    pill = document.createElement('span');
    pill.className = 'tab-pill';
    pill.setAttribute('aria-hidden', 'true');
    group.prepend(pill);
  }
  pill.hidden = false;

  const styles = getComputedStyle(pill);
  const vertical = group.classList.contains('desktop-navigation');
  const start = vertical ? 'top' : 'left';
  const size = vertical ? 'height' : 'width';
  const target = vertical ? selected.offsetTop : selected.offsetLeft;
  const length = vertical ? selected.offsetHeight : selected.offsetWidth;
  const from = parseFloat(styles[start]) || 0;
  const oldLength = parseFloat(pill.style[size]) ? parseFloat(styles[size]) || 0 : 0;
  running.get(group)?.cancel();
  pill.style[start] = `${target}px`;
  pill.style[size] = `${length}px`;
  if (!animate || !oldLength || !interfaceMotion() || (from === target && oldLength === length)) return;

  if (vertical) {
    running.set(group, pill.animate(sidebarHighlight.map(p => ({ top: `${from + (target - from) * p}px` })), 420));
    return;
  }
  const starts = target >= from ? trail : lead;
  const ends = target >= from ? lead : trail;
  const animation = pill.animate(starts.map((progress, i) => {
    const first = from + (target - from) * progress;
    const last = from + oldLength + (target + length - from - oldLength) * ends[i];
    // Keep the stretch local even when the user jumps several tabs at once.
    const stretch = Math.min(1, (Math.max(length, oldLength) + 36) / Math.max(1, last - first));
    const width = (last - first) * stretch;
    const offset = target >= from ? last - width : first;
    return {
      [start]: `${offset}px`,
      [size]: `${Math.max(0, width)}px`,
    };
  }), { duration: 500 });
  running.set(group, animation);
}

export function selectPillButton(group: HTMLElement, attribute: string, value: string): void {
  group.querySelectorAll<HTMLButtonElement>(':scope > button').forEach(button => {
    const active = button.getAttribute(attribute) === value;
    button.classList.toggle('selected', active);
    button.setAttribute('aria-pressed', String(active));
  });
  syncTabPill(group, true);
}

export function mountPillGroups(): void {
  const layout = () => document.querySelectorAll<HTMLElement>('.tab-pill-group').forEach(group => syncTabPill(group));
  window.addEventListener('resize', layout);
  void document.fonts.ready.then(layout);
  document.addEventListener('keydown', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.tab-pill-group > button');
    if (!button || event.altKey || event.ctrlKey || event.metaKey || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const options = Array.from(button.parentElement!.querySelectorAll<HTMLButtonElement>(':scope > button:not(:disabled)'));
    const index = options.indexOf(button);
    const next = event.key === 'Home' ? options[0] : event.key === 'End' ? options.at(-1) :
      options[(index + (event.key === 'ArrowRight' ? 1 : -1) + options.length) % options.length];
    if (!next) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    next.focus();
    next.click();
  }, true);
}

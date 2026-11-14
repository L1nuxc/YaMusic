import { icon, hydrateIcons } from './icons.ts';
import { escapeHtml } from './model.ts';
import { interfaceMotion, springFrames, springState, stepSpring, systemReducedMotion, unit } from './springs.ts';

const settle = springFrames(300, 23, 500);
const fade = springFrames(400, 34, 500);
const rowSpring = springFrames(300, 24, 400);
const roll = springFrames(340, 26, 400);
const chevron = springFrames(300, 18, 500);
const leadingEdge = springFrames(620, 36, 400);
const trailingEdge = springFrames(200, 20, 400);

export function animateDropdown(panel: HTMLElement, rows: HTMLElement[], opens = true): Animation | undefined {
  if (!interfaceMotion()) return;
  const edge = panel.dataset.side === 'above' ? 'top' : 'bottom';
  const frames = settle.map((height, i) => {
    const progress = opens ? height : 1 - height;
    const inset = `${100 * (1 - unit(progress))}%`;
    return {
      clipPath: edge === 'top' ? `inset(${inset} 0 0 round var(--small-radius))` : `inset(0 0 ${inset} round var(--small-radius))`,
      transform: `scaleX(${0.9 + 0.1 * progress})`,
      opacity: unit(opens ? fade[i] : 1 - fade[i]),
    };
  });
  const animation = panel.animate(frames, { duration: opens ? 500 : 300, fill: opens ? 'none' : 'forwards' });
  if (opens) {
    const visible = panel.getBoundingClientRect();
    rows.filter(row => {
      const rect = row.getBoundingClientRect();
      return rect.height > 0 && rect.top < visible.bottom && rect.bottom > visible.top;
    }).slice(0, 8).forEach((row, index) => {
      row.animate(rowSpring.map(progress => ({
        opacity: unit(progress), translate: `0 ${(progress - 1) * (edge === 'top' ? -14 : 14)}px`,
      })), { duration: 400, delay: 50 + index * 45, fill: 'backwards' });
    });
  }
  return animation;
}

export type DropdownOption = { value: string; label: string; disabled?: boolean };

export function mountSpringSelect(
  trigger: HTMLButtonElement, label: string, options: DropdownOption[], initial: string,
  onSelect: (value: string) => void, searchable = false,
): () => void {
  let selected = initial;
  let listeners: AbortController | undefined;
  let panelAnimation: Animation | undefined;
  let indicatorAnimation: Animation | undefined;
  let highlightAnimation: Animation | undefined;
  const value = trigger.querySelector<HTMLElement>('.spring-select-value')!;
  const arrow = trigger.querySelector<SVGElement>('svg')!;
  const panel = document.createElement('div');
  panel.id = `${trigger.id}-options`;
  panel.className = 'spring-dropdown';
  panel.setAttribute('popover', 'manual');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', label);
  panel.innerHTML = `${searchable ? '<input class="text-input" type="search" placeholder="Найти язык" aria-label="Найти язык">' : ''}
    <div class="spring-dropdown-list"><span class="spring-dropdown-highlight" aria-hidden="true"></span>
      ${options.map(option => `<button type="button" class="spring-dropdown-option" data-value="${escapeHtml(option.value)}" aria-pressed="${option.value === selected}"${option.disabled ? ' disabled title="Сервис пока не подключён"' : ''}>${escapeHtml(option.label)}${icon('check')}</button>`).join('')}
    </div><p class="spring-dropdown-empty" hidden>Языки не найдены.</p>`;
  trigger.after(panel);
  hydrateIcons(panel);
  trigger.setAttribute('aria-controls', panel.id);
  const filter = panel.querySelector<HTMLInputElement>('input');
  const list = panel.querySelector<HTMLElement>('.spring-dropdown-list')!;
  const highlight = panel.querySelector<HTMLElement>('.spring-dropdown-highlight')!;
  const empty = panel.querySelector<HTMLElement>('.spring-dropdown-empty')!;
  const rows = Array.from(panel.querySelectorAll<HTMLButtonElement>('button'));
  let active: HTMLButtonElement | undefined;

  function pointAt(row?: HTMLButtonElement): void {
    const previous = active;
    if (previous === row) return;
    active = row;
    const from = highlight.offsetTop;
    const height = highlight.offsetHeight;
    highlightAnimation?.cancel();
    highlight.hidden = !row;
    if (!row) return;
    const to = row.offsetTop;
    const size = row.offsetHeight;
    highlight.style.top = `${to}px`;
    highlight.style.height = `${size}px`;
    if (!previous || !interfaceMotion()) return;
    const top = to > from ? trailingEdge : leadingEdge;
    const bottom = to > from ? leadingEdge : trailingEdge;
    highlightAnimation = highlight.animate(top.map((progress, i) => {
      const y = from + (to - from) * progress;
      return { top: `${y}px`, height: `${Math.max(0, from + height + (to + size - from - height) * bottom[i] - y)}px` };
    }), { duration: 400 });
  }

  function position(): void {
    const anchor = trigger.getBoundingClientRect();
    const viewport = trigger.closest('main')?.getBoundingClientRect();
    if (viewport && (anchor.bottom < viewport.top || anchor.top > viewport.bottom)) { close(false, false); return; }
    const below = window.innerHeight - anchor.bottom - 18;
    const above = anchor.top - 18;
    panel.style.width = `${Math.min(Math.max(anchor.width, searchable ? 270 : 232), window.innerWidth - 20)}px`;
    panel.style.maxHeight = 'min(350px, calc(100dvh - 20px))';
    const useAbove = below < panel.offsetHeight && above > below;
    panel.dataset.side = useAbove ? 'above' : 'below';
    panel.style.maxHeight = `${Math.max(0, Math.min(350, useAbove ? above : below))}px`;
    panel.style.left = `${Math.max(10, Math.min(window.innerWidth - panel.offsetWidth - 10, anchor.right - panel.offsetWidth))}px`;
    panel.style.top = `${useAbove ? anchor.top - panel.offsetHeight - 8 : anchor.bottom + 8}px`;
  }

  function indicate(open: boolean, animate: boolean): void {
    const from = getComputedStyle(arrow).transform;
    indicatorAnimation?.cancel();
    trigger.setAttribute('aria-expanded', String(open));
    if (!animate || !interfaceMotion()) return;
    const parts = from.match(/^matrix\(([^,]+),\s*([^,]+)/);
    const angle = parts ? Math.atan2(Number(parts[2]), Number(parts[1])) * 180 / Math.PI : 0;
    const start = angle < -90 ? angle + 360 : angle;
    indicatorAnimation = arrow.animate(chevron.map(progress => ({
      transform: `rotate(${start + ((open ? 180 : 0) - start) * progress}deg)`,
    })), { duration: 500 });
  }

  function close(restoreFocus: boolean, animate = true): void {
    const wasOpen = !!listeners;
    listeners?.abort();
    listeners = undefined;
    if (wasOpen) indicate(false, animate);
    if (!panel.matches(':popover-open')) return;
    if (!wasOpen && animate) return;
    if (restoreFocus) trigger.focus({ preventScroll: true });
    panel.inert = true;
    panelAnimation?.cancel();
    const closing = animate ? animateDropdown(panel, [], false) : undefined;
    panelAnimation = closing;
    if (closing) closing.onfinish = () => {
      if (panelAnimation === closing && panel.matches(':popover-open')) panel.hidePopover();
      closing.cancel();
    };
    else panel.hidePopover();
  }

  function open(): void {
    panelAnimation?.cancel();
    panel.inert = false;
    if (filter) filter.value = '';
    rows.forEach(row => { row.hidden = false; });
    empty.hidden = true;
    list.hidden = false;
    list.scrollTop = 0;
    if (!panel.matches(':popover-open')) panel.showPopover();
    indicate(true, true);
    listeners = new AbortController();
    const { signal } = listeners;
    position();
    if (signal.aborted) return;
    const current = rows.find(row => row.dataset.value === selected && !row.disabled) ?? rows.find(row => !row.disabled);
    if (current) list.scrollTop = Math.max(0, current.offsetTop - (list.clientHeight - current.offsetHeight) / 2);
    pointAt(undefined);
    pointAt(current);
    (filter ?? current)?.focus({ preventScroll: true });
    panelAnimation = animateDropdown(panel, rows);
    window.addEventListener('resize', position, { signal });
    trigger.closest('main')?.addEventListener('scroll', position, { signal, passive: true });
    document.addEventListener('pointerdown', event => {
      if (!event.composedPath().includes(panel) && !event.composedPath().includes(trigger)) close(false);
    }, { signal });
    document.addEventListener('focusin', event => {
      if (!event.composedPath().includes(panel) && !event.composedPath().includes(trigger)) close(false);
    }, { signal });
  }

  trigger.addEventListener('click', () => listeners ? close(true) : open());
  trigger.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    if (!listeners) open();
    else active?.focus();
  });
  for (const element of [panel, trigger]) element.addEventListener('keydown', event => {
    if (!(event instanceof KeyboardEvent) || event.key !== 'Escape' || !listeners) return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  });
  panel.addEventListener('keydown', event => {
    const enabled = rows.filter(row => !row.hidden && !row.disabled);
    if (!enabled.length) return;
    const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
    let next: HTMLButtonElement;
    if (event.key === 'ArrowDown') next = enabled[Math.min(enabled.length - 1, index + 1)];
    else if (event.key === 'ArrowUp') next = index < 0 ? enabled.at(-1)! : enabled[Math.max(0, index - 1)];
    else if (event.target !== filter && event.key === 'Home') next = enabled[0];
    else if (event.target !== filter && event.key === 'End') next = enabled.at(-1)!;
    else return;
    event.preventDefault();
    next.focus();
  });
  filter?.addEventListener('input', () => {
    const query = filter.value.trim().toLocaleLowerCase('ru');
    rows.forEach(row => {
      row.hidden = !row.textContent!.toLocaleLowerCase('ru').includes(query) && !row.dataset.value!.startsWith(query);
    });
    empty.hidden = rows.some(row => !row.hidden);
    list.hidden = !empty.hidden;
    list.scrollTop = 0;
    pointAt(undefined);
    pointAt(rows.find(row => !row.hidden && row.dataset.value === selected));
    position();
  });
  let valueAnimations: Animation[] = [];
  for (const row of rows) {
    row.addEventListener('pointerenter', () => { if (!row.disabled) pointAt(row); });
    row.addEventListener('focus', () => pointAt(row));
    row.addEventListener('click', () => {
      const next = row.dataset.value!;
      if (next !== selected) {
        const old = value.textContent!;
        selected = next;
        rows.forEach(option => option.setAttribute('aria-pressed', String(option === row)));
        value.textContent = row.textContent;
        trigger.setAttribute('aria-label', `${label}: ${row.textContent}`);
        onSelect(next);
        valueAnimations.forEach(animation => animation.cancel());
        if (interfaceMotion()) {
          const leaving = document.createElement('span');
          leaving.className = 'spring-select-old';
          leaving.setAttribute('aria-hidden', 'true');
          leaving.textContent = old;
          value.after(leaving);
          const incoming = value.animate(roll.map(p => ({ opacity: unit(p), translate: `0 ${(1 - p) * 20}px` })), 400);
          const outgoing = leaving.animate(roll.map(p => ({ opacity: unit(1 - p), translate: `0 ${-p * 20}px` })), 400);
          const remove = () => leaving.remove();
          outgoing.onfinish = remove;
          outgoing.oncancel = remove;
          valueAnimations = [incoming, outgoing];
        }
      }
      close(true);
    });
  }
  return () => close(false, false);
}

export function mountSpringSwitch(input: HTMLInputElement): void {
  const track = input.parentElement!;
  const position = springState(Number(input.checked));
  const stretch = springState(0);
  let frame = 0;
  const reset = () => {
    position.position = Number(input.checked);
    position.velocity = stretch.velocity = stretch.position = 0;
    track.removeAttribute('style');
  };
  input.addEventListener('change', () => {
    cancelAnimationFrame(frame);
    if (systemReducedMotion()) { reset(); return; }
    const target = Number(input.checked);
    stretch.velocity = 60;
    let last = performance.now();
    const tick = (now: number) => {
      if (!input.isConnected || systemReducedMotion()) { reset(); return; }
      const dt = Math.max(0, now - last) / 1000;
      last = now;
      const p = stepSpring(position, target, 320, 18, dt);
      const grow = unit(stepSpring(stretch, 0, 300, 20, dt)) * 10;
      track.style.setProperty('--switch-fill', `${unit(p) * 100}%`);
      track.style.setProperty('--switch-grow', `${grow}px`);
      track.style.setProperty('--switch-x', `${p * 20 - target * grow * unit(p)}px`);
      if (Math.abs(p - target) + Math.abs(position.velocity) + Math.abs(stretch.position) + Math.abs(stretch.velocity) < 0.015) reset();
      else frame = requestAnimationFrame(tick);
    };
    // Draw once during the change event to avoid flashing the CSS checked endpoint.
    tick(last);
  });
}

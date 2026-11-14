import { interfaceMotion, springFrames, unit } from './springs.ts';

// DesignBookmark Sidebar Collapse uses 260/24 for width, 300/22 for
// the chevron and 300/26 for the cascading labels.
const widthSpring = springFrames(260, 24, 500);
const arrowSpring = springFrames(300, 22, 500);
const labelSpring = springFrames(300, 26, 340);
const storageKey = 'yamusic.sidebar-collapsed';

export function mountSidebar(sidebar: HTMLElement): void {
  const shell = sidebar.parentElement!;
  const button = sidebar.querySelector<HTMLButtonElement>('.sidebar-toggle')!;
  const labels = [...sidebar.querySelectorAll<HTMLElement>('.sidebar-label')];
  let animations: Animation[] = [];
  let collapsed = false;
  try { collapsed = localStorage.getItem(storageKey) === 'true'; } catch { /* Storage is optional. */ }

  function update(): void {
    shell.classList.toggle('sidebar-collapsed', collapsed);
    const label = collapsed ? 'Развернуть боковое меню' : 'Свернуть боковое меню';
    button.setAttribute('aria-expanded', String(!collapsed));
    button.setAttribute('aria-label', label);
    button.title = label;
  }
  update();

  button.addEventListener('click', () => {
    const arrow = button.querySelector('.icon')!;
    const fromWidth = sidebar.getBoundingClientRect().width;
    const fromArrow = getComputedStyle(arrow).rotate;
    const fromLabels = labels.map(label => {
      const style = getComputedStyle(label);
      return { opacity: Number(style.opacity), translate: parseFloat(style.translate) || 0 };
    });
    animations.forEach(animation => animation.cancel());
    animations = [];
    collapsed = !collapsed;
    update();
    try { localStorage.setItem(storageKey, String(collapsed)); } catch { /* Keep the current layout. */ }
    if (!interfaceMotion()) return;
    const toWidth = sidebar.getBoundingClientRect().width;
    animations.push(shell.animate(widthSpring.map(p => ({
      '--sidebar-width': `${fromWidth + (toWidth - fromWidth) * p}px`,
    })), 500));
    const fromAngle = parseFloat(fromArrow) || 0;
    const toAngle = collapsed ? 180 : 0;
    animations.push(arrow.animate(arrowSpring.map(p => ({
      rotate: `${fromAngle + (toAngle - fromAngle) * p}deg`,
    })), 500));
    labels.forEach((label, i) => {
      const from = fromLabels[i];
      const to = collapsed ? { opacity: 0, translate: -10 } : { opacity: 1, translate: 0 };
      animations.push(label.animate(labelSpring.map(p => ({
        opacity: unit(from.opacity + (to.opacity - from.opacity) * p),
        translate: `${from.translate + (to.translate - from.translate) * p}px`,
      })), { duration: 340, delay: collapsed ? 0 : 60 + i * 40, fill: 'backwards' }));
    });
  });
}

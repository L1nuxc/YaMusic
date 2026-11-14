import { api } from './api.ts';
import { icon, hydrateIcons } from './icons.ts';
import { escapeHtml as e, safeImage } from './model.ts';
import type { Artist } from './types.ts';

let pickerSession = 0;

export async function openArtistPicker(
  dialog: HTMLDialogElement,
  show: (title: string, content: string, cls?: string) => void,
  saved: () => Promise<void>,
  toast: (text: string) => void,
): Promise<void> {
  const session = ++pickerSession;
  show('Любимые исполнители', '<div class="loading-state" role="status">Загружаем исполнителей…</div>', 'artist-picker-dialog');
  const active = () => session === pickerSession && dialog.open && dialog.classList.contains('artist-picker-dialog');

  try {
    const favorites = await api.favoriteArtists();
    if (!active()) return;
    const selected = new Map(favorites.artists.map(artist => [artist.id, artist]));
    const known = new Map(selected);
    const relatedCache = new Map<number, Artist[]>();
    let list: Artist[] = [];
    let query = '';
    let nextIndex: number | null = 0;
    let pageRequest: AbortController | undefined;
    let relatedRequest: AbortController | undefined;
    let timer = 0;
    let saving = false;
    let focusedArtist: Artist | undefined;
    let related: Artist[] = [];
    let relatedMessage = '';

    dialog.querySelector('.loading-state')!.outerHTML = `<form id="artist-picker-form">
      <label class="sr-only" for="artist-picker-search">Поиск исполнителя</label>
      <div class="search-form artist-picker-search">${icon('search')}<input id="artist-picker-search" type="search" placeholder="Имя исполнителя" autocomplete="off" maxlength="200"/></div>
      <div class="chosen-artists" aria-label="Выбранные исполнители"></div>
      <section class="artist-picker-related" hidden></section>
      <div class="artist-picker-grid"></div>
      <p class="muted artist-picker-status" role="status"></p>
      <button class="secondary-button artist-load-more" type="button" hidden>Загрузить ещё</button>
      <div class="artist-picker-sentinel" aria-hidden="true"></div>
      <div class="artist-picker-footer"><span class="muted" data-count></span><button class="primary-button" type="submit">Сохранить ${icon('check')}</button></div>
    </form>`;

    const form = dialog.querySelector<HTMLFormElement>('#artist-picker-form')!;
    const input = form.querySelector<HTMLInputElement>('input')!;
    const grid = form.querySelector<HTMLElement>('.artist-picker-grid')!;
    const relatedBox = form.querySelector<HTMLElement>('.artist-picker-related')!;
    const status = form.querySelector<HTMLElement>('.artist-picker-status')!;
    const more = form.querySelector<HTMLButtonElement>('.artist-load-more')!;
    const sentinel = form.querySelector<HTMLElement>('.artist-picker-sentinel')!;

    function choice(artist: Artist, cls = ''): string {
      const image = safeImage(artist.picture_url);
      const chosen = selected.has(artist.id);
      return `<button type="button" class="artist-choice ${cls}${chosen ? ' selected' : ''}" data-artist-id="${artist.id}" aria-pressed="${chosen}">
        <span class="artist-choice-image">${image ? `<img src="${e(image)}" alt="" loading="lazy" referrerpolicy="no-referrer"/>` : icon('circle-user-round')}<span class="artist-choice-check">${icon('check')}</span></span>
        <strong>${e(artist.name)}</strong>
      </button>`;
    }

    function renderSelection(): void {
      form.querySelector('[data-count]')!.textContent = `Выбрано ${selected.size} из 50`;
      const chips = form.querySelector<HTMLElement>('.chosen-artists')!;
      chips.innerHTML = [...selected.values()].map(artist =>
        `<button type="button" class="chip selected" data-artist-id="${artist.id}" aria-label="Убрать ${e(artist.name)}">${e(artist.name)} ${icon('x')}</button>`
      ).join('');
      for (const button of grid.querySelectorAll<HTMLButtonElement>('[data-artist-id]')) {
        const chosen = selected.has(Number(button.dataset.artistId));
        button.classList.toggle('selected', chosen);
        button.setAttribute('aria-pressed', String(chosen));
      }
      hydrateIcons(chips);
    }

    function renderRelated(): void {
      relatedBox.hidden = !focusedArtist;
      if (!focusedArtist) return;
      relatedBox.innerHTML = `<h3>Похожие исполнители</h3><div class="artist-neighborhood${related.length ? '' : ' artist-neighborhood-empty'}">
        ${choice(focusedArtist, 'artist-neighborhood-center')}
        ${related.map(artist => choice(artist, 'artist-neighborhood-peer')).join('')}
      </div>${relatedMessage ? `<p class="muted" role="status">${e(relatedMessage)}</p>` : ''}`;
      hydrateIcons(relatedBox);
    }

    function showNeighbors(artist: Artist): void {
      focusedArtist = artist;
      relatedRequest?.abort();
      const cached = relatedCache.get(artist.id);
      related = cached ?? [];
      relatedMessage = cached ? (cached.length ? '' : 'Похожие исполнители пока не найдены.') : 'Ищем похожих исполнителей…';
      renderRelated();
      if (cached) return;

      const controller = new AbortController();
      relatedRequest = controller;
      void api.relatedArtists(artist.id, controller.signal).then(({ artists }) => {
        if (!active() || controller.signal.aborted) return;
        artists.forEach(item => known.set(item.id, item));
        relatedCache.set(artist.id, artists);
        related = artists;
        relatedMessage = artists.length ? '' : 'Похожие исполнители пока не найдены.';
        renderRelated();
      }).catch(() => {
        if (!active() || controller.signal.aborted) return;
        relatedMessage = 'Не удалось загрузить похожих исполнителей.';
        renderRelated();
      });
    }

    async function loadPage(): Promise<void> {
      if (!active() || pageRequest || nextIndex === null) return;
      const index = nextIndex;
      const controller = new AbortController();
      pageRequest = controller;
      observer.unobserve(sentinel);
      more.disabled = true;
      status.textContent = 'Загружаем исполнителей…';

      try {
        const page = query
          ? await api.search(query, 'artist', index, controller.signal).then(data => ({
              artists: data.artists,
              next_index: data.artists.length > 0 && index + 24 < data.total ? index + 24 : null,
            }))
          : await api.artistSuggestions(index, controller.signal);
        if (!active() || controller.signal.aborted) return;
        const seen = new Set(list.map(artist => artist.id));
        const fresh = page.artists.filter(artist => !seen.has(artist.id) && seen.add(artist.id));
        fresh.forEach(artist => known.set(artist.id, artist));
        list.push(...fresh);
        grid.insertAdjacentHTML('beforeend', fresh.map(artist => choice(artist)).join(''));
        hydrateIcons(grid);
        nextIndex = page.next_index;
        status.textContent = list.length ? '' : (query ? 'Ничего не найдено.' : 'Найдите исполнителя по имени.');
        more.hidden = nextIndex === null;
        if (nextIndex !== null) observer.observe(sentinel);
      } catch (error) {
        if (!active() || controller.signal.aborted) return;
        status.textContent = error instanceof Error ? error.message : 'Не удалось загрузить исполнителей.';
        more.hidden = false;
      } finally {
        if (pageRequest === controller) {
          pageRequest = undefined;
          more.disabled = false;
        }
      }
    }

    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadPage();
    }, { root: dialog, rootMargin: '0px 0px 120px' });

    more.addEventListener('click', () => void loadPage());
    input.addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault(); });
    input.addEventListener('input', () => {
      clearTimeout(timer);
      observer.unobserve(sentinel);
      pageRequest?.abort();
      pageRequest = undefined;
      query = input.value.trim();
      list = [];
      nextIndex = 0;
      grid.replaceChildren();
      more.hidden = true;
      status.textContent = 'Загружаем исполнителей…';
      timer = window.setTimeout(() => void loadPage(), query ? 300 : 0);
    });

    form.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-artist-id]');
      if (!button || saving) return;
      const id = Number(button.dataset.artistId);
      const artist = known.get(id);
      if (!artist) return;
      if (selected.has(id)) selected.delete(id);
      else if (selected.size < 50) selected.set(id, artist);
      else { toast('Можно выбрать до 50 исполнителей'); return; }

      renderSelection();
      const fromRelated = relatedBox.contains(button);
      if (selected.has(id) || fromRelated) showNeighbors(artist);
      else renderRelated();
      if (selected.has(id)) relatedBox.scrollIntoView({ block: 'nearest' });
      if (fromRelated) relatedBox.querySelector<HTMLButtonElement>('.artist-neighborhood-center')?.focus({ preventScroll: true });
      else if (!button.isConnected) input.focus({ preventScroll: true });
    });

    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (saving) return;
      saving = true;
      const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
      submit.disabled = true;
      submit.textContent = 'Сохраняем…';
      try {
        await api.saveFavoriteArtists([...selected.keys()]);
        if (active()) dialog.close();
        await saved();
        toast('Любимые исполнители сохранены');
      } catch (error) {
        toast(error instanceof Error ? error.message : 'Не удалось сохранить выбор');
      } finally {
        saving = false;
        if (form.isConnected) { submit.disabled = false; submit.textContent = 'Сохранить'; }
      }
    });

    const closed = () => {
      if (active() && form.isConnected) return;
      clearTimeout(timer);
      pageRequest?.abort();
      relatedRequest?.abort();
      observer.disconnect();
      dialog.removeEventListener('close', closed);
    };
    dialog.addEventListener('close', closed);
    renderSelection();
    hydrateIcons(form);
    input.focus();
    void loadPage();
  } catch (error) {
    if (active()) dialog.querySelector('.loading-state')!.textContent = error instanceof Error ? error.message : 'Не удалось открыть исполнителей';
  }
}

# Round 3: Quiet Graphite screen studies

Generated using built-in image_gen. Static UI mockups only; no application implementation. All five show desktop/web and mobile side by side.

## User direction

Base: round-2 B Quiet Graphite. Consistent soft corners across surfaces, including desktop player. Use the more compact mobile capsule navigation of round-2 A. Center volume controls vertically inside the complete desktop player. Combine desktop settings and account in one long sidebar-bottom control, with a small account button nested at its right. Theme choice appears only in settings. Continue using restrained monochrome and unified outline icons.

## Shared prompt

Use case: ui-mockup. High fidelity UI design exploration for the SAME music service across five product screens. Produce ONE landscape board with desktop/web application on LEFT and portrait mobile on RIGHT, both large and legible, straight-on, fully visible, no perspective/desk/hands. Use supplied references, not a new visual concept.

REFERENCE 1 (B Quiet Graphite) is the APPROVED DESIGN SYSTEM: neutral dark graphite, subtle gray gradients, white and gray text, beautiful restrained frosted glass, minimal atmospheric lines, original rounded outline icon set. Keep this exact palette, typography, spacing rhythm, sidebar width, icon treatment and quiet mood. Reference 2 (A Balanced Smoke) is ONLY for its COMPACT MOBILE BOTTOM NAVIGATION: a slim floating rounded capsule; not the taller B navigation. THREE equal tabs: "Главная", "Поиск", "Медиатека". Small outline icons above tiny labels, snug vertical padding, subtly refractive selected glass lens contained within capsule.

UNIFIED CORNERS: user prioritizes consistent soft rounding throughout. All medium/large surfaces use the SAME gentle 24px apparent corner radius: content cards, inputs, settings groups, queue, player, sidebar selection. Use corresponding scaled radius on phone; all album artwork consistently rounded. Only transport buttons and tiny avatars are circles; bottom nav has rounded capsule ends per approved reference. The DESKTOP BOTTOM PLAYER must ALSO have generous consistent 24px corners, not near-square corners.

SHARED DESKTOP SHELL: quiet graphite left sidebar, small waveform logo, navigation "Главная", "Поиск", "Медиатека", corresponding selected page. At sidebar bottom ONE SINGLE long rounded "Настройки" control with gear and label; a SMALL account/avatar button is nested INSIDE the far-right end of this same control. Do NOT split profile and settings into two freestanding buttons. No sun/moon controls outside settings.
Persistent desktop bottom player: left small artwork, "Туман" / "Север", heart; center shuffle, previous, pause, next, repeat with long TRACK PROGRESS BELOW; right elapsed/total time and volume group. CRITICAL: speaker icon, VOLUME SLIDER TRACK, and volume THUMB are precisely aligned on the HORIZONTAL LINE THROUGH THE VERTICAL MIDPOINT OF THE ENTIRE PLAYER CONTAINER, equal visual space above/below the volume group. NOT high in the player. Progress timeline has a separate lower baseline only in center zone. All controls optically centered, no diagonal drifting controls.
Shared MOBILE shell on normal pages: short page heading, small profile access, compact mini player ABOVE separate slim nav with safe-area gap. Mini player: artwork, short title/artist, heart, pause,next, hairline progress at bottom, no big slider or time clutter. No verbose text, no squeezing desktop columns onto phone. Theme switch visible ONLY inside the actual settings page. Full-screen player screen may intentionally hide mini player and bottom nav.

All UI uses correct short Russian text, clean hierarchy, equal icon stroke weight, accessible high contrast, quiet mostly monochrome original album art with occasional muted color. Screens must look like the same polished app, not a collage of different apps. No code, no technical architecture labels, no watermark. Short board heading only. Show realistic useful content with generous breathing room and no overlapping floating bars.

## 01 — Поиск

File: 01-search.png

BOARD HEADING "01 — Поиск". Show search results on both platforms. Search input contains "Север". Desktop "Поиск" sidebar selected. At top large search field, then compact filter tabs "Всё", "Треки", "Альбомы", "Исполнители", "Плейлисты". Clear artist result with small circular monochrome portrait and name "Север", a tidy track list including "Туман", "Линии", "Рассвет" with artist, duration, heart and overflow. Beneath, a small row of rounded album cards. Avoid dense tables; desktop uses space elegantly. Phone: compact search field, horizontally arranged filter chips with "Всё" active, one artist result then 3–4 clean track rows, one partial album row if room. Same music mini player above compact nav; "Поиск" active. No keyboard shown, no gigantic wave hero, no extra explanatory paragraphs.

## 02 — Медиатека

File: 02-library.png

BOARD HEADING "02 — Медиатека". Desktop "Медиатека" sidebar selected. Heading with small "Импорт" action and plus "Плейлист" action. Filter chips "Всё", "Плейлисты", "Альбомы", "Исполнители", "Скачанное". A clearly recognizable softly rounded "Мне нравится" collection tile with white outline heart and small track count, alongside consistent cover grid of personal playlists titled "Ночной маршрут", "Для работы", "Любимое", "Тихий вечер". Lower section "Недавно добавлено" with 2 concise track rows. Keep style exactly B, restrained glass and ample space. Phone: heading "Медиатека", small plus and import icon, horizontally scrolling compact filters, 2-column grid of favorite collection and 3 playlists with short titles, at most two small recent rows. No desktop right queue. Mini player and compact mobile nav, "Медиатека" active. Downloads visibly accessible as a filter, importing is discoverable without a giant banner.

## 03 — Настройки

File: 03-settings.png

BOARD HEADING "03 — Настройки". Show actual settings page with theme control HERE ONLY. Desktop bottom combined sidebar "Настройки" button is selected, nested small avatar at its right. Main heading "Настройки". Top compact profile summary with avatar, name "Алексей", small "Telegram подключён", no login secrets. Well-spaced rounded settings groups, simple descriptive rows without technical jargon. Group "Оформление": row "Тема" with two segmented options "Тёмная" selected and "Светлая", then "Анимации" switch on. Group "Воспроизведение": "Плавный переход" slider labeled "4 сек" with small endpoints "0" and "8", row "Версии без цензуры" toggle on. Group "Скачанное": "Память устройства" / "2,4 ГБ" and small "Управлять" action. Profile is a summary, not a giant card. Desktop bottom player remains. Phone: scrollable full-width grouped rows for same controls, compact profile summary, theme options, animation switch, crossfade slider, censorship preference and storage. Keep labels short and aligned, switch positions consistent. Mini player + compact bottom navigation remain, no fourth settings nav tab. No sun/moon theme widget elsewhere, no developer settings, no server quotas or API keys.

## 04 — Главная ниже

File: 04-home-scrolled.png

BOARD HEADING "04 — Главная ниже". This is the HOME PAGE SCROLLED DOWN, wave hero above viewport and NOT repeated. Desktop "Главная" selected. Show upper edge of "Нейро-волна" input near top if natural, then thoughtfully spaced personal discovery sections "Недавно слушали", "Для вашего настроения", "Новые открытия". Use 4–5 cards per desktop horizontal rail, same round cover art geometry as B, short labels "Тихий вечер", "Ночной маршрут", "Фокус", "Без слов"; first rail has albums or playlists, next has a few artist cards or concise tracks. Showcase actual scroll continuation, not a separate dashboard. No feature-statistic widgets or marketing copy. Mobile: same content naturally stacked with 2.5 visible cards in horizontal rails; "Недавно слушали", then "Для вашего настроения", then a small "Новые открытия" heading and 1–2 tracks if space. Keep screen breathable, very little text. Persistent desktop player and compact mobile player/nav remain pinned; content continues underneath safely without overlap. Restrained static gray backdrop, do not repeat smoky hero.

## 05 — Плеер и текст

File: 05-player-lyrics.png

BOARD HEADING "05 — Плеер и текст". Expanded listening and lyrics screen in approved B style. Desktop: preserve sidebar and corrected rounded bottom player. Main content split into LEFT medium-large square album artwork (monochrome misty mountains), title "Туман", artist "Север", heart/download/queue icons, and RIGHT synchronized lyrics with active line bright white, adjacent lines light gray, distant lines softly dimmed. Small tab/toggle "Текст" and "Перевод" near lyrics. Use ONLY these original invented lyric lines: "Город тихо засыпает", "Свет растворится вдалеке", "Мы идём навстречу ветру", "Оставляя след в реке". No real song lyrics. No duplicate large transport strip in middle; playback lives in bottom player, volume centered at entire player midpoint.
Phone: a single FULL-SCREEN PLAYER with compact down-chevron at top to close, small "Текст" heading and overflow; smaller rounded album cover + "Туман" / "Север" at top, synchronized text as central focus with active "Мы идём навстречу ветру" bright, other invented lines softly dim. "Перевод" small understated toggle. Near bottom a real seek bar with "1:24" and "3:56", clean shuffle/previous/pause/next/repeat controls, heart/download/queue shortcuts. This full-screen state deliberately HIDES mini-player and bottom navigation to avoid duplicates, while keeping the same design system. No new accent colors, no excessive smoky background. Indicate clickable lyrics visually through highlight only, no instructions.

## References

D:\Projects\YaMusic\design\concepts\round-2\B-quiet-graphite.png
D:\Projects\YaMusic\design\concepts\round-2\A-balanced-smoke.png

## Review notes

Concept images explore visual layout; exact spacing and motion remain for later design refinement. Example names, counts, device storage, and lyrics are invented placeholders, not user account data. The settings screen is one viewport of settings, not a complete final feature inventory. Mobile full-screen lyrics intentionally hides normal bottom navigation and mini player.

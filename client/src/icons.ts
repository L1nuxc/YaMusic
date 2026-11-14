import { createIcons, AudioLines, House, Search, Library, Settings2, CircleUserRound,
  Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Repeat1, Heart,
  Volume2, VolumeX, ListMusic, Mic2, ChevronDown, ChevronLeft, ChevronRight,
  ArrowRight, X, Plus, Ellipsis, Sparkles, Check, Disc3, Download,
  Music2, Sun, Moon, Palette, Waves, Import, Trash2, ListPlus, Info, Send,
  CircleAlert, RefreshCw, CheckCheck, CirclePlay, ArrowUpRight, ThumbsDown, LocateFixed } from 'lucide';

const icons = { AudioLines, House, Search, Library, Settings2, CircleUserRound, Play, Pause,
  SkipBack, SkipForward, Shuffle, Repeat, Repeat1, Heart, Volume2, VolumeX, ListMusic,
  Mic2, ChevronDown, ChevronLeft, ChevronRight, ArrowRight, X, Plus, Ellipsis, Sparkles,
  Check, Disc3, Download, Music2, Sun, Moon, Palette, Waves, Import, Trash2, ListPlus,
  Info, Send, CircleAlert, RefreshCw, CheckCheck, CirclePlay, ArrowUpRight, ThumbsDown, LocateFixed };
export function icon(name: string, extra = ''): string {
  return `<i data-lucide="${name}" class="icon ${extra}" aria-hidden="true"></i>`;
}
export function hydrateIcons(root: HTMLElement | Document = document): void {
  createIcons({ icons, root, attrs: { 'stroke-width': 1.65, 'aria-hidden': 'true' } });
}

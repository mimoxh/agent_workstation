import { cn } from '@/lib/utils';

// 单一自绘线性图标集；图标只做辅助识别，旁边总有文字
const PATHS = {
  home: 'M4 11 12 4l8 7v9h-5v-6H9v6H4z',
  inbox: 'M4 13h4.5l1.5 3h4l1.5-3H20M6 5h12l2 8v6H4v-6z',
  ledger: 'M6 4h12v16H6zM9.5 9h5M9.5 13h5M9.5 17h2.5',
  board: 'M4 5h5v7H4zM4 15h5v4H4zM11 5h5v10h-5zM18 5h2v5h-2z',
  table: 'M4 5h16v14H4zM4 10h16M4 15h16M10 5v14',
  diff: 'M12 5v8M8 9h8M8 19h8',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  decision: 'M12 4 20 12 12 20 4 12z',
  files: 'M4 6h6l2 2h8v11H4z',
  preview: 'M4 5h16v14H4zM4 9h16',
  book: 'M6 4h10a3 3 0 0 1 3 3v13H9a3 3 0 0 1-3-3zM6 17a3 3 0 0 1 3-3h10',
  people: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3.5 20a5.5 5.5 0 0 1 11 0M16 5.5a3 3 0 0 1 0 5.5M17.5 14.5a5 5 0 0 1 3 5.5',
  gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8',
  plug: 'M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4',
  plus: 'M12 5v14M5 12h14',
  chev: 'm7 10 5 5 5-5',
  menu: 'M4 7h16M4 12h16M4 17h16',
  search: 'M11 5a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM20 20l-4.5-4.5',
  flag: 'M6 21V4M6 4h11l-2.5 4L17 12H6',
  clock: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8v4l3 2',
  hash: 'M9 4 7 20M17 4l-2 16M4 9h16M3 15h16',
  hand: 'M8 13V6a1.5 1.5 0 0 1 3 0v5M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6a1.5 1.5 0 0 1 3 0v7a6 6 0 0 1-6 6h-.5a5.5 5.5 0 0 1-4.2-2L4 14a1.5 1.5 0 0 1 2.2-2L8 14',
  terminal: 'M4 5h16v14H4zM8 10l3 2-3 2M13 15h3',
  bolt: 'M13 3 5 14h6l-1 7 8-11h-6z',
  doc: 'M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 16h5',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0',
  robot: 'M7 8h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zM12 4v4M9.5 13h.01M14.5 13h.01',
  chat: 'M5 5h14v10H9l-4 4z',
  person: 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4.5 21a7.5 7.5 0 0 1 15 0',
  status: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 4v16',
  stage: 'M4 7h10M4 12h14M4 17h8',
  coin: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM9.5 9.5h4a1.5 1.5 0 0 1 0 3h-3a1.5 1.5 0 0 0 0 3h4M12 7.5V9M12 15.5V17',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  branch: 'M7 4v12M7 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM17 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM17 8c0 5-10 3-10 8',
  palette: 'M12 3.5a8.5 8.5 0 1 0 0 17c1.3 0 2-.8 2-1.8 0-1.5-1.2-1.7-1.2-3 0-.9.7-1.5 1.7-1.5h2.3c2.1 0 3.7-1.5 3.7-3.7 0-3.9-3.8-7-8.5-7zM8 11.5h.01M10.5 8h.01M15 8.5h.01',
  sliders: 'M5 7h9M18 7h1M5 17h1M10 17h9M16 5v4M8 15v4',
  info: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM12 11v5M12 8h.01',
  flask: 'M10 3h4M11 3v6L5.5 18a1.5 1.5 0 0 0 1.3 2.3h10.4a1.5 1.5 0 0 0 1.3-2.3L13 9V3M8 15h8',
  pulse: 'M3 12h4l2.5-6 4 12 2.5-6H21',
  play: 'M7 5v14l11-7z',
  list: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  bug: 'M9 8a3 3 0 0 1 6 0M8 10h8v5a4 4 0 0 1-8 0zM12 10v9M4 9l4 2M20 9l-4 2M4 19l4-2M20 19l-4-2M3.5 14H8M16 14h4.5',
  wave: 'M3 12c2-5 4-5 6 0s4 5 6 0 4-5 6 0',
  shield: 'M12 3.5 5 6v5.5c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn('size-4 shrink-0 fill-none stroke-current', className)} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d={PATHS[name]} />
    </svg>
  );
}

// 面板类型 → 图标；插件新增的类型回落到文档图标
export const PANEL_ICON: Record<string, IconName> = {
  board: 'board',
  diff: 'diff',
  tree: 'files',
  table: 'table',
  timeline: 'clock',
  knowledge: 'book',
  preview: 'preview',
  canvas: 'palette',
  tokens: 'sliders',
  gantt: 'stage',
};

const QUALITY_ICON: Record<string, IconName> = { overview: 'pulse', runs: 'play', cases: 'list', plans: 'flag', bugs: 'bug', flaky: 'wave', coverage: 'shield' };

export const panelIcon = (type: string | null | undefined, entity?: string | null, panelId?: string | null): IconName =>
  type === 'quality' ? (QUALITY_ICON[panelId ?? ''] ?? 'flask') : entity === 'TestRun' ? 'check' : entity === 'ADR' ? 'decision' : entity === 'Milestone' ? 'flag' : entity === 'Risk' ? 'hand' : PANEL_ICON[type ?? ''] ?? 'doc';

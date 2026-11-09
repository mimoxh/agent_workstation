import { Link, useParams, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { InboxEntry } from '@/components/inbox/InboxEntry';
import { useInboxNotify } from '@/components/inbox/notify';
import { Popover } from '@/components/ui/feedback';
import { Icon, panelIcon, type IconName } from '@/components/ui/icons';
import { tokens } from '@/lib/format';
import { useLiveConnected } from '@/lib/live';
import { useAllInbox, useModels, useOverview, useProject, useProjects, useTask, useWorkstation, useWsTasks, type ProjectDetail, type WsNode } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { homeBlock } from '@/components/workstation/home';
import { CommandPalette } from './CommandPalette';
import { MountDialog, NewProjectDialog } from './Dialogs';

// 控制台看的是全部项目；顶栏标签跟随「当前项目」，切项目时记住它
const PROJECT_KEY = 'aw.project';
const readProject = () => {
  try {
    return localStorage.getItem(PROJECT_KEY);
  } catch {
    return null;
  }
};
const rememberProject = (id: string) => {
  try {
    localStorage.setItem(PROJECT_KEY, id);
  } catch {
    /* 存储不可用时只影响本次会话 */
  }
};

export function useCurrentProjectId() {
  const projects = useProjects();
  const list = projects.data ?? [];
  const saved = readProject();
  return list.find((p) => p.id === saved)?.id ?? list[0]?.id;
}

// 工作台树按深度优先平铺成标签，子台带上父台名
export function flatWorkstations(project: ProjectDetail) {
  const out: { ws: WsNode; parent: string | null }[] = [];
  const walk = (parentId: string | null, parentName: string | null) => {
    for (const w of project.workstations.filter((x) => x.parentId === parentId)) {
      out.push({ ws: w, parent: parentName });
      walk(w.id, parentId === null ? null : w.name);
    }
  };
  walk(null, null);
  return out;
}

const wsIcon = (pluginId: string | null | undefined): IconName => (pluginId === 'pm' ? 'flag' : pluginId === 'dev' ? 'terminal' : pluginId === 'design' ? 'palette' : pluginId === 'qa' ? 'flask' : 'doc');

function LiveDot() {
  const live = useLiveConnected();
  return (
    <span className="flex items-center gap-1.5 px-1.5 text-xs text-muted max-sm:px-1" title={live ? '实时同步中' : '实时连接已断开，正在重连'} data-testid="live-status">
      <i className={cn('size-1.5 rounded-full', live ? 'bg-ok' : 'animate-pulse-soft bg-bad')} />
      <span className="max-sm:sr-only">{live ? '实时' : '重连中'}</span>
    </span>
  );
}

function InboxButton({ projectId }: { projectId: string }) {
  const inbox = useAllInbox();
  const items = inbox.data ?? [];
  useInboxNotify(inbox.data);
  return (
    <Popover
      className="w-96"
      trigger={(open, toggle) => (
        <button type="button" aria-expanded={open} aria-label={`待处理 ${items.length}`} onClick={toggle} data-testid="inbox-button" className="relative grid size-7 place-items-center rounded-pill text-muted hover:bg-hover hover:text-ink">
          <Icon name="bell" />
          {items.length > 0 && <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-accent-tag px-1 text-[10px] font-semibold text-accent-tag-ink">{items.length}</span>}
        </button>
      )}
    >
      {(close) => (
        <>
          <p className="px-2 py-1 text-sm text-muted">{items.length > 0 ? `${items.length} 条需要你` : '没有待处理项'}</p>
          <div className="max-h-[60vh] overflow-y-auto">
            {items.slice(0, 6).map((i) => <InboxEntry key={i.id} item={i} projectId={i.projectId ?? projectId} compact />)}
          </div>
          <Link to="/inbox" onClick={close} className="block rounded-[4px] px-2 py-1.5 text-sm text-ink-2 hover:bg-hover">
            打开收件箱
          </Link>
        </>
      )}
    </Popover>
  );
}

function ProjectSwitcher({ current }: { current: ProjectDetail | undefined }) {
  const projects = useProjects();
  const [creating, setCreating] = useState(false);
  return (
    <>
      <Popover
        align="left"
        className="w-72"
        trigger={(open, toggle) => (
          <button type="button" aria-expanded={open} aria-haspopup="menu" onClick={toggle} data-testid="project-switcher" className="flex h-8 max-w-60 shrink-0 items-center gap-2 rounded-pill px-1.5 font-semibold text-ink hover:bg-hover max-sm:max-w-28">
            <span aria-hidden className="grid size-[22px] shrink-0 place-items-center rounded-[4px] bg-primary text-xs text-primary-ink">{(current?.name ?? 'A').slice(0, 1).toUpperCase()}</span>
            <span className="truncate text-sm">{current?.name ?? '选择项目'}</span>
            <Icon name="chev" className="size-3 text-faint" />
          </button>
        )}
      >
        {(close) => (
          <div role="menu" aria-label="切换项目">
            <p className="px-2 pb-1.5 pt-1 text-xs text-muted">切换项目后，顶栏标签换成该项目的工作台</p>
            {(projects.data ?? []).map((p) => (
              <Link
                key={p.id}
                role="menuitem"
                to="/projects/$projectId"
                params={{ projectId: p.id }}
                onClick={() => { rememberProject(p.id); close(); }}
                className={cn('flex items-center gap-2.5 rounded-[4px] px-2 py-1.5 hover:bg-hover', p.id === current?.id && 'bg-hover')}
              >
                <span aria-hidden className="grid size-[22px] shrink-0 place-items-center rounded-[4px] bg-tag text-xs font-semibold text-tag-ink">{p.name.slice(0, 1).toUpperCase()}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink">{p.name}</span>
                  <span className="block text-xs text-muted">{p.workstationCount} 个工作台</span>
                </span>
                {p.inboxOpen > 0 && <span className="rounded-full bg-accent-tag px-1.5 text-[11px] font-semibold text-accent-tag-ink">{p.inboxOpen}</span>}
              </Link>
            ))}
            <div className="my-1 h-px bg-rule" />
            <button type="button" role="menuitem" onClick={() => { close(); setCreating(true); }} className="flex w-full items-center gap-2.5 rounded-[4px] px-2 py-1.5 text-sm text-ink-2 hover:bg-hover">
              <Icon name="plus" className="text-muted" />新建项目
            </button>
          </div>
        )}
      </Popover>
      {creating && <NewProjectDialog onClose={() => setCreating(false)} />}
    </>
  );
}

const tabClass = (on: boolean) =>
  cn(
    'relative flex shrink-0 items-center gap-1.5 whitespace-nowrap px-2.5 text-sm transition-colors duration-150 after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:bg-ink',
    on ? 'font-medium text-ink after:opacity-100' : 'text-muted after:opacity-0 hover:text-ink',
  );

function WsTabs({ project, active }: { project: ProjectDetail; active: string | undefined }) {
  const overview = useOverview(project.id);
  return (
    <>
      {flatWorkstations(project).map(({ ws, parent }) => {
        const stat = overview.data?.workstations.find((w) => w.id === ws.id);
        const attention = (stat?.tasks.blocked ?? 0) + (stat?.pendingReviews ?? 0);
        return (
          <Link key={ws.id} role="tab" aria-selected={active === ws.id} to="/projects/$projectId/ws/$wsId" params={{ projectId: project.id, wsId: ws.id }} data-testid={`ws-link-${ws.name}`} className={tabClass(active === ws.id)}>
            <Icon name={wsIcon(ws.pluginId)} className="size-[15px]" />
            {parent && <span className="text-faint">{parent} /</span>}
            {ws.name}
            {attention > 0 ? (
              <span className="rounded-full bg-accent-tag px-1.5 text-[11px] font-semibold text-accent-tag-ink" aria-label={`${attention} 件待你`}>{attention}</span>
            ) : stat?.running ? (
              <i className="size-1.5 rounded-full bg-cool" aria-label={`${stat.running} 个在跑`} />
            ) : null}
          </Link>
        );
      })}
    </>
  );
}

function ProjectMeta({ project }: { project: ProjectDetail }) {
  const overview = useOverview(project.id);
  const o = overview.data;
  return (
    <>
      {!!o?.runs.running && (
        <Link to="/projects/$projectId/runs" params={{ projectId: project.id }} className="whitespace-nowrap px-1.5 text-xs text-cool hover:underline">{o.runs.running} 个在跑</Link>
      )}
      {o?.budget?.tokens && (
        <Link to="/projects/$projectId/runs" params={{ projectId: project.id }} className="whitespace-nowrap px-1.5 text-xs text-muted hover:text-ink" data-testid="budget-left">
          预算余 {tokens(Math.max(0, o.budget.tokens - o.tokens))}
        </Link>
      )}
    </>
  );
}

function TopBar({ project, activeWs, onConsole, onMenu, onMount, onPalette }: { project: ProjectDetail | undefined; activeWs: string | undefined; onConsole: boolean; onMenu: () => void; onMount: () => void; onPalette: () => void }) {
  const inbox = useAllInbox();
  const need = inbox.data?.length ?? 0;
  const navRef = useRef<HTMLElement>(null);
  // 窄屏标签放不下时，把当前标签滚进视野
  useEffect(() => {
    const nav = navRef.current;
    const cur = nav?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (nav && cur) nav.scrollLeft = Math.max(0, cur.offsetLeft - nav.offsetLeft - 32);
  }, [activeWs, onConsole, project?.workstations.length]);
  return (
    <header className="flex h-11 shrink-0 items-stretch gap-1 border-b border-rule bg-paper px-2">
      <button type="button" className="grid w-8 place-items-center self-center rounded-pill text-muted hover:bg-hover md:hidden" aria-label="打开侧栏" onClick={onMenu}><Icon name="menu" /></button>
      <div className="flex items-center"><ProjectSwitcher current={project} /></div>
      <nav ref={navRef} className="ml-1 flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none]" role="tablist" aria-label="工作台">
        <Link role="tab" aria-selected={onConsole} to="/" className={tabClass(onConsole)} data-testid="console-tab">
          <Icon name="home" className="size-[15px]" />控制台
          {need > 0 && <span className="rounded-full bg-accent-tag px-1.5 text-[11px] font-semibold text-accent-tag-ink">{need}</span>}
        </Link>
        {project && (
          <>
            <span aria-hidden className="mx-1 my-3 w-px shrink-0 bg-rule-2" />
            <WsTabs project={project} active={activeWs} />
            <button type="button" onClick={onMount} aria-label="挂载工作台" title="挂载工作台" data-testid="mount-button" className="ml-0.5 grid size-7 shrink-0 place-items-center self-center rounded-pill text-faint hover:bg-hover hover:text-ink">
              <Icon name="plus" />
            </button>
          </>
        )}
      </nav>
      <div className="flex shrink-0 items-center gap-1 pl-2">
        {project && <span className="hidden items-center lg:flex"><ProjectMeta project={project} /></span>}
        <LiveDot />
        {project && <InboxButton projectId={project.id} />}
        <button type="button" onClick={onPalette} disabled={!project} className="hidden h-7 items-center gap-2 rounded-pill px-2 text-sm text-muted hover:bg-hover hover:text-ink sm:flex" data-testid="command-button">
          <Icon name="search" />跳转 <kbd className="text-xs text-faint">Ctrl K</kbd>
        </button>
        <Link to="/settings" className="grid size-7 place-items-center rounded-pill text-muted hover:bg-hover hover:text-ink max-sm:hidden" aria-label="设置" title="设置" data-testid="settings-link"><Icon name="gear" /></Link>
        <span className="ml-1 grid size-7 place-items-center rounded-full bg-accent-tag text-xs font-semibold text-accent-tag-ink max-sm:hidden" title="本地用户">你</span>
      </div>
    </header>
  );
}

// ── 侧栏 ───────────────────────────────────────

const navClass = (on: boolean) =>
  cn('flex h-[30px] w-full items-center gap-2 rounded-pill px-2 text-sm transition-colors duration-150', on ? 'bg-paper-3 font-medium text-ink' : 'text-ink-2 hover:bg-hover');

function Group({ title, action, label, children }: { title?: string; action?: ReactNode; label: string; children: ReactNode }) {
  return (
    <nav aria-label={label} className="group/side space-y-px">
      {title && (
        <div className="flex h-6 items-center justify-between pl-2 pr-1 text-xs font-semibold text-faint">
          {title}
          {action}
        </div>
      )}
      {children}
    </nav>
  );
}

function Count({ n, tone = 'amber' }: { n: number; tone?: 'amber' | 'cool' }) {
  if (!n) return null;
  return <span className={cn('ml-auto shrink-0 rounded-full px-1.5 text-[11px] font-semibold', tone === 'amber' ? 'bg-accent-tag text-accent-tag-ink' : 'bg-cool-tag text-cool-tag-ink')}>{n}</span>;
}

function SideHead({ icon, title, sub }: { icon: IconName; title: string; sub: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-2 pb-1 pt-1">
      <span aria-hidden className="grid size-[22px] shrink-0 place-items-center rounded-[4px] bg-tag text-tag-ink"><Icon name={icon} className="size-[14px]" /></span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-ink">{title}</span>
        <span className="block truncate text-xs text-muted">{sub}</span>
      </span>
    </div>
  );
}

function ConsoleSidebar() {
  const projects = useProjects();
  const inbox = useAllInbox();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const [creating, setCreating] = useState(false);
  const list = projects.data ?? [];
  return (
    <>
      <SideHead icon="home" title="控制台" sub={`全部 ${list.length} 个项目`} />
      <Group label="控制台">
        <Link to="/" className={navClass(path === '/')}><Icon name="home" className="text-muted" />总览</Link>
        <Link to="/inbox" className={navClass(path === '/inbox')}><Icon name="inbox" className="text-muted" />需要我<Count n={inbox.data?.length ?? 0} /></Link>
      </Group>
      <Group label="项目经理" title="项目经理">
        {list.map((p) => (
          <Link key={p.id} to="/pm/$projectId" params={{ projectId: p.id }} className={navClass(path === `/pm/${p.id}`)}>
            <span aria-hidden className="grid size-5 shrink-0 place-items-center rounded-full bg-tag text-[9px] font-semibold text-tag-ink">PM</span>
            <span className="truncate">{p.name}</span>
          </Link>
        ))}
      </Group>
      <Group
        label="项目"
        title="项目"
        action={<button type="button" aria-label="新建项目" onClick={() => setCreating(true)} className="grid size-5 place-items-center rounded-[4px] text-faint opacity-0 hover:bg-hover hover:text-ink focus-visible:opacity-100 group-hover/side:opacity-100"><Icon name="plus" className="size-3.5" /></button>}
      >
        {list.map((p) => (
          <Link key={p.id} to="/projects/$projectId" params={{ projectId: p.id }} onClick={() => rememberProject(p.id)} className={navClass(false)}>
            <span aria-hidden className="grid size-[18px] shrink-0 place-items-center rounded-[4px] bg-tag text-[10px] font-semibold text-tag-ink">{p.name.slice(0, 1).toUpperCase()}</span>
            <span className="truncate">{p.name}</span>
            <span className="ml-auto shrink-0 text-xs text-faint">{p.workstationCount} 台</span>
          </Link>
        ))}
      </Group>
      <Group label="系统">
        <Link to="/agents" className={navClass(path === '/agents')}><Icon name="robot" className="text-muted" />Agent 模板</Link>
        <Link to="/plugins" className={navClass(path === '/plugins')}><Icon name="plug" className="text-muted" />插件</Link>
        <Link to="/settings" className={navClass(path === '/settings')}><Icon name="gear" className="text-muted" />模型与设置</Link>
      </Group>
      <p className="mt-auto border-t border-rule px-2 pt-2.5 text-xs text-muted">sqlite 本地</p>
      {creating && <NewProjectDialog onClose={() => setCreating(false)} />}
    </>
  );
}

const CLOSED = ['done', 'cancelled'];

function WorkstationSidebar({ project, wsId }: { project: ProjectDetail; wsId: string }) {
  const ws = useWorkstation(wsId);
  const tasks = useWsTasks(wsId);
  const inbox = useAllInbox();
  const overview = useOverview(project.id);
  const params = useParams({ strict: false }) as { taskId?: string };
  const loc = useRouterState({ select: (s) => ({ path: s.location.pathname, panel: (s.location.search as { panel?: string }).panel }) });
  const node = project.workstations.find((w) => w.id === wsId);
  const onWs = loc.path === `/projects/${project.id}/ws/${wsId}` || (node?.parentId === null && (loc.path === `/projects/${project.id}` || loc.path === `/projects/${project.id}/`));
  const stat = overview.data?.workstations.find((w) => w.id === wsId);
  const pending = (taskId: string) => (inbox.data ?? []).filter((i) => i.taskId === taskId).length;
  const active = (tasks.data ?? []).filter((t) => !t.parentId && !CLOSED.includes(t.status)).slice(0, 12);
  const to = '/projects/$projectId/ws/$wsId' as const;
  const wsParams = { projectId: project.id, wsId };
  const name = node?.name ?? ws.data?.name ?? '';
  // 声明了 home 的板块占据默认入口，大群让到 _chat
  const home = ws.data ? homeBlock(ws.data.blocks) : undefined;
  const onChat = onWs && (home ? loc.panel === '_chat' : !loc.panel);

  return (
    <>
      <SideHead icon={wsIcon(node?.pluginId)} title={name} sub={<span className="measured">{ws.data?.manifest ? `${ws.data.manifest.id}@${ws.data.manifest.version}` : (node?.pluginId ?? '')}{node?.parentId === null ? '　根工作台' : ''}</span>} />
      <Group label="群聊" title="群聊">
        <Link to={to} params={wsParams} search={home ? { panel: '_chat' } : {}} className={navClass(onChat)} data-testid="side-chat">
          <Icon name="hash" className="text-muted" /><span className="truncate">{name}大群</span>
          {!!stat?.running && <i className="ml-auto size-1.5 shrink-0 rounded-full bg-cool" aria-label="在跑" />}
        </Link>
        {active.map((t) => (
          <Link key={t.id} to="/projects/$projectId/tasks/$taskId" params={{ projectId: project.id, taskId: t.id }} className={navClass(params.taskId === t.id)} data-testid="active-task">
            <Icon name="doc" className="text-muted" /><span className="truncate">{t.title}</span><Count n={pending(t.id)} />
          </Link>
        ))}
      </Group>
      <Group label="功能" title="功能">
        {(ws.data?.blocks ?? []).map((b) => (
          <Link key={b.id} to={to} params={wsParams} search={{ panel: b.panelId ?? '' }} className={navClass(onWs && (loc.panel === b.panelId || (!loc.panel && b.id === home?.id)))} data-testid={`side-panel-${b.name}`}>
            <Icon name={panelIcon(b.panelType, b.entityType, b.panelId)} className="text-muted" /><span className="truncate">{b.name}</span>
            {b.panelType === 'diff' && <Count n={stat?.pendingReviews ?? 0} tone="cool" />}
          </Link>
        ))}
      </Group>
      <Group label="团队" title="团队">
        <Link to={to} params={wsParams} search={{ panel: '_agents' }} className={navClass(onWs && loc.panel === '_agents')} data-testid="side-panel-成员"><Icon name="people" className="text-muted" />成员<span className="ml-auto text-xs text-faint">{ws.data?.agents.length ?? ''}</span></Link>
        <Link to={to} params={wsParams} search={{ panel: '_settings' }} className={navClass(onWs && loc.panel === '_settings')} data-testid="side-panel-设置"><Icon name="gear" className="text-muted" />工作台设置</Link>
      </Group>
      <Group label="项目" title="项目">
        <Link to="/projects/$projectId/inbox" params={{ projectId: project.id }} className={navClass(loc.path.endsWith('/inbox'))}><Icon name="inbox" className="text-muted" />收件箱<Count n={overview.data?.inboxOpen ?? 0} /></Link>
        <Link to="/projects/$projectId/runs" params={{ projectId: project.id }} className={navClass(loc.path.includes('/runs'))}><Icon name="ledger" className="text-muted" />运行账本</Link>
      </Group>
      <p className="measured mt-auto border-t border-rule px-2 pt-2.5 text-xs text-muted">sqlite 本地</p>
    </>
  );
}

function ModelBanner() {
  const models = useModels();
  if (models.data?.ready !== false) return null;
  return (
    <p className="shrink-0 border-b border-rule bg-accent-soft px-4 py-1.5 text-sm text-ink-2" data-testid="model-banner">
      还没有可用的模型，任务暂时无法派发。<Link to="/settings" className="font-medium text-accent underline underline-offset-2">去配置模型</Link>
    </p>
  );
}

// ── 外壳 ───────────────────────────────────────

function Frame({ project, activeWs, onConsole, sidebar, children }: { project: ProjectDetail | undefined; activeWs: string | undefined; onConsole: boolean; sidebar: ReactNode; children: ReactNode }) {
  const [palette, setPalette] = useState(false);
  const [mounting, setMounting] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);
  const path = useRouterState({ select: (s) => s.location.href });

  useEffect(() => setSideOpen(false), [path]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex h-dvh flex-col">
      <TopBar project={project} activeWs={activeWs} onConsole={onConsole} onMenu={() => setSideOpen((v) => !v)} onMount={() => setMounting(true)} onPalette={() => setPalette(true)} />
      <ModelBanner />
      <div className="relative flex min-h-0 flex-1">
        {sideOpen && <button type="button" aria-label="关闭侧栏" className="fixed inset-x-0 bottom-0 top-11 z-30 bg-scrim md:hidden" onClick={() => setSideOpen(false)} />}
        <aside
          aria-label="导航"
          data-testid="sidebar"
          className={cn(
            'flex w-60 shrink-0 flex-col gap-3.5 overflow-y-auto border-r border-rule bg-paper-2 p-2 max-md:fixed max-md:bottom-0 max-md:left-0 max-md:top-11 max-md:z-40 max-md:shadow-[var(--shadow-pop)]',
            !sideOpen && 'max-md:hidden',
          )}
        >
          {sidebar}
        </aside>
        <main className="flex min-w-0 flex-1 flex-col bg-paper">{children}</main>
      </div>
      {palette && project && <CommandPalette project={project} onClose={() => setPalette(false)} />}
      {mounting && project && <MountDialog project={project} onClose={() => setMounting(false)} />}
    </div>
  );
}

function ConsoleFrame({ projectId, children }: { projectId: string | undefined; children: ReactNode }) {
  const project = useProject(projectId ?? '', !!projectId);
  return <Frame project={project.data} activeWs={undefined} onConsole sidebar={<ConsoleSidebar />}>{children}</Frame>;
}

export function ConsoleShell({ children }: { children: ReactNode }) {
  const projectId = useCurrentProjectId();
  return <ConsoleFrame projectId={projectId}>{children}</ConsoleFrame>;
}

export function Shell({ project, children }: { project: ProjectDetail; children: ReactNode }) {
  const params = useParams({ strict: false }) as { wsId?: string; taskId?: string };
  const path = useRouterState({ select: (s) => s.location.pathname });
  const task = useTask(params.taskId);
  const rootId = project.workstations.find((w) => w.parentId === null)?.id;
  const onRoot = path === `/projects/${project.id}` || path === `/projects/${project.id}/`;
  const activeWs = params.wsId ?? task.data?.flow.workstationId ?? (onRoot ? rootId : undefined);
  const sideWs = activeWs ?? rootId;

  useEffect(() => rememberProject(project.id), [project.id]);

  return (
    <Frame project={project} activeWs={activeWs} onConsole={false} sidebar={sideWs ? <WorkstationSidebar key={sideWs} project={project} wsId={sideWs} /> : null}>
      {children}
    </Frame>
  );
}

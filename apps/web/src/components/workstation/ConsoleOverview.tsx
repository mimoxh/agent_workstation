import { useQueries } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { WsThread } from '@/components/chat/Thread';
import { InboxEntry } from '@/components/inbox/InboxEntry';
import { NewProjectDialog } from '@/components/layout/Dialogs';
import { Page, PageHeader, SectionTitle } from '@/components/layout/Page';
import { flatWorkstations } from '@/components/layout/Shell';
import { Button } from '@/components/ui/button';
import { Empty, ErrorState, Loading } from '@/components/ui/feedback';
import { Icon, type IconName } from '@/components/ui/icons';
import { api, unwrap } from '@/lib/api';
import { tokens } from '@/lib/format';
import { nameMaps, useAllInbox, useOverview, useProject, useProjects, type ProjectSummary } from '@/lib/queries';
import { cn } from '@/lib/utils';

function Stat({ icon, label, value, tone }: { icon: IconName; label: string; value: string | number; tone?: 'amber' | 'cool' | undefined }) {
  return (
    <div className="rounded-pill border border-rule-2 px-3.5 py-3" data-testid={`reading-${label}`}>
      <dt className="flex items-center gap-1.5 text-xs text-muted"><Icon name={icon} className="size-3.5" />{label}</dt>
      <dd className={cn('mt-1 text-[1.6rem] font-semibold leading-tight tabular-nums', tone === 'amber' ? 'text-accent' : tone === 'cool' ? 'text-cool' : 'text-ink')}>{value}</dd>
    </div>
  );
}

const th = 'h-8 whitespace-nowrap border-y border-rule px-2.5 text-left text-xs font-normal text-muted';
const td = 'h-9 whitespace-nowrap border-b border-rule px-2.5';

// 一个项目一张工作台表：点一行打开对应标签
function ProjectTable({ p }: { p: ProjectSummary }) {
  const project = useProject(p.id);
  const overview = useOverview(p.id);
  const navigate = useNavigate();
  const rows = project.data ? flatWorkstations(project.data) : [];
  return (
    <section className="mt-5" aria-label={p.name}>
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2.5">
        <Link to="/projects/$projectId" params={{ projectId: p.id }} className="flex items-center gap-2 text-[1.05rem] font-semibold text-ink hover:underline" data-testid="project-card">
          <span aria-hidden className="grid size-5 place-items-center rounded-chip bg-primary text-[11px] text-primary-ink">{p.name.slice(0, 1).toUpperCase()}</span>
          {p.name}
        </Link>
        {p.goal && <span className="min-w-0 truncate text-sm text-muted">{p.goal}</span>}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className={cn(th, 'pl-0.5')}>工作台</th>
              <th className={cn(th, 'max-sm:hidden')}>插件</th>
              <th className={cn(th, 'text-right')}>进行中</th>
              <th className={cn(th, 'text-right')}>等你</th>
              <th className={cn(th, 'text-right max-sm:hidden')}>在跑</th>
              <th className={cn(th, 'text-right max-sm:hidden')}>待审</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ ws, parent }) => {
              const s = overview.data?.workstations.find((w) => w.id === ws.id);
              const attention = s?.tasks.blocked ?? 0;
              return (
                <tr key={ws.id} tabIndex={0} className="cursor-pointer hover:bg-hover" onClick={() => void navigate({ to: '/projects/$projectId/ws/$wsId', params: { projectId: p.id, wsId: ws.id } })} onKeyDown={(e) => { if (e.key === 'Enter') void navigate({ to: '/projects/$projectId/ws/$wsId', params: { projectId: p.id, wsId: ws.id } }); }}>
                  <td className={cn(td, 'pl-0.5')}>{parent && <span className="text-faint">{parent} / </span>}<span className="font-medium text-ink">{ws.name}</span></td>
                  <td className={cn(td, 'max-sm:hidden')}><span className="rounded-chip bg-tag px-1.5 py-0.5 text-xs text-tag-ink">{ws.pluginId ?? '—'}</span></td>
                  <td className={cn(td, 'text-right tabular-nums text-ink-2')}>{s?.tasks.active ?? 0}</td>
                  <td className={cn(td, 'text-right tabular-nums')}>{attention > 0 ? <span className="rounded-chip bg-accent-tag px-1.5 py-0.5 text-xs text-accent-tag-ink">{attention}</span> : <span className="text-faint">0</span>}</td>
                  <td className={cn(td, 'text-right tabular-nums max-sm:hidden', s?.running ? 'text-cool' : 'text-faint')}>{s?.running ?? 0}</td>
                  <td className={cn(td, 'text-right tabular-nums text-ink-2 max-sm:hidden')}>{s?.pendingReviews ?? 0}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PmThread({ projectId }: { projectId: string }) {
  const project = useProject(projectId);
  const rootId = project.data?.workstations.find((w) => w.parentId === null)?.id;
  if (!project.data || !rootId) return <Loading />;
  return <WsThread wsId={rootId} projectId={projectId} names={nameMaps(project.data).agent} root />;
}

// 右侧常驻：和某个项目的项目经理对话
function PmPanel({ projects }: { projects: ProjectSummary[] }) {
  const [picked, setPicked] = useState<string | undefined>();
  const current = projects.find((p) => p.id === picked)?.id ?? projects[0]?.id;
  return (
    <aside className="flex min-h-0 w-[22rem] shrink-0 flex-col border-l border-rule max-xl:hidden" aria-label="和项目经理对话">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-rule px-3.5">
        <span aria-hidden className="grid size-5 place-items-center rounded-full bg-tag text-[9px] font-semibold text-tag-ink">PM</span>
        <h2 className="text-sm font-semibold text-ink">项目经理</h2>
        {current && <Link to="/pm/$projectId" params={{ projectId: current }} className="ml-auto rounded-chip px-1.5 py-0.5 text-sm text-muted hover:bg-hover hover:text-ink">展开</Link>}
      </div>
      {projects.length > 1 && (
        <div className="flex flex-wrap gap-0.5 px-3.5 pt-2.5" role="group" aria-label="选择项目">
          {projects.map((p) => (
            <button key={p.id} type="button" aria-pressed={p.id === current} onClick={() => setPicked(p.id)} className={cn('h-6 rounded-chip px-2 text-xs', p.id === current ? 'bg-paper-3 text-ink' : 'text-muted hover:bg-hover hover:text-ink')}>
              {p.name}
            </button>
          ))}
        </div>
      )}
      {current ? <PmThread key={current} projectId={current} /> : <Empty title="还没有项目" />}
    </aside>
  );
}

// 控制台总览：先回答「要我做什么」，再回答「各台在干什么」
export function ConsoleOverview() {
  const projects = useProjects();
  const inbox = useAllInbox();
  const list = projects.data ?? [];
  const overviews = useQueries({ queries: list.map((p) => ({ queryKey: ['overview', p.id], queryFn: async () => unwrap(await api.projects[':id'].overview.$get({ param: { id: p.id } })) })) });
  const [creating, setCreating] = useState(false);
  const sum = (f: (o: NonNullable<(typeof overviews)[number]['data']>) => number) => overviews.reduce((n, q) => n + (q.data ? f(q.data) : 0), 0);
  const items = inbox.data ?? [];

  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto" data-testid="command-center">
        <Page>
          <PageHeader icon="home" title="总览" desc={`全部 ${list.length} 个项目`} actions={<Button variant="primary" onClick={() => setCreating(true)} data-testid="new-project"><Icon name="plus" className="size-3.5" />新建项目</Button>} />
          {projects.isLoading && <Loading />}
          {projects.isError && <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />}
          {list.length > 0 && (
            <dl className="mt-6 grid grid-cols-2 gap-2.5 md:grid-cols-4">
              <Stat icon="hand" label="等你处理" value={items.length} tone={items.length > 0 ? 'amber' : undefined} />
              <Stat icon="bolt" label="在跑 run" value={sum((o) => o.runs.running)} tone="cool" />
              <Stat icon="board" label="进行中的任务" value={sum((o) => o.tasks.active)} />
              <Stat icon="ledger" label="累计用量" value={tokens(sum((o) => o.tokens))} />
            </dl>
          )}
          <SectionTitle aside={items.length > 5 ? <Link to="/inbox" className="rounded-chip px-1.5 text-sm text-muted hover:bg-hover hover:text-ink">查看全部 {items.length} 条</Link> : null}>需要你</SectionTitle>
          {items.length === 0 ? (
            <p className="border-t border-rule py-3 text-sm text-muted">没有待处理项，Agent 正常推进时不会打扰你。</p>
          ) : (
            <div className="divide-y divide-rule border-y border-rule">
              {items.slice(0, 5).map((i) => <InboxEntry key={i.id} item={i} projectId={i.projectId ?? ''} compact />)}
            </div>
          )}
          <SectionTitle>全部工作台</SectionTitle>
          {list.length === 0 && !projects.isLoading && <Empty title="还没有项目">新建一个项目，自动获得一个根工作台。</Empty>}
          {list.map((p) => <ProjectTable key={p.id} p={p} />)}
        </Page>
      </div>
      <PmPanel projects={list} />
      {creating && <NewProjectDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

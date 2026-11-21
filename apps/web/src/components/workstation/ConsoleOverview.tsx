import { useQueries } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { ChatRail } from '@/components/chat/ChatRail';
import { InboxEntry } from '@/components/inbox/InboxEntry';
import { NewProjectDialog } from '@/components/layout/Dialogs';
import { Page, PageHeader, SectionTitle } from '@/components/layout/Page';
import { flatWorkstations, wsIcon } from '@/components/layout/Shell';
import { Badge, Count } from '@/components/ui/badge';
import { Button, buttonClass } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Empty, ErrorState, Loading } from '@/components/ui/feedback';
import { Icon, type IconName } from '@/components/ui/icons';
import { chipClass } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { parseJson, tokens } from '@/lib/format';
import { nameMaps, useAllInbox, useOverview, useProject, useProjects, useWorkstation, type ProjectSummary } from '@/lib/queries';
import { cn } from '@/lib/utils';

function Stat({ icon, label, value, foot, tone }: { icon: IconName; label: string; value: string | number; foot: string; tone?: 'amber' | 'cool' | undefined }) {
  const solid = tone === 'amber';
  return (
    <div className={cn('grid content-start gap-1 rounded-card p-4', solid ? 'bg-accent text-accent-ink' : 'bg-paper-2')} data-testid={`reading-${label}`}>
      <dt className={cn('flex items-center gap-1.5 text-xs font-medium', solid ? 'opacity-85' : 'text-muted')}><Icon name={icon} className="size-3.5" />{label}</dt>
      <dd className={`text-display font-bold tabular-nums ${solid ? '' : tone === 'cool' ? 'text-cool' : 'text-ink'}`}>{value}</dd>
      <dd className={cn('text-xs', solid ? 'opacity-85' : 'text-muted')}>{foot}</dd>
    </div>
  );
}

const th = 'whitespace-nowrap border-b border-rule bg-paper-2 px-3.5 py-2.5 text-left text-xs font-semibold text-muted';
const td = 'whitespace-nowrap border-b border-rule px-3.5 py-3 text-sm text-ink-2';

function BudgetCell({ p, used, span }: { p: ProjectSummary; used: number; span: number }) {
  const limit = parseJson<{ tokens?: number } | null>(p.budgetJson, null)?.tokens;
  if (!limit) return <td rowSpan={span} className={cn(td, 'align-top max-md:hidden')}><span className="text-faint">不限</span></td>;
  const v = Math.min(1, used / limit);
  return (
    <td rowSpan={span} className={cn(td, 'min-w-48 align-top max-md:hidden')}>
      <div className="flex justify-between gap-3 text-xs text-muted"><span>已用 <b className="font-semibold text-ink">{tokens(used)}</b></span><span>上限 {tokens(limit)}</span></div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-paper-3"><div className={cn('h-full rounded-full', v > 0.6 ? 'bg-accent' : 'bg-ink-2')} style={{ width: `${v * 100}%` }} /></div>
    </td>
  );
}

// 一个项目一组工作台行：点一行打开对应标签
function ProjectRows({ p }: { p: ProjectSummary }) {
  const project = useProject(p.id);
  const overview = useOverview(p.id);
  const navigate = useNavigate();
  const rows = project.data ? flatWorkstations(project.data) : [];
  const span = Math.max(rows.length, 1);
  const head = (
    <td rowSpan={span} className={cn(td, 'align-top')}>
      <Link to="/projects/$projectId" params={{ projectId: p.id }} className="flex items-center gap-2 font-semibold text-ink hover:underline" data-testid="project-card">
        <span aria-hidden className="grid size-5 shrink-0 place-items-center rounded-chip bg-primary text-[11px] text-primary-ink">{p.name.slice(0, 1).toUpperCase()}</span>
        {p.name}
      </Link>
      {p.goal && <p className="mt-1 max-w-56 truncate text-xs text-muted">{p.goal}</p>}
    </td>
  );
  return (
    <tbody aria-label={p.name} className="[&>tr:last-child>td]:border-b-0 [&:not(:last-child)>tr:last-child>td]:border-b">
      {rows.length === 0 && <tr>{head}<td colSpan={7} className={td}><span className="text-faint">—</span></td></tr>}
      {rows.map(({ ws, parent }, idx) => {
        const s = overview.data?.workstations.find((w) => w.id === ws.id);
        const attention = s?.tasks.blocked ?? 0;
        const pending = s?.pendingReviews ?? 0;
        const go = () => void navigate({ to: '/projects/$projectId/ws/$wsId', params: { projectId: p.id, wsId: ws.id } });
        return (
          <tr key={ws.id} tabIndex={0} className="cursor-pointer transition-colors duration-100 hover:bg-hover" onClick={go} onKeyDown={(e) => { if (e.key === 'Enter') go(); }}>
            {idx === 0 && head}
            <td className={td}>
              <span className="inline-flex items-center gap-2 text-ink">
                <Icon name={wsIcon(ws.pluginId)} className="size-[15px] text-muted" />
                {parent && <span className="text-muted">{parent} / </span>}<span className="font-medium">{ws.name}</span>
              </span>
            </td>
            <td className={cn(td, 'max-sm:hidden')}><Badge tone="line" className="measured font-medium">{ws.pluginId ?? '—'}</Badge></td>
            <td className={cn(td, 'text-right tabular-nums')}>{s?.tasks.active ?? 0}</td>
            <td className={cn(td, 'text-right')}>{attention > 0 ? <Count>{attention}</Count> : <span className="tabular-nums text-faint">0</span>}</td>
            <td className={cn(td, 'text-right tabular-nums max-sm:hidden', s?.running ? 'font-semibold text-cool' : 'text-faint')}>{s?.running ?? 0}</td>
            <td className={cn(td, 'text-right max-sm:hidden')}>{pending > 0 ? <Count>{pending}</Count> : <span className="tabular-nums text-faint">0</span>}</td>
            {idx === 0 && <BudgetCell p={p} used={overview.data?.tokens ?? 0} span={span} />}
          </tr>
        );
      })}
    </tbody>
  );
}

function WsTable({ projects }: { projects: ProjectSummary[] }) {
  return (
    <div className="overflow-x-auto rounded-card bg-paper shadow-[var(--shadow-card)]">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th className={th}>项目</th>
            <th className={th}>工作台</th>
            <th className={cn(th, 'max-sm:hidden')}>插件</th>
            <th className={cn(th, 'text-right')}>进行中</th>
            <th className={cn(th, 'text-right')}>等你</th>
            <th className={cn(th, 'text-right max-sm:hidden')}>在跑</th>
            <th className={cn(th, 'text-right max-sm:hidden')}>待审</th>
            <th className={cn(th, 'max-md:hidden')}>预算（tokens）</th>
          </tr>
        </thead>
        {projects.map((p) => <ProjectRows key={p.id} p={p} />)}
      </table>
    </div>
  );
}

function PmThread({ projectId }: { projectId: string }) {
  const project = useProject(projectId);
  const rootId = project.data?.workstations.find((w) => w.parentId === null)?.id;
  const ws = useWorkstation(rootId);
  if (!project.data || !ws.data) return <Loading />;
  return <ChatRail ws={ws.data} projectId={projectId} names={nameMaps(project.data).agent} root />;
}

// 右侧常驻：和某个项目的项目经理对话
function PmPanel({ projects }: { projects: ProjectSummary[] }) {
  const [picked, setPicked] = useState<string | undefined>();
  const current = projects.find((p) => p.id === picked)?.id ?? projects[0]?.id;
  return (
    <aside className="flex min-h-0 w-[22rem] shrink-0 flex-col border-l border-rule bg-paper max-xl:hidden" aria-label="和项目经理对话">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-rule px-4">
        <span aria-hidden className="grid size-[26px] place-items-center rounded-full bg-tag text-[10px] font-semibold text-tag-ink">PM</span>
        <h2 className="text-sm font-bold text-ink">项目经理</h2>
        {current && <Link to="/pm/$projectId" params={{ projectId: current }} className={buttonClass('quiet', 'sm', 'ml-auto')}>展开</Link>}
      </div>
      {projects.length > 1 && (
        <div className="flex flex-wrap gap-1.5 px-4 pt-3" role="group" aria-label="选择项目">
          {projects.map((p) => (
            <button key={p.id} type="button" aria-pressed={p.id === current} onClick={() => setPicked(p.id)} className={chipClass(p.id === current)}>
              {p.name}
            </button>
          ))}
        </div>
      )}
      {current ? <PmThread key={current} projectId={current} /> : <Empty title="还没有项目" icon="flag" />}
    </aside>
  );
}

// 控制台总览：先回答「要我做什么」，再回答「各台在干什么」
export function ConsoleOverview() {
  const projects = useProjects();
  const inbox = useAllInbox();
  const list = (projects.data ?? []).filter((p) => p.status !== 'archived');
  const archived = (projects.data ?? []).filter((p) => p.status === 'archived');
  const overviews = useQueries({ queries: list.map((p) => ({ queryKey: ['overview', p.id], queryFn: async () => unwrap(await api.projects[':id'].overview.$get({ param: { id: p.id } })) })) });
  const [creating, setCreating] = useState(false);
  const sum = (f: (o: NonNullable<(typeof overviews)[number]['data']>) => number) => overviews.reduce((n, q) => n + (q.data ? f(q.data) : 0), 0);
  const items = inbox.data ?? [];

  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto" data-testid="command-center">
        <Page>
          <PageHeader icon="home" title="总览" desc={`全部 ${list.length} 个项目`} actions={<Button variant="primary" onClick={() => setCreating(true)} data-testid="new-project"><Icon name="plus" />新建项目</Button>} />
          {projects.isLoading && <Loading />}
          {projects.isError && <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />}
          {list.length > 0 && (
            <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat icon="hand" label="等你处理" value={items.length} foot="阻塞、确认和待决定" tone={items.length > 0 ? 'amber' : undefined} />
              <Stat icon="bolt" label="在跑 run" value={sum((o) => o.runs.running)} foot="机器在动，不用管" tone="cool" />
              <Stat icon="board" label="进行中的任务" value={sum((o) => o.tasks.active)} foot="全部工作台合计" />
              <Stat icon="ledger" label="累计用量" value={tokens(sum((o) => o.tokens))} foot="tokens，按运行计" />
            </dl>
          )}
          <div className="mb-3.5 mt-8 flex flex-wrap items-center gap-x-2.5 gap-y-2">
            <h2 className="text-title font-bold text-ink">需要你</h2>
            {items.length > 0 && <Count>{items.length}</Count>}
            {items.length > 5 && <Link to="/inbox" className={buttonClass('quiet', 'sm', 'ml-auto')}>查看全部 {items.length} 条</Link>}
          </div>
          {items.length === 0 ? (
            <Card className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 px-4 py-3">
              <span aria-hidden className="grid size-7 place-items-center rounded-chip bg-ok-soft text-ok"><Icon name="check" className="size-3.5" /></span>
              <p className="text-sm text-ink-2">没有待处理项，Agent 正常推进时不会打扰你。</p>
            </Card>
          ) : (
            <Card className="divide-y divide-rule px-2 py-1">
              {items.slice(0, 5).map((i) => <InboxEntry key={i.id} item={i} projectId={i.projectId ?? ''} compact />)}
            </Card>
          )}
          <SectionTitle aside={list.length > 0 ? <p className="text-sm text-muted">点一行进入对应工作台。</p> : null}>全部工作台</SectionTitle>
          {list.length === 0 && !projects.isLoading && <Empty title="还没有项目" icon="flag">新建一个项目，自动获得一个根工作台。</Empty>}
          {list.length > 0 && <WsTable projects={list} />}
          {archived.length > 0 && (
            <>
              <SectionTitle>已归档</SectionTitle>
              <Card className="overflow-hidden p-0">
                <ul data-testid="archived-projects">
                  {archived.map((p) => (
                    <li key={p.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-rule px-4 py-3 last:border-b-0">
                      <span aria-hidden className="grid size-7 place-items-center rounded-chip bg-paper-2 text-ink-2"><Icon name="archive" className="size-3.5" /></span>
                      <p className="flex min-w-0 items-center gap-2 text-sm">
                        <span className="truncate font-semibold text-muted">{p.name}</span>
                        <Badge tone="line">已归档</Badge>
                      </p>
                      <Link to="/projects/$projectId/settings" params={{ projectId: p.id }} className={buttonClass('quiet', 'sm')}>恢复或删除</Link>
                    </li>
                  ))}
                </ul>
              </Card>
            </>
          )}
        </Page>
      </div>
      <PmPanel projects={list} />
      {creating && <NewProjectDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogForm } from '@/components/ui/dialog';
import { Empty, Loading, toast } from '@/components/ui/feedback';
import { Icon, type IconName } from '@/components/ui/icons';
import { Field, Input, Select } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { when } from '@/lib/format';
import { useDocHealth, useDocsSettings, useProjectStatus, type DocHealth, type ProjectDetail, type WorkstationDetail } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { STATUS_LABEL, STATUS_TONE } from './model';

type HealthDoc = DocHealth['docs'][number];
type DriftRow = HealthDoc['items'][number];

const DRIFT_LABEL: Record<string, string> = { moved: '行号挪了', changed: '内容变了', deleted: '文件没了' };

// 文档健康台：过时 / 行号漂移 / 入库后被改 / 合并影响 / 设置与发布说明
export function HealthPanel({ ws, project, onOpen }: { ws: WorkstationDetail; project: ProjectDetail; onOpen: (docId: string) => void }) {
  const health = useDocHealth(ws.id);
  const settings = useDocsSettings(ws.id);
  const status = useProjectStatus(project.id);
  const [releaseOpen, setReleaseOpen] = useState(false);

  const thread = async () => unwrap(await api.workstations[':id'].thread.$get({ param: { id: ws.id } }));
  const postMsg = async (content: string) => {
    const th = await thread();
    return unwrap(await api.threads[':id'].messages.$post({ param: { id: th.thread.id }, json: { content } }));
  };

  const updateDoc = useMutation({
    meta: { silent: true },
    mutationFn: async (d: HealthDoc) => {
      const bad = d.items.filter((i) => i.status !== 'moved');
      const list = bad.map((i) => `${i.id}（${i.path ?? '知识库'}${i.lines ? ` 第 ${i.lines[0]}–${i.lines[1]} 行` : ''}：${DRIFT_LABEL[i.status] ?? i.status}）`).join('、');
      return postMsg(`@主笔 文档《${d.title}》（${d.id}）引用的出处已变：${list}，请按变更更新内容。`);
    },
    onSuccess: () => toast('已请主笔按变更更新', 'ok'),
    onError: (e) => toast(e.message),
  });
  const repoint = useMutation({
    mutationFn: async (id: string) => unwrap(await api.docs[':id'].drift.repoint.$post({ param: { id } })),
    onSuccess: () => toast('行号已重指', 'ok'),
    onError: (e) => toast(e.message),
  });
  const ack = useMutation({
    mutationFn: async (id: string) => unwrap(await api.docs[':id'].reverse.ack.$post({ param: { id } })),
    onSuccess: () => toast('已忽略这次入库外改动', 'ok'),
    onError: (e) => toast(e.message),
  });
  const importBack = useMutation({
    mutationFn: async (id: string) => unwrap(await api.docs[':id'].reverse.import.$post({ param: { id } })),
    onSuccess: () => toast('已导回为新版本草稿', 'ok'),
    onError: (e) => toast(e.message),
  });
  const saveSettings = useMutation({
    mutationFn: async (autoDraft: 'off' | 'affected') => unwrap(await api.workstations[':id']['docs-settings'].$put({ param: { id: ws.id }, json: { autoDraft } })),
    onError: (e) => toast(e.message),
  });

  if (!health.data) return health.isError ? <Empty title="文档健康加载失败" /> : <Loading className="flex-1" />;

  const stale = health.data.docs.filter((d) => d.items.some((i) => i.status !== 'moved'));
  const moved = health.data.docs.filter((d) => d.items.some((i) => i.status === 'moved'));
  const reverse = health.data.docs.filter((d) => d.reverse);

  const DocLine = ({ d, children }: { d: HealthDoc; children?: React.ReactNode }) => (
    <li className="grid gap-3 rounded-card bg-paper p-4 shadow-[var(--shadow-card)]" data-testid={`health-doc-${d.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="min-w-0 flex-1 truncate text-left text-sm font-semibold text-ink underline decoration-transparent underline-offset-[3px] hover:decoration-rule-2" onClick={() => onOpen(d.id)}>
          {d.title}
        </button>
        <Badge tone={STATUS_TONE[d.status] ?? 'neutral'}>{STATUS_LABEL[d.status] ?? d.status}</Badge>
        {children}
      </div>
      <ul className="grid gap-2">
        {d.items.map((i) => (
          <DriftLine key={i.id} d={d} i={i} />
        ))}
      </ul>
    </li>
  );

  const stats: { label: string; icon: IconName; value: number; foot: string; tone: string }[] = [
    { label: '引用过时', icon: 'alert', value: stale.length, foot: '出处内容变了或文件没了', tone: stale.length ? 'text-bad' : '' },
    { label: '行号挪位', icon: 'link', value: moved.length, foot: '内容没变，可一键重指', tone: moved.length ? 'text-cool' : '' },
    { label: '入库外改动', icon: 'branch', value: reverse.length, foot: '导回或忽略，等你定', tone: reverse.length ? 'text-accent' : '' },
    { label: '合并影响', icon: 'merge', value: health.data.impacts.length, foot: '开发合并波及的文档', tone: '' },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="doc-health">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[75rem] animate-fade px-8 pb-14 pt-7 max-md:px-4 max-md:pb-10 max-md:pt-5">
          <header className="mb-6 flex flex-wrap items-end gap-x-4 gap-y-3">
            <div className="grid min-w-0 flex-[1_1_320px] gap-1.5">
              <h2 className="text-h2 font-bold tracking-[-0.01em] text-ink">文档健康</h2>
              <p className="text-sm text-muted">引用出处变了、行号挪了、入库后被直接改，都在这里收口</p>
            </div>
            <Button variant="primary" onClick={() => setReleaseOpen(true)} data-testid="release-notes-open">
              <Icon name="doc" />起草发布说明
            </Button>
          </header>
          <div className="grid grid-cols-4 gap-3 max-lg:grid-cols-2">
            {stats.map((s) => (
              <div key={s.label} className="grid content-start gap-1 rounded-card bg-paper-2 p-4">
                <span className="flex items-center gap-1.5 text-xs font-medium text-muted"><Icon name={s.icon} className="size-3.5" />{s.label}</span>
                <span className={cn('text-display font-bold tabular-nums text-ink', s.tone)}>{s.value}</span>
                <span className="text-xs text-muted">{s.foot}</span>
              </div>
            ))}
          </div>
          <section className="mt-8 grid gap-3.5">
            <h3 className="text-title font-bold text-ink">过时文档</h3>
            {stale.length === 0 ? <p className="text-sm text-muted">引用的出处都还和写的时候一致。</p> : null}
            <ul className="grid gap-3 empty:hidden">
              {stale.map((d) => (
                <DocLine key={d.id} d={d}>
                  <Button size="sm" disabled={updateDoc.isPending} onClick={() => updateDoc.mutate(d)} data-testid={`health-update-${d.id}`}>
                    @主笔 按变更更新
                  </Button>
                </DocLine>
              ))}
            </ul>
          </section>
          <section className="mt-8 grid gap-3.5">
            <h3 className="text-title font-bold text-ink">行号漂移</h3>
            {moved.length === 0 ? <p className="text-sm text-muted">没有引用挪位。</p> : null}
            <ul className="grid gap-3 empty:hidden">
              {moved.map((d) => (
                <DocLine key={d.id} d={d}>
                  <Button size="sm" disabled={repoint.isPending} onClick={() => repoint.mutate(d.id)} data-testid={`health-repoint-${d.id}`}>
                    更新行号
                  </Button>
                </DocLine>
              ))}
            </ul>
          </section>
          <section className="mt-8 grid gap-3.5">
            <h3 className="text-title font-bold text-ink">入库后被改</h3>
            {reverse.length === 0 ? <p className="text-sm text-muted">入库后的文件没有平台之外的改动。</p> : null}
            <ul className="grid gap-3 empty:hidden">
              {reverse.map((d) => (
                <li key={d.id} className="grid gap-2 rounded-card bg-paper p-4 shadow-[var(--shadow-card)]" data-testid={`health-reverse-${d.id}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" className="min-w-0 flex-1 truncate text-left text-sm font-semibold text-ink underline decoration-transparent underline-offset-[3px] hover:decoration-rule-2" onClick={() => onOpen(d.id)}>
                      {d.title}
                    </button>
                    <Badge tone="cool">{d.reverse?.status === 'deleted' ? '文件已删' : '被直接改过'}</Badge>
                    <Button size="sm" disabled={importBack.isPending} onClick={() => importBack.mutate(d.id)} data-testid={`health-import-${d.id}`}>
                      导回为新版本
                    </Button>
                    <Button size="sm" variant="quiet" disabled={ack.isPending} onClick={() => ack.mutate(d.id)} data-testid={`health-ack-${d.id}`}>
                      忽略
                    </Button>
                  </div>
                  <p className="text-xs text-muted"><span className="measured">{d.path}</span> 在仓库里被平台之外改过；导回会拿仓库现文出新草稿，去掉引用标记交接的文档导回后引用会丢。</p>
                </li>
              ))}
            </ul>
          </section>
          <section className="mt-8 grid gap-3.5">
            <h3 className="text-title font-bold text-ink">最近合并影响</h3>
            {health.data.impacts.length === 0 ? <p className="text-sm text-muted">还没有开发合并波及到文档。</p> : null}
            <ul className="overflow-hidden rounded-card bg-paper shadow-[var(--shadow-card)] empty:hidden" data-testid="health-impacts">
              {health.data.impacts.map((e, i) => (
                <li key={i} className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 border-b border-rule px-4 py-3 last:border-b-0">
                  <span className="grid size-8 place-items-center rounded-ctl bg-paper-2 text-ink-2"><Icon name="merge" /></span>
                  <span className="grid min-w-0 gap-0.5">
                    <span className="truncate text-sm font-semibold text-ink">「{e.taskTitle}」合并</span>
                    <span className="flex min-w-0 items-center gap-3 text-xs text-muted">
                      <span className="shrink-0">{when(e.at)}</span>
                      <span className="truncate">{e.docs?.map((x) => `《${x.title}》`).join('、')}</span>
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <section className="mt-8 rounded-card bg-paper p-4 shadow-[var(--shadow-card)]">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="grid min-w-0 flex-1 gap-0.5">
                <span className="text-sm font-semibold text-ink">自动起草</span>
                <span className="text-xs text-muted">开发合并波及文档时，要不要直接 @主笔 出新版本草稿</span>
              </div>
              <Select className="w-auto min-w-36" value={settings.data?.autoDraft ?? 'off'} disabled={saveSettings.isPending} onChange={(e) => saveSettings.mutate(e.target.value as 'off' | 'affected')} data-testid="health-autodraft">
                <option value="off">只提示</option>
                <option value="affected">自动起草</option>
              </Select>
            </div>
          </section>
        </div>
      </div>
      {releaseOpen ? <ReleaseNotesDialog wsId={ws.id} milestones={status.data?.milestones ?? []} onClose={() => setReleaseOpen(false)} /> : null}
    </div>
  );
}

function DriftLine({ d, i }: { d: HealthDoc; i: DriftRow }) {
  return (
    <li className="grid gap-2 rounded-ctl bg-paper-2 px-3 py-2.5 text-xs" data-testid={`drift-${d.id}-${i.id}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <code>{i.id}</code>
        <Badge tone={i.status === 'moved' ? 'cool' : 'bad'}>{DRIFT_LABEL[i.status] ?? i.status}</Badge>
        {i.path ? <span className="measured text-muted">{i.path}</span> : <span className="text-muted">知识库引用</span>}
        {i.lines ? <span className="text-muted tabular-nums">第 {i.lines[0]}–{i.lines[1]} 行</span> : null}
        {i.status === 'moved' && i.newLines ? <span className="font-medium text-cool tabular-nums">→ 第 {i.newLines[0]}–{i.newLines[1]} 行</span> : null}
      </div>
      {i.excerpt ? (
        <div className="grid gap-2 md:grid-cols-2">
          <pre className="max-h-24 overflow-y-auto whitespace-pre-wrap rounded-chip bg-paper px-2.5 py-2 leading-[1.65] text-muted shadow-[var(--shadow-card)]">引用时：{i.excerpt}</pre>
          {i.current !== null && i.current !== undefined ? <pre className="max-h-24 overflow-y-auto whitespace-pre-wrap rounded-chip bg-paper px-2.5 py-2 leading-[1.65] text-ink-2 shadow-[var(--shadow-card)]">现在：{i.current}</pre> : null}
        </div>
      ) : null}
    </li>
  );
}

// 发布说明对话框：里程碑或时间范围二选一，主笔按已合并任务起草
function ReleaseNotesDialog({ wsId, milestones, onClose }: { wsId: string; milestones: { id: string; name: string }[]; onClose: () => void }) {
  const [mode, setMode] = useState<'milestone' | 'range'>('milestone');
  const [milestoneId, setMilestoneId] = useState(milestones[0]?.id ?? '');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [error, setError] = useState<string | null>(null);
  const send = useMutation({
    meta: { silent: true },
    mutationFn: async () =>
      unwrap(
        await api.workstations[':id']['release-notes'].$post({
          param: { id: wsId },
          json: mode === 'milestone' ? { milestoneId } : { since: new Date(since).toISOString(), ...(until ? { until: new Date(until).toISOString() } : {}) },
        }),
      ),
    onSuccess: (r) => {
      toast(`已请主笔起草发布说明（${r.count} 个已合并任务）`, 'ok');
      onClose();
    },
    onError: (e) => setError(e.message),
  });
  const canSubmit = mode === 'milestone' ? !!milestoneId : !!since;
  return (
    <Dialog title="起草发布说明" onClose={onClose} testId="release-notes-dialog">
      <DialogForm error={error} submitting={send.isPending} submitLabel="起草" canSubmit={canSubmit} onSubmit={() => send.mutate()} onCancel={onClose}>
        <div className="inline-flex w-fit gap-0.5 rounded-btn bg-paper-3 p-[3px]">
          {(['milestone', 'range'] as const).map((m) => (
            <button key={m} type="button" aria-pressed={mode === m} data-testid={`release-mode-${m}`} onClick={() => setMode(m)} className={cn('h-[30px] rounded-btn px-3.5 text-sm transition-colors duration-150', mode === m ? 'bg-primary font-semibold text-primary-ink' : 'text-muted hover:text-ink')}>
              {m === 'milestone' ? '按里程碑' : '按时间范围'}
            </button>
          ))}
        </div>
        {mode === 'milestone' ? (
          <Field label="里程碑">
            <Select value={milestoneId} onChange={(e) => setMilestoneId(e.target.value)} data-testid="release-milestone">
              {milestones.length === 0 ? <option value="">还没有里程碑</option> : null}
              {milestones.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Field label="从">
              <Input type="date" value={since} onChange={(e) => setSince(e.target.value)} data-testid="release-since" />
            </Field>
            <Field label="到（可空）">
              <Input type="date" value={until} onChange={(e) => setUntil(e.target.value)} data-testid="release-until" />
            </Field>
          </div>
        )}
        <p className="text-xs text-muted">收集这个范围内已合并的开发任务，@主笔 按新增 / 改进 / 修复分组起草 release_notes。</p>
      </DialogForm>
    </Dialog>
  );
}

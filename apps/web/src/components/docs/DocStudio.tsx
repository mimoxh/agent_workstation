import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo, useRef, useState } from 'react';
import { WsThread } from '@/components/chat/Thread';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogForm } from '@/components/ui/dialog';
import { Empty, Loading, MenuItem, Popover, toast } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/icons';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { parseJson, when } from '@/lib/format';
import { useDoc, useDocRepos, useDocs, useEntityVersions, useOverview, type DocDetail, type ProjectDetail, type WorkstationDetail } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { DocHandoffDialog } from './DocHandoffDialog';
import { DocMarkdown } from './Markdown';
import { docDataOf, headingBefore, KIND_LABEL, kindLabel, STATUS_LABEL, STATUS_TONE, type DocKind } from './model';
import { CitationsPane, CommentsPane, GatePane, ReviewPane, type PendingComment } from './panes';

type RailTab = 'chat' | 'comments' | 'citations' | 'review' | 'gate';

function RailTabButton({ on, onClick, label, count, testId }: { on: boolean; onClick: () => void; label: string; count?: number; testId: string }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} data-testid={testId} className={cn('relative h-9 px-2.5 text-sm transition-colors duration-150 after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:bg-ink', on ? 'font-medium text-ink after:opacity-100' : 'text-muted after:opacity-0 hover:text-ink')}>
      {label}{count ? <span className="ml-1 text-xs text-faint">{count}</span> : null}
    </button>
  );
}

function DocMetaDialog({ doc, repos, onClose }: { doc: DocDetail; repos: ReturnType<typeof useDocRepos>['data']; onClose: () => void }) {
  const [title, setTitle] = useState(doc.title ?? '');
  const [kind, setKind] = useState<DocKind>((doc.kind as DocKind | undefined) ?? 'general');
  const [brief, setBrief] = useState(doc.brief ?? '');
  const [repo, setRepo] = useState(doc.target_repo ?? '');
  const [path, setPath] = useState(doc.target_path ?? '');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.docs[':id'].$patch({
          param: { id: doc.id },
          json: { title: title.trim(), kind, brief, target_repo: repo || null, target_path: path || null, baseVersion: doc.version, reason: '人工改文档信息' },
        }),
      ),
    meta: { silent: true },
    onSuccess: onClose,
    onError: (e) => setError(e.message),
  });
  const repoList = repos?.repos ?? [];
  return (
    <Dialog title="文档信息" onClose={onClose} testId="doc-meta-dialog">
      <DialogForm error={error} submitting={save.isPending} submitLabel="保存" canSubmit={!!title.trim()} onSubmit={() => save.mutate()} onCancel={onClose}>
        <Field label="标题" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} data-testid="doc-meta-title" />
        </Field>
        <Field label="类型">
          <Select value={kind} onChange={(e) => setKind(e.target.value as DocKind)} data-testid="doc-meta-kind">
            {Object.entries(KIND_LABEL).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </Select>
        </Field>
        <Field label="简介">
          <Textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={2} data-testid="doc-meta-brief" />
        </Field>
        <Field label="目标仓库" hint="写仓库相关文档时绑定；绑定后引用按这个仓库解析">
          <Select value={repo} onChange={(e) => setRepo(e.target.value)} data-testid="doc-meta-repo">
            <option value="">（不绑定）</option>
            {repoList.map((r) => (
              <option key={r.repo} value={r.repo}>{r.name}{r.bound ? '' : '（未绑定仓库）'}</option>
            ))}
          </Select>
        </Field>
        <Field label="目标路径" hint="交接时建议的写入位置，例如 docs/api.md">
          <Input value={path} onChange={(e) => setPath(e.target.value)} data-testid="doc-meta-path" />
        </Field>
      </DialogForm>
    </Dialog>
  );
}

function NewDocDialog({ wsId, onClose, onCreated }: { wsId: string; onClose: () => void; onCreated: (id: string) => void }) {
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<DocKind>('general');
  const [brief, setBrief] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: async () => unwrap(await api.workstations[':id'].docs.$post({ param: { id: wsId }, json: { title: title.trim(), kind, brief, content: `# ${title.trim()}\n` } })),
    meta: { silent: true },
    onSuccess: (r) => onCreated(r.id),
    onError: (e) => setError(e.message),
  });
  return (
    <Dialog title="新建文档" onClose={onClose} testId="doc-new-dialog">
      <DialogForm error={error} submitting={create.isPending} submitLabel="创建" canSubmit={!!title.trim()} onSubmit={() => create.mutate()} onCancel={onClose}>
        <Field label="标题" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} data-testid="doc-new-title" autoFocus />
        </Field>
        <Field label="类型">
          <Select value={kind} onChange={(e) => setKind(e.target.value as DocKind)} data-testid="doc-new-kind">
            {Object.entries(KIND_LABEL).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </Select>
        </Field>
        <Field label="简介">
          <Textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={2} data-testid="doc-new-brief" />
        </Field>
      </DialogForm>
    </Dialog>
  );
}

function DocEditor({ ws, project, id, running, onBack }: { ws: WorkstationDetail; project: ProjectDetail; id: string; running: boolean; onBack: () => void }) {
  const docQ = useDoc(id);
  const repos = useDocRepos(ws.id);
  const versions = useEntityVersions(id);
  const thread = useQuery({ queryKey: ['thread', 'ws', ws.id], queryFn: async () => unwrap(await api.workstations[':id'].thread.$get({ param: { id: ws.id } })) });
  const names = useMemo(() => Object.fromEntries(project.agents.map((a) => [a.id, a.name])), [project.agents]);
  const previewRef = useRef<HTMLDivElement>(null);
  const [rail, setRail] = useState<RailTab>('chat');
  const [railOpen, setRailOpen] = useState(() => window.innerWidth >= 768);
  const [mode, setMode] = useState<'edit' | 'preview'>('preview');
  const [pinned, setPinned] = useState<number | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingComment | null>(null);
  const [activeCit, setActiveCit] = useState<string | null>(null);
  const [metaOpen, setMetaOpen] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const doc = docQ.data;

  const save = useMutation({
    mutationFn: async (input: { content: string; baseVersion: number }) => unwrap(await api.docs[':id'].$patch({ param: { id }, json: { content: input.content, baseVersion: input.baseVersion, reason: '人工改文档正文' } })),
    onSuccess: () => setDraft(null),
  });
  const rollback = useMutation({
    mutationFn: async (version: number) => unwrap(await api.entities[':id'].rollback.$post({ param: { id }, json: { version } })),
    onSuccess: () => setPinned(null),
  });
  const requestReview = useMutation({
    mutationFn: async (who: 'fact-checker' | 'doc-editor') => unwrap(await api.docs[':id']['request-review'].$post({ param: { id }, json: { who } })),
    onSuccess: () => setRail('chat'),
  });
  const dropCitation = useMutation({
    mutationFn: async (citId: string) =>
      unwrap(
        await api.docs[':id'].$patch({
          param: { id },
          json: { citations: (doc?.citations ?? []).filter((c) => c.id !== citId), baseVersion: doc?.version ?? 0, reason: '人工删引用' },
        }),
      ),
  });
  const send = useMutation({
    mutationFn: async (content: string) => {
      if (!thread.data?.thread.id) return;
      return unwrap(await api.threads[':id'].messages.$post({ param: { id: thread.data.thread.id }, json: { content } }));
    },
  });

  const exportDoc = async (format: 'md' | 'html' | 'pdf') => {
    if (!doc) return;
    const v = pinned ?? doc.version;
    try {
      const res = await fetch(`/api/docs/${id}/export?format=${format}&version=${v}&citations=footnotes`);
      if (!res.ok) throw new Error(parseJson<{ error?: string }>(await res.text(), {}).error ?? `导出失败（${res.status}）`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${doc.title}-v${v}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast(e instanceof Error ? e.message : '导出失败');
    }
  };

  if (!doc) return docQ.isError ? <Empty title="文档加载失败" /> : <Loading className="flex-1" />;

  const old = pinned !== null && pinned !== doc.version;
  const oldData = old ? docDataOf(versions.data?.find((v) => v.version === pinned)?.dataJson ?? null) : null;
  const content = oldData?.content ?? doc.content ?? '';
  const versionList = [...new Set([...(versions.data ?? []).map((v) => v.version), doc.version])].sort((a, b) => b - a);
  const dirty = draft !== null && draft !== doc.content;
  const citationIds = (doc.citations ?? []).map((c) => c.id);
  const status = doc.status ?? 'draft';
  const repoName = doc.target_repo ? (repos.data?.repos ?? []).find((r) => r.repo === doc.target_repo)?.name ?? doc.target_repo : null;

  const pickQuote = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !previewRef.current?.contains(sel.anchorNode)) return;
    const quote = sel.toString().trim();
    if (!quote) return;
    setPending({ quote, heading: headingBefore(doc.content ?? '', quote) });
    setRail('comments');
    setRailOpen(true);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1" data-testid="doc-canvas">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-canvas">
        <header className="flex shrink-0 items-center gap-2 border-b border-rule bg-paper px-3 py-2">
          <Button variant="quiet" size="sm" onClick={onBack} title="回到文档列表" data-testid="doc-back">
            <Icon name="chev" className="size-3.5 rotate-90" />全部
          </Button>
          <div className="flex min-w-0 flex-1 items-baseline gap-2">
            <h1 className="min-w-0 truncate text-md font-medium">{doc.title}</h1>
            <Badge tone="neutral">{kindLabel(doc.kind)}</Badge>
            <Badge tone={STATUS_TONE[status] ?? 'neutral'} data-testid="doc-status">{STATUS_LABEL[status] ?? status}</Badge>
            {status === 'handed_off' && doc.handoff?.taskId ? (
              <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId: project.id, taskId: doc.handoff.taskId }} className="text-xs text-primary underline" data-testid="doc-handoff-task">
                开发任务 →
              </Link>
            ) : null}
            {status === 'published' && doc.handoff?.publishedCommit ? <span className="text-xs text-muted" data-testid="doc-published">已入库 {doc.handoff.publishedCommit.slice(0, 8)}</span> : null}
            {doc.handoff?.cancelled ? <span className="text-xs text-muted">（上次交接已取消）</span> : null}
            {running ? <Badge tone="cool">主笔在动</Badge> : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <div className="mr-1 flex rounded-btn bg-canvas p-0.5">
              {(['preview', 'edit'] as const).map((m) => (
                <button key={m} type="button" data-testid={`doc-mode-${m}`} onClick={() => setMode(m)} className={cn('h-6 rounded-[5px] px-2 text-xs', mode === m ? 'bg-paper font-medium text-ink shadow-sm' : 'text-muted hover:text-ink')}>
                  {m === 'preview' ? '预览' : '编辑'}
                </button>
              ))}
            </div>
            <Popover
              trigger={(on, toggle) => (
                <Button variant="quiet" size="sm" aria-expanded={on} onClick={toggle} title="版本历史" data-testid="doc-versions">
                  <Icon name="clock" className="size-3.5" /> v{doc.version}
                </Button>
              )}
            >
              {(close) => (
                <div className="max-h-64 w-44 overflow-y-auto py-1">
                  {versionList.map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => {
                        setPinned(v === doc.version ? null : v);
                        close();
                      }}
                      className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-canvas', pinned === v && 'font-medium')}
                      data-testid={`doc-version-${v}`}
                    >
                      v{v}
                      {v === doc.version ? <span className="ml-auto text-xs text-muted">最新</span> : null}
                    </button>
                  ))}
                </div>
              )}
            </Popover>
            <Popover
              trigger={(on, toggle) => (
                <Button variant="quiet" size="sm" aria-expanded={on} onClick={toggle} title="导出当前版本" data-testid="doc-export">
                  导出
                </Button>
              )}
            >
              {(close) => (
                <div className="w-32 py-1">
                  {([['md', 'Markdown'], ['html', 'HTML'], ['pdf', 'PDF']] as const).map(([f, label]) => (
                    <MenuItem key={f} data-testid={`doc-export-${f}`} onClick={() => { close(); void exportDoc(f); }}>
                      {label}
                    </MenuItem>
                  ))}
                </div>
              )}
            </Popover>
            <Button variant="quiet" size="sm" onClick={() => setMetaOpen(true)} title="文档信息" data-testid="doc-meta">
              <Icon name="sliders" />
            </Button>
            <Button variant="quiet" size="sm" disabled={requestReview.isPending} title="让事实核对过一遍引用和表述" data-testid="doc-request-review" onClick={() => requestReview.mutate('fact-checker')}>
              请求核对
            </Button>
            <Button variant="quiet" size="sm" disabled={requestReview.isPending} title="让文字编辑看一遍" data-testid="doc-request-edit" onClick={() => requestReview.mutate('doc-editor')}>
              请编辑看看
            </Button>
            <Button variant="primary" size="sm" title="把成品文本冻结成交接工件，在开发台起写入任务" data-testid="doc-handoff-top" onClick={() => setHandoffOpen(true)}>
              交给开发
            </Button>
            <button type="button" aria-label={railOpen ? '收起侧栏' : '展开侧栏'} onClick={() => setRailOpen((v) => !v)} className="grid size-7 place-items-center rounded-btn text-muted hover:bg-canvas hover:text-ink" data-testid="doc-rail-toggle">
              <Icon name="chev" className={cn('size-3.5', railOpen ? '-rotate-90' : 'rotate-90')} />
            </button>
          </div>
        </header>
        {old ? (
          <div className="flex shrink-0 items-center gap-2 border-b border-rule bg-accent-soft px-3 py-1.5 text-xs text-accent-tag-ink" data-testid="doc-old-banner">
            正在看历史版本 v{pinned}，内容只读
            <Button size="sm" variant="quiet" className="ml-auto" disabled={rollback.isPending} onClick={() => pinned !== null && rollback.mutate(pinned)} data-testid="doc-rollback">
              恢复这个版本
            </Button>
          </div>
        ) : null}
        {doc.brief && !old ? <p className="shrink-0 border-b border-rule bg-paper px-3 py-1.5 text-xs text-muted">{doc.brief}{repoName ? ` · 目标：${repoName}${doc.target_path ? ` ${doc.target_path}` : ''}` : ''}</p> : null}
        {doc.drift && (doc.drift.items.length > 0 || doc.drift.reverse) && !old ? (
          <p className="flex shrink-0 items-center gap-2 border-b border-rule bg-bad-soft px-3 py-1.5 text-xs text-bad-tag-ink" data-testid="doc-drift-strip">
            {doc.drift.reverse ? '入库后被平台之外改过' : `引用漂移：${doc.drift.items.filter((i) => i.status !== 'moved').length} 处过时、${doc.drift.items.filter((i) => i.status === 'moved').length} 处挪位`}
            <Link to="/projects/$projectId/ws/$wsId" params={{ projectId: project.id, wsId: ws.id }} search={{ panel: 'health' }} className="ml-auto underline" data-testid="doc-drift-health">
              去看文档健康 →
            </Link>
          </p>
        ) : null}
        <div className="flex min-h-0 flex-1">
          {mode === 'edit' && !old ? (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <Textarea
                value={draft ?? content}
                onChange={(e) => setDraft(e.target.value)}
                className="min-h-0 flex-1 resize-none rounded-none border-0 bg-canvas p-4 font-mono text-sm leading-6 focus:ring-0"
                data-testid="doc-editor"
              />
              <div className="flex shrink-0 items-center gap-2 border-t border-rule bg-paper px-3 py-2">
                <span className="text-xs text-muted">{dirty ? '有未保存的改动' : `v${doc.version}`}</span>
                {doc.lint.length ? <Badge tone={doc.lint.some((l) => l.level === 'error') ? 'bad' : 'amber'}>{doc.lint.length} 个风格问题</Badge> : null}
                <Button variant="primary" size="sm" className="ml-auto" disabled={!dirty || save.isPending} data-testid="doc-save" onClick={() => draft !== null && save.mutate({ content: draft, baseVersion: doc.version })}>
                  保存
                </Button>
              </div>
            </div>
          ) : (
            <div ref={previewRef} onMouseUp={pickQuote} className="min-h-0 min-w-0 flex-1 overflow-y-auto px-6 py-4 md:px-10 lg:px-14">
              <DocMarkdown content={content} citationIds={citationIds} onCitation={(cid) => { setActiveCit(cid); setRail('citations'); setRailOpen(true); }} />
            </div>
          )}
        </div>
      </section>
      {railOpen ? (
        <aside className="flex w-[21rem] shrink-0 flex-col border-l border-rule bg-paper" data-testid="doc-rail">
          <div className="flex shrink-0 items-end gap-1 border-b border-rule px-2 pt-1">
            <RailTabButton on={rail === 'chat'} onClick={() => setRail('chat')} label="对话" testId="doc-tab-chat" />
            <RailTabButton on={rail === 'comments'} onClick={() => setRail('comments')} label="评论" count={doc.openComments.length} testId="doc-tab-comments" />
            <RailTabButton on={rail === 'citations'} onClick={() => setRail('citations')} label="引用" count={citationIds.length} testId="doc-tab-citations" />
            <RailTabButton on={rail === 'review'} onClick={() => setRail('review')} label="审查" testId="doc-tab-review" />
            <RailTabButton on={rail === 'gate'} onClick={() => setRail('gate')} label="交接" testId="doc-tab-gate" />
          </div>
          {rail === 'chat' ? (
            <WsThread wsId={ws.id} projectId={project.id} names={names} root={false} hint="@docs-writer 起草或修改；@fact-checker 核对引用" placeholder="说需求，比如：给 API 写一份接入指南" />
          ) : null}
          {rail === 'comments' ? <CommentsPane doc={doc} comments={doc.openComments} pending={pending} onClearPending={() => setPending(null)} onSend={(c) => { send.mutate(c); setRail('chat'); }} /> : null}
          {rail === 'citations' ? <CitationsPane doc={doc} repos={repos.data?.repos ?? []} active={activeCit} onDelete={(cid) => dropCitation.mutate(cid)} /> : null}
          {rail === 'review' ? <ReviewPane doc={doc} /> : null}
          {rail === 'gate' ? <GatePane doc={doc} onHandoff={() => setHandoffOpen(true)} /> : null}
        </aside>
      ) : null}
      {metaOpen ? <DocMetaDialog doc={doc} repos={repos.data} onClose={() => setMetaOpen(false)} /> : null}
      {handoffOpen ? <DocHandoffDialog doc={doc} repos={repos.data?.repos ?? []} project={project} onClose={() => setHandoffOpen(false)} onEditMeta={() => { setHandoffOpen(false); setMetaOpen(true); }} /> : null}
    </div>
  );
}

export function DocStudio({ ws, project, openId, onOpen }: { ws: WorkstationDetail; project: ProjectDetail; openId?: string | undefined; onOpen: (id: string | null) => void }) {
  const docs = useDocs(ws.id);
  const overview = useOverview(project.id);
  const names = useMemo(() => Object.fromEntries(project.agents.map((a) => [a.id, a.name])), [project.agents]);
  const [newOpen, setNewOpen] = useState(false);
  const running = (overview.data?.workstations.find((w) => w.id === ws.id)?.running ?? 0) > 0;

  if (!docs.data) return docs.isError ? <Empty title="文档台加载失败" /> : <Loading className="flex-1" />;
  const list = docs.data.docs;
  const open = openId ? list.find((d) => d.id === openId) : undefined;

  if (open) {
    return <DocEditor key={open.id} ws={ws} project={project} id={open.id} running={running} onBack={() => onOpen(null)} />;
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1" data-testid="doc-studio">
      <aside className="flex w-72 shrink-0 flex-col border-r border-rule bg-paper">
        <div className="flex shrink-0 items-center gap-2 border-b border-rule px-3 py-2">
          <h2 className="text-sm font-medium">文档</h2>
          <Button size="sm" variant="quiet" className="ml-auto" onClick={() => setNewOpen(true)} data-testid="doc-new">
            <Icon name="plus" /> 新建
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {list.length === 0 ? <p className="p-2 text-sm text-muted">还没有文档。新建一篇，或在右边对主笔说需求。</p> : null}
          <ul className="space-y-1">
            {list.map((d) => (
              <li key={d.id}>
                <button type="button" onClick={() => onOpen(d.id)} className="w-full rounded-card border border-rule bg-paper p-2.5 text-left hover:border-ink/30" data-testid={`doc-item-${d.id}`}>
                  <div className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{d.title}</span>
                    {d.drift?.bad ? <Badge tone="bad">过时 {d.drift.bad}</Badge> : null}
                    {d.drift?.moved ? <Badge tone="cool">挪位 {d.drift.moved}</Badge> : null}
                    {d.drift?.reverse ? <Badge tone="cool">被改</Badge> : null}
                    <Badge tone={STATUS_TONE[d.status ?? ''] ?? 'neutral'}>{STATUS_LABEL[d.status ?? ''] ?? d.status}</Badge>
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 text-xs text-muted">
                    <span>{kindLabel(d.kind)}</span>
                    {d.openComments ? <span>· {d.openComments} 条评论</span> : null}
                    <span className="ml-auto">{when(d.updatedAt)}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </aside>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-rule bg-paper px-4 py-2.5">
          <h2 className="text-sm font-medium">和主笔说需求</h2>
          {running ? <Badge tone="cool">主笔在动</Badge> : null}
        </div>
        <WsThread wsId={ws.id} projectId={project.id} names={names} root={false} hint="@docs-writer 起草；写好后 @fact-checker 核对" placeholder="比如：给登录模块写一份 README" />
      </section>
      {newOpen ? (
        <NewDocDialog
          wsId={ws.id}
          onClose={() => setNewOpen(false)}
          onCreated={(id) => {
            setNewOpen(false);
            onOpen(id);
          }}
        />
      ) : null}
    </div>
  );
}

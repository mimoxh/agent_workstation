import type { DesignToken } from '@aw/domain';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { WsThread } from '@/components/chat/Thread';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogForm } from '@/components/ui/dialog';
import { ErrorState, Loading, toast } from '@/components/ui/feedback';
import { Field, Input, Textarea } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { nameMaps, useDesignSystem, useOverview, useWsEntities, type ProjectDetail, type WorkstationDetail } from '@/lib/queries';
import { DesignCanvas } from './DesignCanvas';
import { DesignThumb } from './DesignFrame';
import { STATUS_LABEL, thumbDoc, toComment, toDesign, type DesignComment, type DesignDoc } from './model';

const STARTERS = [
  '做一个 B2B SaaS 产品的落地页，三个方向',
  '做一个团队任务看板的桌面端界面，带筛选和拖拽',
  '做一个手机端的注册引导流程，三步，能点着走',
];

function ImportDialog({ wsId, onClose, onDone }: { wsId: string; onClose: () => void; onDone: (id: string) => void }) {
  const [title, setTitle] = useState('');
  const [html, setHtml] = useState('');
  const save = useMutation({
    meta: { silent: true },
    mutationFn: async () => unwrap(await api.workstations[':id'].designs.$post({ param: { id: wsId }, json: { title: title.trim(), html } })),
    onSuccess: (r) => {
      for (const w of r.warnings) toast(w);
      onDone(r.id);
    },
  });
  return (
    <Dialog title="导入 HTML" onClose={onClose} testId="import-dialog">
      <DialogForm error={save.error?.message} submitting={save.isPending} submitLabel="导入" canSubmit={!!title.trim() && !!html.trim()} onSubmit={() => save.mutate()} onCancel={onClose}>
        <Field label="标题" required><Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} data-testid="import-title" /></Field>
        <Field label="HTML" required hint="把现有页面贴进来，就能在画布上评论和迭代">
          <Textarea className="measured" rows={10} value={html} onChange={(e) => setHtml(e.target.value)} data-testid="import-html" />
        </Field>
      </DialogForm>
    </Dialog>
  );
}

function DesignCard({ d, tokens, onOpen }: { d: DesignDoc & { open: number }; tokens: DesignToken[]; onOpen: () => void }) {
  const doc = useMemo(() => thumbDoc(d.data.html, tokens, d.data.tweaks ?? []), [d.data.html, d.data.tweaks, tokens]);
  const status = d.data.status ?? 'draft';
  return (
    <button type="button" onClick={onOpen} data-testid="design-card" className="group block overflow-hidden rounded-card bg-paper text-left shadow-[var(--shadow-card)] transition-shadow duration-150 hover:shadow-[var(--shadow-pop)]">
      <DesignThumb doc={doc} title={d.data.title} />
      <span className="block border-t border-rule px-3 py-2">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{d.data.title}</span>
          {d.open > 0 && <span className="rounded-full bg-accent-tag px-1.5 text-[11px] font-semibold text-accent-tag-ink">{d.open}</span>}
          <span className="measured text-xs text-faint">v{d.version}</span>
          {status !== 'draft' && <Badge tone="ok">{STATUS_LABEL[status]}</Badge>}
        </span>
        {d.data.direction && <span className="mt-0.5 block truncate text-xs text-muted">{d.data.direction}</span>}
      </span>
    </button>
  );
}

function Gallery({ designs, tokens, ws, project, running, onOpen }: { designs: (DesignDoc & { open: number })[]; tokens: DesignToken[]; ws: WorkstationDetail; project: ProjectDetail; running: boolean; onOpen: (id: string) => void }) {
  const [importing, setImporting] = useState(false);
  const names = nameMaps(project).agent;
  const thread = useQuery({ queryKey: ['thread', 'ws', ws.id], queryFn: async () => unwrap(await api.workstations[':id'].thread.$get({ param: { id: ws.id } })) });
  const start = useMutation({
    mutationFn: async (content: string) => unwrap(await api.threads[':id'].messages.$post({ param: { id: thread.data!.thread.id }, json: { content } })),
  });
  const groups = useMemo(() => {
    const map = new Map<string, typeof designs>();
    for (const d of designs) {
      const key = d.data.group ?? '';
      map.set(key, [...(map.get(key) ?? []), d]);
    }
    return [...map].sort(([a], [b]) => Number(a === '') - Number(b === ''));
  }, [designs]);

  return (
    <div className="relative flex min-h-0 flex-1" data-testid="design-gallery">
      <aside className="flex w-[22rem] shrink-0 flex-col border-r border-rule max-md:hidden" aria-label="和设计师对话">
        <p className="shrink-0 border-b border-rule px-3.5 py-2 text-sm font-medium text-ink">和设计师对话</p>
        <WsThread wsId={ws.id} projectId={project.id} names={names} root={false} hint="说想要什么，设计师直接出稿" placeholder="想做个什么？页面、受众、气质都可以说" />
      </aside>
      <section className="min-w-0 flex-1 overflow-y-auto bg-paper-2 p-5">
        <div className="mb-4 flex items-center gap-2">
          <h2 className="text-title font-semibold text-ink">设计稿</h2>
          {running && <span className="animate-pulse-soft text-xs text-cool" data-testid="gallery-running">设计师工作中…</span>}
          <span className="flex-1" />
          <Button onClick={() => setImporting(true)} data-testid="import-open">导入 HTML</Button>
        </div>
        {designs.length === 0 ? (
          <div className="mx-auto mt-16 max-w-md space-y-2" data-testid="design-empty">
            <p className="text-title font-medium text-ink-2">从一句话开始</p>
            <p className="pb-2 text-sm text-muted">在左边告诉设计师你想要什么，稿子会出现在这里。也可以试试这些：</p>
            {STARTERS.map((s) => (
              <Button key={s} className="block w-full whitespace-normal py-1.5 text-left" disabled={!thread.data || start.isPending} onClick={() => start.mutate(s)} data-testid="design-starter">{s}</Button>
            ))}
          </div>
        ) : (
          <div className="space-y-6">
            {groups.map(([name, items]) => (
              <section key={name || '_'} aria-label={name || '其他设计稿'}>
                {(name || groups.length > 1) && <h3 className="mb-2 text-sm font-medium text-ink-2">{name || '其他'}</h3>}
                <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3">
                  {items.map((d) => <DesignCard key={d.id} d={d} tokens={tokens} onOpen={() => onOpen(d.id)} />)}
                </div>
              </section>
            ))}
          </div>
        )}
      </section>
      {importing && <ImportDialog wsId={ws.id} onClose={() => setImporting(false)} onDone={(id) => { setImporting(false); onOpen(id); }} />}
    </div>
  );
}

// 设计台的主屏：没选稿子看全部，选了进画布；稿子和评论都是普通实体，靠实时失效刷新
export function DesignStudio({ ws, project, openId, onOpen }: { ws: WorkstationDetail; project: ProjectDetail; openId: string | undefined; onOpen: (id: string | undefined) => void }) {
  const entities = useWsEntities(ws.id);
  const system = useDesignSystem(ws.id);
  const overview = useOverview(project.id);
  const running = (overview.data?.workstations.find((w) => w.id === ws.id)?.running ?? 0) > 0;
  const rows = entities.data?.entities;
  const comments = useMemo<DesignComment[]>(() => (rows ?? []).filter((e) => e.entityType === 'DesignComment').map(toComment), [rows]);
  const designs = useMemo(() => (rows ?? []).filter((e) => e.entityType === 'Design').map((e) => {
    const d = toDesign(e);
    return { ...d, open: comments.filter((c) => c.design === d.id && c.status !== 'resolved').length };
  }), [rows, comments]);

  if (entities.isError) return <ErrorState error={entities.error} onRetry={() => void entities.refetch()} />;
  if (!rows || !system.data) return <Loading />;
  const open = designs.find((d) => d.id === openId);
  if (open) return <DesignCanvas key={open.id} design={open} comments={comments.filter((c) => c.design === open.id)} tokens={system.data.tokens} ws={ws} project={project} running={running} onBack={() => onOpen(undefined)} />;
  return <Gallery designs={designs} tokens={system.data.tokens} ws={ws} project={project} running={running} onOpen={onOpen} />;
}

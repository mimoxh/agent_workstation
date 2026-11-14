import { useMutation } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogForm } from '@/components/ui/dialog';
import { ErrorState, Loading, MenuItem, Popover, toast } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/icons';
import { Field, Input, Textarea } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { useAgentStatus, useAgentThread, useWsEntities, type ProjectDetail, type WorkstationDetail } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { DesignCanvas, useDeleteDesign } from './DesignCanvas';
import { DesignChat } from './DesignChat';
import { DesignThumb } from './DesignFrame';
import { STATUS_LABEL, thumbDoc, toComment, toDesign, type DesignComment, type DesignDoc } from './model';
import { useResizableWidth, ResizeHandle } from './resize';

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

function DesignCard({ d, onOpen, onDelete, deleting }: { d: DesignDoc & { open: number }; onOpen: () => void; onDelete: () => void; deleting: boolean }) {
  const doc = useMemo(() => thumbDoc(d.data.html, d.data.legacyTokens ?? [], d.data.tweaks ?? []), [d.data.html, d.data.tweaks, d.data.legacyTokens]);
  const status = d.data.status ?? 'draft';
  return (
    <div className="group relative">
      <button type="button" onClick={onOpen} data-testid="design-card" className="block w-full overflow-hidden rounded-card bg-paper text-left shadow-[var(--shadow-card)] transition-shadow duration-150 hover:shadow-[var(--shadow-pop)]">
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
      <div className="absolute right-2 top-2">
        <Popover
          className="w-32"
          trigger={(on, toggle) => (
            <button type="button" aria-label={`${d.data.title} 的更多操作`} aria-expanded={on} onClick={toggle} data-testid="design-card-more"
              className={cn('grid size-7 place-items-center rounded-pill bg-paper text-muted shadow-[var(--shadow-card)] transition-opacity duration-150 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100', on ? 'opacity-100' : 'opacity-0 max-md:opacity-100')}>
              <Icon name="menu" className="size-3.5" />
            </button>
          )}
        >
          {(close) => <MenuItem danger disabled={deleting} onClick={() => { close(); onDelete(); }} data-testid="design-card-delete">删除</MenuItem>}
        </Popover>
      </div>
    </div>
  );
}

function Gallery({ designs, ws, project, running, designer, chatThread, onChatThread, onOpen }: { designs: (DesignDoc & { open: number })[]; ws: WorkstationDetail; project: ProjectDetail; running: boolean; designer: WorkstationDetail['agents'][number] | undefined; chatThread: string | null; onChatThread: (id: string) => void; onOpen: (id: string) => void }) {
  const [importing, setImporting] = useState(false);
  const [railWidth, railResize] = useResizableWidth('aw.designChatWidth');
  const remove = useDeleteDesign();
  const thread = useAgentThread(designer?.id);
  const start = useMutation({
    mutationFn: async (content: string) => {
      const id = chatThread ?? thread.data?.thread.id;
      if (!id) throw new Error('会话还没加载好');
      return unwrap(await api.threads[':id'].messages.$post({ param: { id }, json: { content } }));
    },
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
      <aside className="relative flex w-[22rem] shrink-0 flex-col border-r border-rule max-md:hidden" style={{ width: railWidth }} aria-label="和设计师对话">
        <ResizeHandle {...railResize} />
        {designer ? <DesignChat ws={ws} project={project} designer={designer} threadId={chatThread} onThread={onChatThread} hint="说想要什么，设计师直接出稿" placeholder="想做个什么？页面、受众、气质都可以说" /> : <p className="p-3.5 text-sm text-muted">本台没有设计师，到「成员」里添加</p>}
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
              <Button key={s} className="block w-full whitespace-normal py-1.5 text-left" disabled={!designer || !thread.data || start.isPending} onClick={() => start.mutate(s)} data-testid="design-starter">{s}</Button>
            ))}
          </div>
        ) : (
          <div className="space-y-6">
            {groups.map(([name, items]) => (
              <section key={name || '_'} aria-label={name || '其他设计稿'}>
                {(name || groups.length > 1) && <h3 className="mb-2 text-sm font-medium text-ink-2">{name || '其他'}</h3>}
                <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3">
                  {items.map((d) => <DesignCard key={d.id} d={d} onOpen={() => onOpen(d.id)} onDelete={() => remove.confirmDelete(d)} deleting={remove.pending} />)}
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
  const designer = ws.agents.find((a) => a.templateId === 'designer' && a.status === 'active');
  const [chatThread, setChatThread] = useState<string | null>(null);
  const status = useAgentStatus(ws.id);
  const running = !!designer && (status.data?.running.includes(designer.id) ?? false);
  const rows = entities.data?.entities;
  const comments = useMemo<DesignComment[]>(() => (rows ?? []).filter((e) => e.entityType === 'DesignComment').map(toComment), [rows]);
  const designs = useMemo(() => (rows ?? []).filter((e) => e.entityType === 'Design').map((e) => {
    const d = toDesign(e);
    return { ...d, open: comments.filter((c) => c.design === d.id && c.status !== 'resolved').length };
  }), [rows, comments]);

  if (entities.isError) return <ErrorState error={entities.error} onRetry={() => void entities.refetch()} />;
  if (!rows) return <Loading />;
  const open = designs.find((d) => d.id === openId);
  if (open) return <DesignCanvas key={open.id} design={open} designs={designs} comments={comments.filter((c) => c.design === open.id)} ws={ws} project={project} running={running} chatThread={chatThread} onChatThread={setChatThread} onBack={() => onOpen(undefined)} />;
  return <Gallery designs={designs} ws={ws} project={project} running={running} designer={designer} chatThread={chatThread} onChatThread={setChatThread} onOpen={onOpen} />;
}

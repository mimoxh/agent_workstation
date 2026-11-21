import { useMutation } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Badge, Count } from '@/components/ui/badge';
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
      <button type="button" onClick={onOpen} data-testid="design-card" className="block w-full overflow-hidden rounded-card bg-paper text-left shadow-[var(--shadow-card)] transition-[box-shadow,translate] duration-150 hover:shadow-[var(--shadow-card),0_0_0_1px_var(--color-rule-2)] active:translate-y-px">
        <DesignThumb doc={doc} title={d.data.title} />
        <span className="block border-t border-rule px-3.5 py-2.5">
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{d.data.title}</span>
            {d.open > 0 && <Count>{d.open}</Count>}
            <span className="text-xs tabular-nums text-muted">v{d.version}</span>
            {status !== 'draft' && <Badge tone="ok">{STATUS_LABEL[status]}</Badge>}
          </span>
          {d.data.direction && <span className="mt-0.5 block truncate text-xs text-muted">{d.data.direction}</span>}
        </span>
      </button>
      <div className="absolute right-2 top-2">
        <Popover
          className="w-32"
          trigger={(on, toggle) => (
            <Button size="icon-sm" aria-label={`${d.data.title} 的更多操作`} aria-expanded={on} onClick={toggle} data-testid="design-card-more"
              className={cn('text-muted shadow-[var(--shadow-card)] transition-[opacity,color,background-color] hover:text-ink focus-visible:opacity-100 group-hover:opacity-100', on ? 'opacity-100' : 'opacity-0 max-md:opacity-100')}>
              <Icon name="more" />
            </Button>
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
      <aside className="relative flex w-[22rem] shrink-0 flex-col border-r border-rule bg-paper max-md:hidden" style={{ width: railWidth }} aria-label="和设计师对话">
        <ResizeHandle {...railResize} />
        {designer ? <DesignChat ws={ws} project={project} designer={designer} threadId={chatThread} onThread={onChatThread} hint="说想要什么，设计师直接出稿" placeholder="想做个什么？页面、受众、气质都可以说" /> : <p className="m-3 rounded-ctl bg-paper-2 px-3.5 py-3 text-sm text-muted">本台没有设计师，到「成员」里添加</p>}
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-rule bg-paper px-5 py-2.5">
          <h2 className="text-title font-bold text-ink">设计稿</h2>
          {running && <span className="flex items-center gap-1.5 text-xs text-cool" data-testid="gallery-running"><i aria-hidden className="size-[7px] animate-pulse-soft rounded-full bg-cool" />设计师工作中…</span>}
          <span className="flex-1" />
          <Button size="sm" onClick={() => setImporting(true)} data-testid="import-open"><Icon name="upload" />导入 HTML</Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto bg-paper-2 p-5">
        {designs.length === 0 ? (
          <div className="mx-auto mt-16 grid max-w-md gap-2" data-testid="design-empty">
            <span aria-hidden className="grid size-10 place-items-center rounded-ctl bg-paper text-ink-2 shadow-[var(--shadow-card)]"><Icon name="palette" /></span>
            <p className="mt-1 text-title font-semibold text-ink">从一句话开始</p>
            <p className="pb-2 text-sm text-muted">在左边告诉设计师你想要什么，稿子会出现在这里。也可以试试这些：</p>
            <div className="overflow-hidden rounded-card bg-paper shadow-[var(--shadow-card)]">
              {STARTERS.map((s) => (
                <button key={s} type="button" className="flex w-full items-center gap-3 border-b border-rule px-4 py-3 text-left text-sm text-ink transition-colors duration-150 last:border-b-0 hover:bg-hover focus-visible:-outline-offset-2 disabled:pointer-events-none disabled:opacity-50" disabled={!designer || !thread.data || start.isPending} onClick={() => start.mutate(s)} data-testid="design-starter">
                  <Icon name="send" className="size-3.5 text-muted" />
                  <span className="min-w-0 flex-1">{s}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="grid gap-7">
            {groups.map(([name, items]) => (
              <section key={name || '_'} aria-label={name || '其他设计稿'}>
                {(name || groups.length > 1) && <h3 className="mb-2.5 text-sm font-bold text-ink">{name || '其他'}</h3>}
                <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-4">
                  {items.map((d) => <DesignCard key={d.id} d={d} onOpen={() => onOpen(d.id)} onDelete={() => remove.confirmDelete(d)} deleting={remove.pending} />)}
                </div>
              </section>
            ))}
          </div>
        )}
        </div>
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

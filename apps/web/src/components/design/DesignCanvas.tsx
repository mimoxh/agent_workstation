import { useMutation } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { MenuItem, Popover, toast } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/icons';
import { Select } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { parseJson, when } from '@/lib/format';
import { useAgentThread, useEntityVersions, type ProjectDetail, type WorkstationDetail } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { DesignChat } from './DesignChat';
import { DEVICES, DesignFrame, type Device } from './DesignFrame';
import { HandoffDialog } from './HandoffDialog';
import { CommentsPane, Segmented, TweaksPane, type PendingComment } from './panes';
import { applyDraft, applyElementText, commentsPrompt, compareDesigns, downloadName, exportDoc, issuesPrompt, previewDoc, STATUS_LABEL, tweakVars, type CanvasMode, type DesignComment, type DesignData, type DesignDoc, type FrameEvent, type Pin, type SelectItem } from './model';
import { useResizableWidth, ResizeHandle } from './resize';

type RailTab = 'chat' | 'comments' | 'tweaks';

const MODES: { id: CanvasMode; label: string }[] = [
  { id: 'view', label: '浏览' },
  { id: 'comment', label: '评论' },
  { id: 'edit', label: '改字' },
  { id: 'select', label: '选择' },
];

function RailTabButton({ on, onClick, label, count, testId }: { on: boolean; onClick: () => void; label: string; count?: number; testId: string }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} data-testid={testId} className={cn('relative h-9 px-2.5 text-sm transition-colors duration-150 after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:bg-ink', on ? 'font-medium text-ink after:opacity-100' : 'text-muted after:opacity-0 hover:text-ink')}>
      {label}{count ? <span className="ml-1 text-xs text-faint">{count}</span> : null}
    </button>
  );
}

type CompareSel = { id: string; version: number };

function CompareSide({ sel, designs, device, onSel, testId }: { sel: CompareSel; designs: DesignDoc[]; device: Device; onSel: (s: CompareSel) => void; testId: string }) {
  const vers = useEntityVersions(sel.id);
  const d = designs.find((x) => x.id === sel.id);
  const hist = d && sel.version !== d.version ? parseJson<DesignData | null>((vers.data ?? []).find((v) => v.version === sel.version)?.dataJson ?? null, null) : null;
  const data = hist ?? d?.data;
  const doc = useMemo(() => (data ? previewDoc(data.html, data.legacyTokens ?? [], data.tweaks ?? []) : ''), [data]);
  const vOptions = useMemo(() => {
    const list = (vers.data ?? []).map((v) => v.version);
    if (d && !list.includes(d.version)) list.push(d.version);
    return [...new Set(list)].sort((a, b) => b - a);
  }, [vers.data, d]);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid={testId}>
      <div className="flex shrink-0 items-center gap-2 border-b border-rule bg-paper px-2 py-1.5">
        <Select className="h-7 min-w-0 flex-1 text-xs" value={sel.id} onChange={(e) => onSel({ id: e.target.value, version: designs.find((x) => x.id === e.target.value)?.version ?? sel.version })} data-testid={`${testId}-design`}>
          {designs.map((x) => <option key={x.id} value={x.id}>{x.data.title}</option>)}
        </Select>
        <Select className="h-7 w-16 text-xs" value={sel.version} onChange={(e) => onSel({ ...sel, version: Number(e.target.value) })} data-testid={`${testId}-version`}>
          {vOptions.map((v) => <option key={v} value={v}>v{v}</option>)}
        </Select>
      </div>
      {data ? <DesignFrame doc={doc} title={data.title} device={device} mode="view" caption={`${data.title} · v${sel.version}${data.direction ? ` · ${data.direction}` : ''}`} testId={`${testId}-frame`} /> : <div className="grid flex-1 place-items-center text-sm text-muted">没有这个版本</div>}
    </div>
  );
}

// 删除前确认；已交接的稿子提示开发任务读的是交接快照，不受影响
export function useDeleteDesign(onDeleted?: () => void) {
  const del = useMutation({
    mutationFn: async (id: string) => unwrap(await api.designs[':id'].$delete({ param: { id } })),
    onSuccess: () => {
      toast('设计稿已删除', 'ok');
      onDeleted?.();
    },
  });
  const confirmDelete = (d: DesignDoc) => {
    const note = d.data.status === 'handed_off' ? '\n\n已生成的实现任务不受影响，它读的是交接时的快照。' : '';
    if (window.confirm(`删除设计稿「${d.data.title}」？它的历史版本和评论会一起删掉，无法恢复。${note}`)) del.mutate(d.id);
  };
  return { confirmDelete, pending: del.isPending };
}

export function DesignCanvas({ design, designs, comments, ws, project, running, chatThread, onChatThread, onBack }: { design: DesignDoc; designs: DesignDoc[]; comments: DesignComment[]; ws: WorkstationDetail; project: ProjectDetail; running: boolean; chatThread: string | null; onChatThread: (id: string) => void; onBack: () => void }) {
  const names = useMemo(() => Object.fromEntries(project.agents.map((a) => [a.id, a.name])), [project.agents]);
  const versions = useEntityVersions(design.id);
  const designer = ws.agents.find((a) => a.templateId === 'designer' && a.status === 'active');
  const thread = useAgentThread(designer?.id);
  const stage = useRef<HTMLDivElement>(null);
  const [rail, setRail] = useState<RailTab>('chat');
  const [railOpen, setRailOpen] = useState(() => window.innerWidth >= 768);
  const [mode, setMode] = useState<CanvasMode>('view');
  const [device, setDevice] = useState<Device>('desktop');
  const [pinned, setPinned] = useState<number | null>(null);
  const [compare, setCompare] = useState(false);
  const [cmp, setCmp] = useState<{ a: CompareSel; b: CompareSel } | null>(null);
  const [pending, setPending] = useState<PendingComment | null>(null);
  const [activePin, setActivePin] = useState<number | null>(null);
  const [missing, setMissing] = useState<number[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [issues, setIssues] = useState<string[]>([]);
  const [handoff, setHandoff] = useState(false);
  const [sel, setSel] = useState<SelectItem[]>([]);
  const [railWidth, railResize] = useResizableWidth('aw.designChatWidth');
  const remove = useDeleteDesign(onBack);

  const old = pinned !== null && pinned !== design.version;
  const oldData = old ? parseJson<DesignData | null>(versions.data?.find((v) => v.version === pinned)?.dataJson ?? null, null) : null;
  const shown = oldData ?? design.data;
  const tweaks = useMemo(() => shown.tweaks ?? [], [shown.tweaks]);
  const legacy = shown.legacyTokens ?? [];
  const doc = useMemo(() => previewDoc(shown.html, legacy, tweaks), [shown.html, legacy, tweaks]);
  const latestDoc = useMemo(() => previewDoc(design.data.html, design.data.legacyTokens ?? [], design.data.tweaks ?? []), [design.data.html, design.data.legacyTokens, design.data.tweaks]);
  const vars = useMemo(() => tweakVars(tweaks, draft), [tweaks, draft]);

  const open = useMemo(() => comments.filter((c) => c.status !== 'resolved').sort((a, b) => a.createdAt.localeCompare(b.createdAt)), [comments]);
  const resolved = useMemo(() => comments.filter((c) => c.status === 'resolved'), [comments]);
  const pinKey = open.map((c) => c.selector ?? '').join('|');
  // open 每次刷新都是新数组，内容没变时不要重排评论钉
  const pins = useMemo<Pin[]>(() => open.map((c, i) => ({ n: i + 1, selector: c.selector ?? '', active: activePin === i + 1 })), [pinKey, activePin]);
  const designRef = { design: { id: design.id, title: design.data.title, version: pinned ?? design.version } };
  const dirty = Object.keys(draft).length > 0;
  const status = design.data.status ?? 'draft';

  useEffect(() => setIssues([]), [doc]);

  const patch = useMutation({
    mutationFn: async (input: { data: Partial<DesignData>; reason: string }) =>
      unwrap(await api.entities[':id'].$patch({ param: { id: design.id }, json: { data: { ...design.data, ...input.data }, baseVersion: design.version, reason: input.reason } })),
  });
  const rollback = useMutation({
    mutationFn: async (version: number) => unwrap(await api.entities[':id'].rollback.$post({ param: { id: design.id }, json: { version } })),
    onSuccess: () => setPinned(null),
  });
  const addComment = useMutation({
    mutationFn: async (input: { body: string; target: PendingComment }) =>
      unwrap(await api.workstations[':id'].entities.$post({ param: { id: ws.id }, json: { entityType: 'DesignComment', data: { design: design.id, version: design.version, selector: input.target.selector, anchor: input.target.anchor, body: input.body, status: 'open' } } })),
    onSuccess: () => setPending(null),
  });
  const resolve = useMutation({
    mutationFn: async (c: DesignComment) => {
      const { id, rowVersion, authorType, authorId, createdAt, ...data } = c;
      void [authorType, authorId, createdAt];
      return unwrap(await api.entities[':id'].$patch({ param: { id }, json: { data: { ...data, status: 'resolved', note: '人工标记解决' }, baseVersion: rowVersion } }));
    },
  });
  const send = useMutation({
    mutationFn: async (content: string) => {
      if (!designer) throw new Error('本台没有设计师');
      const id = chatThread ?? thread.data?.thread.id;
      if (!id) throw new Error('会话还没加载好');
      return unwrap(await api.threads[':id'].messages.$post({ param: { id }, json: { content, meta: designRef } }));
    },
    onSuccess: () => setRail('chat'),
  });

  const onFrame = (e: FrameEvent) => {
    if (e.type === 'pick') {
      setPending(e);
      setRail('comments');
      setRailOpen(true);
    } else if (e.type === 'pin') {
      setActivePin(e.n);
      setRail('comments');
      setRailOpen(true);
    } else if (e.type === 'missing') {
      setMissing((cur) => (cur.join() === e.pins.join() ? cur : e.pins));
    } else if (e.type === 'issue') {
      setIssues((cur) => (cur.includes(e.text) ? cur : [...cur, e.text].slice(-20)));
    } else if (e.type === 'select') {
      setSel(e.items);
      if (e.items.length > 0) {
        setRail('chat');
        setRailOpen(true);
      }
    } else {
      const r = applyElementText(design.data.html, e.selector, e.text);
      if (r.ok) patch.mutate({ data: { html: r.html, status: 'draft' }, reason: `直接改字：${e.text.slice(0, 30)}` });
      else toast(r.error);
    }
  };

  const changeMode = (m: CanvasMode) => {
    setMode(m);
    if (m === 'comment') setRail('comments');
  };

  const exportHtml = () => {
    const url = URL.createObjectURL(new Blob([exportDoc(shown.html, legacy, applyDraft(tweaks, draft))], { type: 'text/html;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadName(shown.title, pinned ?? design.version);
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportRender = async (format: 'png' | 'pdf', viewport: 'desktop' | 'tablet' | 'mobile') => {
    try {
      const res = await fetch(`/api/designs/${design.id}/export?format=${format}&viewport=${viewport}&version=${pinned ?? design.version}`);
      if (!res.ok) throw new Error(parseJson<{ error?: string }>(await res.text(), {}).error ?? `导出失败（${res.status}）`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = downloadName(shown.title, pinned ?? design.version).replace(/\.html$/, `.${format}`);
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast(e instanceof Error ? e.message : '导出失败');
    }
  };

  const cmpDesigns = useMemo(() => compareDesigns(designs, design.id), [designs, design.id]);
  const enterCompare = () => {
    const prev = (versions.data ?? []).map((v) => v.version).filter((v) => v < design.version).sort((a, b) => b - a)[0] ?? design.version;
    setCmp({ a: { id: design.id, version: pinned ?? prev }, b: { id: design.id, version: design.version } });
  };

  return (
    <div className="relative flex min-h-0 flex-1" data-testid="design-canvas">
      {railOpen && (
        <aside className="relative flex w-[22rem] shrink-0 flex-col border-r border-rule bg-paper max-md:absolute max-md:inset-0 max-md:z-20 max-md:w-full" style={{ width: railWidth }} aria-label="设计侧栏">
          <ResizeHandle {...railResize} />
          <div className="flex shrink-0 items-center border-b border-rule px-1">
            <RailTabButton on={rail === 'chat'} onClick={() => setRail('chat')} label="对话" testId="rail-chat" />
            <RailTabButton on={rail === 'comments'} onClick={() => setRail('comments')} label="评论" count={open.length} testId="rail-comments" />
            <RailTabButton on={rail === 'tweaks'} onClick={() => setRail('tweaks')} label="旋钮" count={tweaks.length} testId="rail-tweaks" />
            <button type="button" className="ml-auto grid size-7 place-items-center rounded-pill text-muted hover:bg-hover hover:text-ink md:hidden" aria-label="收起侧栏" onClick={() => setRailOpen(false)}><Icon name="chev" className="rotate-90" /></button>
          </div>
          <div className={cn('flex min-h-0 flex-1 flex-col', rail !== 'chat' && 'hidden')}>
            {designer ? (
              <DesignChat
                ws={ws} project={project} designer={designer} threadId={chatThread} onThread={onChatThread}
                meta={{ ...designRef, ...(sel.length > 0 ? { elements: sel } : {}) }}
                hint={`对话针对「${design.data.title}」`} placeholder="想怎么改？比如：标题再大胆一点"
                selection={{ items: sel, onRemove: (s) => setSel((cur) => cur.filter((x) => x.selector !== s)), onClear: () => setSel([]) }}
                onSent={() => setSel([])}
              />
            ) : <p className="p-3 text-sm text-muted">本台没有设计师，到「成员」里添加</p>}
          </div>
          {rail === 'comments' && (
            <CommentsPane open={open} resolved={resolved} active={activePin} missing={missing} pending={pending} names={names} canSend={!old && !!designer} sending={send.isPending}
              onFocus={setActivePin} onResolve={(c) => resolve.mutate(c)} onCancelPending={() => setPending(null)}
              onSubmit={(body) => pending && addComment.mutate({ body, target: pending })}
              onSend={() => send.mutate(commentsPrompt(design.id, open))} />
          )}
          {rail === 'tweaks' && (
            <TweaksPane tweaks={tweaks} draft={draft} dirty={dirty} saving={patch.isPending} disabled={old}
              onChange={(id, v) => setDraft((d) => ({ ...d, [id]: v }))} onReset={() => setDraft({})}
              onSave={() => patch.mutate({ data: { tweaks: applyDraft(tweaks, draft) }, reason: '调整旋钮' }, { onSuccess: () => setDraft({}) })} />
          )}
        </aside>
      )}

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-rule px-2 py-1.5">
          <Button variant="quiet" onClick={onBack} data-testid="canvas-back" aria-label="返回设计稿列表"><Icon name="chev" className="size-3.5 rotate-90" />全部</Button>
          <Button variant="quiet" aria-pressed={railOpen} onClick={() => setRailOpen((v) => !v)} className="aria-pressed:bg-paper-3 aria-pressed:text-ink">侧栏</Button>
          <h2 className="max-w-[16rem] truncate text-sm font-semibold text-ink" title={design.data.title}>{design.data.title}</h2>
          <Badge tone={status === 'draft' ? 'neutral' : 'ok'}>{STATUS_LABEL[status]}</Badge>
          {running && <span className="animate-pulse-soft text-xs text-cool" data-testid="canvas-running">设计师工作中…</span>}
          <span className="flex-1" />
          <Segmented label="模式" testId="canvas-mode" value={old ? 'view' : mode} options={MODES} onChange={changeMode} disabled={old || !!cmp} />
          <Segmented label="设备" value={device} options={DEVICES.map(({ id, label }) => ({ id, label }))} onChange={setDevice} />
          <Button variant="quiet" aria-pressed={!!cmp} onClick={() => (cmp ? setCmp(null) : enterCompare())} className="aria-pressed:bg-paper-3 aria-pressed:text-ink" data-testid="canvas-compare">{cmp ? '退出对比' : '对比'}</Button>
          <Popover
            className="max-h-[60vh] w-80 overflow-y-auto"
            trigger={(on, toggle) => <Button aria-expanded={on} onClick={toggle} data-testid="version-button"><Icon name="clock" className="size-3.5" />v{pinned ?? design.version}</Button>}
          >
            {(close) => (versions.data ?? []).map((v) => (
              <MenuItem key={v.version} className={cn('whitespace-normal', (pinned ?? design.version) === v.version && 'bg-hover')} onClick={() => { setPinned(v.version === design.version ? null : v.version); close(); }} data-testid="version-item">
                <span className="measured text-ink">v{v.version}</span>
                <span className="ml-2 text-xs text-muted">{v.authorType === 'human' ? '你' : (names[v.authorId ?? ''] ?? 'Agent')} · {when(v.createdAt)}</span>
                {v.reason && <span className="block text-xs text-muted">{v.reason}</span>}
              </MenuItem>
            ))}
          </Popover>
          {issues.length > 0 && (
            <Popover
              className="w-80"
              trigger={(on, toggle) => <Button aria-expanded={on} onClick={toggle} className="text-bad" data-testid="issues-button">{issues.length} 个问题</Button>}
            >
              {(close) => (
                <div className="p-1">
                  <ul className="max-h-48 space-y-1 overflow-y-auto text-xs text-ink-2">{issues.map((t) => <li key={t} className="break-words">{t}</li>)}</ul>
                  <Button className="mt-2 w-full" onClick={() => { send.mutate(issuesPrompt(issues)); close(); }}>让设计师修</Button>
                </div>
              )}
            </Popover>
          )}
          <Popover
            className="w-44"
            trigger={(on, toggle) => <Button variant="quiet" aria-expanded={on} aria-label="更多操作" onClick={toggle} data-testid="canvas-more"><Icon name="menu" className="size-3.5" /></Button>}
          >
            {(close) => (
              <>
                <MenuItem onClick={() => { exportHtml(); close(); }} data-testid="canvas-export">下载 HTML</MenuItem>
                <MenuItem onClick={() => { void exportRender('png', 'desktop'); close(); }} data-testid="canvas-export-png">PNG（桌面）</MenuItem>
                <MenuItem onClick={() => { void exportRender('png', 'tablet'); close(); }}>PNG（平板）</MenuItem>
                <MenuItem onClick={() => { void exportRender('png', 'mobile'); close(); }}>PNG（手机）</MenuItem>
                <MenuItem onClick={() => { void exportRender('pdf', 'desktop'); close(); }} data-testid="canvas-export-pdf">PDF</MenuItem>
                <MenuItem onClick={() => { void stage.current?.requestFullscreen(); close(); }}>全屏演示</MenuItem>
                {status !== 'handed_off' && <MenuItem onClick={() => { patch.mutate({ data: { status: status === 'approved' ? 'draft' : 'approved' }, reason: status === 'approved' ? '取消定稿' : '定稿' }); close(); }} data-testid="canvas-approve">{status === 'approved' ? '取消定稿' : '标记为定稿'}</MenuItem>}
                <MenuItem danger disabled={remove.pending} onClick={() => { close(); remove.confirmDelete(design); }} data-testid="canvas-delete">删除设计稿</MenuItem>
              </>
            )}
          </Popover>
          <Button variant="primary" onClick={() => setHandoff(true)} data-testid="canvas-handoff">生成实现任务</Button>
        </div>

        {old && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-rule bg-accent-soft px-3 py-1.5 text-sm text-ink-2" data-testid="version-banner">
            <span className="min-w-0 flex-1">正在看历史版本 v{pinned}，最新是 v{design.version}</span>
            <Button aria-pressed={compare} onClick={() => setCompare((v) => !v)} className="aria-pressed:bg-paper-3">{compare ? '单独看' : '并排对比'}</Button>
            <Button onClick={() => setPinned(null)}>回到最新</Button>
            <Button variant="primary" disabled={rollback.isPending} onClick={() => rollback.mutate(pinned!)} data-testid="version-restore">恢复这个版本</Button>
          </div>
        )}

        <div ref={stage} className="flex min-h-0 flex-1 bg-paper-3">
          {cmp ? (
            <>
              <CompareSide sel={cmp.a} designs={cmpDesigns} device={device} onSel={(a) => setCmp({ ...cmp, a })} testId="compare-left" />
              <div className="flex min-w-0 flex-1 border-l border-rule">
                <CompareSide sel={cmp.b} designs={cmpDesigns} device={device} onSel={(b) => setCmp({ ...cmp, b })} testId="compare-right" />
              </div>
            </>
          ) : (
            <>
              <DesignFrame doc={doc} title={shown.title} device={device} mode={old ? 'view' : mode} pins={pins} vars={vars} selected={sel.map((s) => s.selector)} onEvent={onFrame} testId="design-frame" {...(old && compare ? { caption: `v${pinned}` } : {})} />
              {old && compare && <div className="flex min-w-0 flex-1 border-l border-rule"><DesignFrame doc={latestDoc} title={`${design.data.title} 最新版本`} device={device} caption={`v${design.version}（最新）`} /></div>}
            </>
          )}
        </div>
      </section>
      {handoff && <HandoffDialog design={design} ws={ws} project={project} openComments={open.length} onClose={() => setHandoff(false)} />}
    </div>
  );
}

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { MessageMeta } from '@/components/chat/Composer';
import { ThreadView } from '@/components/chat/Thread';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { when } from '@/lib/format';
import { nameMaps, useAgentThread, useConversations, type ProjectDetail, type WorkstationDetail } from '@/lib/queries';
import type { SelectItem } from './model';

const label = (c: { title: string | null; lastAt: string }) => c.title ?? `会话 · ${when(c.lastAt)}`;

export interface DesignSelection { items: SelectItem[]; onRemove: (selector: string) => void; onClear: () => void }

// 画布里选中的元素作为待发上下文列在输入框上方；发给设计师后由 onSent 清掉
function SelectionRow({ selection }: { selection: DesignSelection }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-rule bg-paper-2 px-2.5 py-1.5" data-testid="design-selection">
      <span className="shrink-0 text-xs text-muted">已选 {selection.items.length} 个元素</span>
      {selection.items.map((it) => (
        <span key={it.selector} className="flex items-center gap-1 rounded-chip border border-rule bg-paper px-1.5 py-0.5 text-xs text-ink-2" title={it.selector}>
          <span className="measured text-muted">&lt;{it.tag}&gt;</span>
          <span className="max-w-36 truncate">{it.anchor || it.selector}</span>
          <button type="button" aria-label="移出所选" className="text-faint hover:text-ink" onClick={() => selection.onRemove(it.selector)}>×</button>
        </span>
      ))}
      <button type="button" className="ml-auto text-xs text-muted hover:text-ink" onClick={selection.onClear} data-testid="design-selection-clear">清除</button>
    </div>
  );
}

// 设计侧栏的对话：对象固定是设计师，只能在ta的会话间切换或新建（D29 后 steward 是 architect，不能落到负责人）
export function DesignChat({ ws, project, designer, threadId, onThread, meta, hint, placeholder, selection, onSent }: {
  ws: WorkstationDetail;
  project: ProjectDetail;
  designer: WorkstationDetail['agents'][number];
  threadId: string | null;
  onThread: (id: string) => void;
  meta?: MessageMeta | undefined;
  hint?: string | undefined;
  placeholder?: string | undefined;
  selection?: DesignSelection | undefined;
  onSent?: (() => void) | undefined;
}) {
  const names = nameMaps(project).agent;
  const qc = useQueryClient();
  const conversations = useConversations(ws.id);
  const dm = useAgentThread(designer.id);
  const convs = useMemo(
    () => (conversations.data?.conversations ?? []).filter((c) => c.kind === 'dm' && c.agentIds[0] === designer.id),
    [conversations.data, designer.id],
  );
  const selId = threadId ?? dm.data?.thread.id ?? null;
  const sel = convs.find((c) => c.id === selId) ?? (selId && dm.data?.thread.id === selId ? dm.data.thread : null);
  // 默认私聊是懒建的，可能还没进会话列表：先补一项让 select 不空白
  const options = selId && !convs.some((c) => c.id === selId) ? [{ id: selId, label: designer.name }, ...convs.map((c) => ({ id: c.id, label: label(c) }))] : convs.map((c) => ({ id: c.id, label: label(c) }));

  const create = useMutation({
    mutationFn: async () => unwrap(await api.workstations[':id'].conversations.$post({ param: { id: ws.id }, json: { agentIds: [designer.id] } })),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['conversations', ws.id] });
      onThread(r.thread.id);
    },
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="design-chat">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-rule px-2 py-1.5">
        <span className="shrink-0 text-xs font-medium text-ink">和设计师对话</span>
        <Select className="h-7 min-w-0 flex-1 text-xs" value={selId ?? ''} onChange={(e) => onThread(e.target.value)} data-testid="design-chat-thread" aria-label="选择会话">
          {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </Select>
        <Button size="sm" variant="quiet" className="shrink-0" disabled={create.isPending} onClick={() => create.mutate()} data-testid="design-chat-new">新建会话</Button>
      </div>
      {sel ? (
        <ThreadView thread={sel} projectId={project.id} names={names} hint={hint ?? '只有你和它能看到'} placeholder={selection && selection.items.length > 0 ? '告诉设计师怎么改选中的元素' : placeholder} meta={meta} composerTop={selection && selection.items.length > 0 ? <SelectionRow selection={selection} /> : undefined} onSent={onSent} />
      ) : (
        <p className="p-3 text-sm text-muted">加载会话…</p>
      )}
    </div>
  );
}

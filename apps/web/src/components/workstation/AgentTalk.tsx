import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ThreadView } from '@/components/chat/Thread';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogForm } from '@/components/ui/dialog';
import { Empty } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/icons';
import { Field, Input } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { when } from '@/lib/format';
import { nameMaps, useConversations, type ConversationRow, type ProjectDetail, type WorkstationDetail } from '@/lib/queries';
import { cn } from '@/lib/utils';

function membersOf(c: ConversationRow, names: Record<string, string>) {
  return c.agentIds.map((id) => names[id] ?? '?').join('、');
}

function NewConversationDialog({ ws, onClose, onCreated }: { ws: WorkstationDetail; onClose: () => void; onCreated: (threadId: string) => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const qc = useQueryClient();
  const create = useMutation({
    meta: { silent: true },
    mutationFn: async () => unwrap(await api.workstations[':id'].conversations.$post({ param: { id: ws.id }, json: { agentIds: picked, ...(title.trim() ? { title: title.trim() } : {}) } })),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['conversations', ws.id] });
      onCreated(r.thread.id);
    },
  });
  const toggle = (id: string) => setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  return (
    <Dialog title="新建会话" onClose={onClose} testId="conv-new-dialog">
      <DialogForm error={create.error?.message} submitting={create.isPending} submitLabel={picked.length >= 2 ? '建群' : '开始私聊'} canSubmit={picked.length >= 1} onSubmit={() => create.mutate()} onCancel={onClose}>
        <Field label="成员" required hint="选一个开始私聊，选多个建群；群主默认是负责人">
          <ul className="max-h-56 space-y-0.5 overflow-y-auto">
            {ws.agents.map((a) => (
              <li key={a.id}>
                <label className="flex cursor-pointer items-center gap-2 rounded-chip px-2 py-1.5 text-sm hover:bg-hover">
                  <input type="checkbox" checked={picked.includes(a.id)} onChange={() => toggle(a.id)} data-testid={`conv-member-${a.id}`} />
                  <span className="min-w-0 flex-1 truncate">{a.name}</span>
                  {a.isSteward === 1 && <Badge tone="neutral">负责人</Badge>}
                </label>
              </li>
            ))}
          </ul>
        </Field>
        <Field label="标题" hint="不填的话，第一条消息自动起题">
          <Input value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} data-testid="conv-title" />
        </Field>
      </DialogForm>
    </Dialog>
  );
}

// 工作台级 Agent 页：左边会话列表，右边选中的会话
export function AgentTalk({ ws, project, selected, onSelect }: { ws: WorkstationDetail; project: ProjectDetail; selected: string | undefined; onSelect: (id: string | null) => void }) {
  const conversations = useConversations(ws.id);
  const names = nameMaps(project).agent;
  const [creating, setCreating] = useState(false);
  const convs = conversations.data?.conversations ?? [];
  const current = convs.find((c) => c.id === selected);
  return (
    <div className="flex min-h-0 flex-1" data-testid="agent-talk">
      <aside className="flex w-72 shrink-0 flex-col border-r border-rule bg-paper">
        <div className="flex shrink-0 items-center gap-2 border-b border-rule px-3 py-2">
          <h2 className="text-sm font-medium">会话</h2>
          <Button size="sm" variant="quiet" className="ml-auto" onClick={() => setCreating(true)} data-testid="conv-new-open">
            <Icon name="plus" />新建
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {convs.length === 0 && <p className="p-2 text-sm text-muted">还没有会话。点「新建」，选一个成员私聊，或多选几位建群。</p>}
          <ul className="space-y-1">
            {convs.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  aria-pressed={c.id === selected}
                  onClick={() => onSelect(c.id === selected ? null : c.id)}
                  className={cn('w-full rounded-card border bg-paper p-2.5 text-left', c.id === selected ? 'border-ink/40 bg-paper-3' : 'border-rule hover:border-ink/30')}
                  data-testid={`conv-item-${c.id}`}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.title ?? '新会话'}</span>
                    <Badge tone="neutral">{c.kind === 'group' ? '群聊' : '私聊'}</Badge>
                    <span className="shrink-0 text-xs text-faint">{when(c.lastAt)}</span>
                  </div>
                  <div className="mt-1 truncate text-xs text-muted">{membersOf(c, names)}{c.lastPreview ? ` · ${c.lastPreview}` : ''}</div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </aside>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {current ? (
          <ThreadView thread={current} projectId={project.id} names={names} wide hint={current.kind === 'group' ? '@ 点名成员，没人点名时群主接话' : '只有你和它能看到'} />
        ) : (
          <Empty title="选一条会话">左边挑一条，或者点「新建」开私聊、拉群。</Empty>
        )}
      </section>
      {creating && <NewConversationDialog ws={ws} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); onSelect(id); }} />}
    </div>
  );
}

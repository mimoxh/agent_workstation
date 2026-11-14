import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useAgentThread, useConversations, type ConversationRow, type WorkstationDetail } from '@/lib/queries';
import { Select } from '@/components/ui/input';
import type { MessageMeta } from './Composer';
import { ThreadView, WsThread } from './Thread';

type Target = { type: 'ws' } | { type: 'dm'; agentId: string } | { type: 'thread'; id: string };

const ROOT_HINT = '项目经理会起草任务，确认后派发';
const ROOT_PLACEHOLDER = '说目标，比如：给任务看板加状态筛选';
const DM_HINT = '只有你和它能看到';
const GROUP_HINT = '@ 点名成员，没人点名时群主接话';

function convLabel(c: ConversationRow, names: Record<string, string>) {
  if (c.kind === 'group') return `群聊 ${c.title ?? '新会话'}`;
  const who = names[c.agentIds[0] ?? ''] ?? '私聊';
  return `私聊 ${who}${c.title && c.title !== who ? ` · ${c.title}` : ''}`;
}

function AgentDm({ agentId, projectId, names, hint, placeholder, meta }: { agentId: string; projectId: string; names: Record<string, string>; hint: string; placeholder?: string | undefined; meta?: MessageMeta | undefined }) {
  const th = useAgentThread(agentId);
  if (!th.data) return <p className="p-3 text-sm text-muted">加载会话…</p>;
  return <ThreadView thread={th.data.thread} projectId={projectId} names={names} hint={hint} placeholder={placeholder} meta={meta} />;
}

// 「和 Agent 对话」侧栏：默认本台负责人私聊，可切成员、大群或已有会话
export function ChatRail({ ws, projectId, names, root, meta, hint, placeholder, defaultAgentId }: { ws: WorkstationDetail; projectId: string; names: Record<string, string>; root: boolean; meta?: MessageMeta | undefined; hint?: string | undefined; placeholder?: string | undefined; defaultAgentId?: string | undefined }) {
  const steward = ws.agents.find((a) => a.isSteward === 1);
  const first = (defaultAgentId ? ws.agents.find((a) => a.id === defaultAgentId) : undefined) ?? steward;
  const [sel, setSel] = useState<Target>(first ? { type: 'dm', agentId: first.id } : { type: 'ws' });
  const conversations = useConversations(ws.id);
  const convs = useMemo(() => (conversations.data?.conversations ?? []).filter((c) => !c.archivedAt || (sel.type === 'thread' && c.id === sel.id)), [conversations.data, sel]);
  const others = ws.agents.filter((a) => a.id !== steward?.id);

  const value = sel.type === 'ws' ? 'ws' : sel.type === 'dm' ? `dm:${sel.agentId}` : `thread:${sel.id}`;
  const pick = (v: string) => {
    if (v === 'ws') setSel({ type: 'ws' });
    else if (v.startsWith('dm:')) setSel({ type: 'dm', agentId: v.slice(3) });
    else if (v.startsWith('thread:')) setSel({ type: 'thread', id: v.slice(7) });
  };

  let body;
  if (sel.type === 'ws') {
    body = <WsThread wsId={ws.id} projectId={projectId} names={names} root={root} meta={meta} hint={hint} placeholder={placeholder} />;
  } else if (sel.type === 'dm') {
    body = <AgentDm agentId={sel.agentId} projectId={projectId} names={names} meta={meta} hint={root && sel.agentId === steward?.id ? ROOT_HINT : DM_HINT} placeholder={root && sel.agentId === steward?.id ? ROOT_PLACEHOLDER : undefined} />;
  } else {
    const conv = convs.find((c) => c.id === sel.id);
    body = conv
      ? <ThreadView thread={conv} projectId={projectId} names={names} meta={meta} hint={conv.kind === 'group' ? GROUP_HINT : DM_HINT} />
      : <p className="p-3 text-sm text-muted">加载会话…</p>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="chat-rail">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-rule px-2 py-1.5">
        <Select className="h-7 min-w-0 flex-1 text-xs" value={value} onChange={(e) => pick(e.target.value)} data-testid="chat-rail-target" aria-label="选择对话对象">
          {steward && <option value={`dm:${steward.id}`}>{steward.name}（负责人）</option>}
          {others.map((a) => <option key={a.id} value={`dm:${a.id}`}>{a.name}</option>)}
          <option value="ws">{ws.name}大群</option>
          {convs.length > 0 && (
            <optgroup label="会话">
              {convs.map((c) => <option key={c.id} value={`thread:${c.id}`}>{convLabel(c, names)}</option>)}
            </optgroup>
          )}
        </Select>
        <Link to="/projects/$projectId/ws/$wsId" params={{ projectId, wsId: ws.id }} search={{ panel: '_talk' }} className="shrink-0 rounded-chip px-1.5 py-0.5 text-xs text-muted hover:bg-hover hover:text-ink" data-testid="chat-rail-open-agent">Agent 页</Link>
      </div>
      {body}
    </div>
  );
}

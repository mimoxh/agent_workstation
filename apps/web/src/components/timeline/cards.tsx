import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { api, unwrap } from '@/lib/api';
import { clock, parseJson } from '@/lib/format';
import { useChunk } from '@/lib/queries';
import { cn } from '@/lib/utils';

export interface MessageLike {
  id: string;
  senderType: string | null;
  senderId: string | null;
  senderName?: string | null | undefined;
  kind: string | null;
  content: string | null;
  metaJson?: string | null | undefined;
  at: string;
}

const TOKEN = /(@[^\s@，。,.：:]+(?: #\d+)?|\[\[kb:[\w-]+\]\])/g;

function Citation({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const chunk = useChunk(open ? id : null);
  return (
    <>
      <button type="button" className="mx-0.5 rounded-chip bg-tag px-1 text-xs text-tag-ink hover:bg-paper-3" onClick={() => setOpen(true)} data-testid="citation">引用</button>
      {open && (
        <Dialog title={chunk.data?.sourceName ?? '引用'} onClose={() => setOpen(false)} testId="citation-dialog">
          {chunk.data && <p className="mb-2 text-xs text-muted">{chunk.data.anchor.headingPath.join(' › ')}</p>}
          <p className="whitespace-pre-wrap text-sm text-ink-2">{chunk.isError ? '引用的片段已不存在' : chunk.data?.text}</p>
        </Dialog>
      )}
    </>
  );
}

function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split(TOKEN).map((part, i) => {
        if (i % 2 === 0) return part;
        const kb = /^\[\[kb:([\w-]+)\]\]$/.exec(part);
        return kb ? <Citation key={i} id={kb[1]!} /> : <span key={i} className="font-medium text-cool">{part}</span>;
      })}
    </>
  );
}

const senderOf = (m: MessageLike, names: Record<string, string>) => {
  if (m.senderType === 'human') return '本地用户';
  if (m.senderId === 'platform') return '平台';
  return m.senderName ?? names[m.senderId ?? ''] ?? 'Agent';
};

function Lane({ lane }: { lane?: string | null | undefined }) {
  return lane ? <span className="measured ml-2 max-w-40 truncate text-xs text-muted" title={lane}>{lane}</span> : null;
}

export function Avatar({ name, human, className }: { name: string; human?: boolean; className?: string }) {
  return (
    <span aria-hidden className={cn('grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold', human ? 'bg-accent-tag text-accent-tag-ink' : 'bg-tag text-tag-ink', className)}>
      {human ? '你' : name.slice(0, 1)}
    </span>
  );
}

export function ChatRow({ m, names, lane }: { m: MessageLike; names: Record<string, string>; lane?: string | null | undefined }) {
  const human = m.senderType === 'human';
  const who = senderOf(m, names);
  const meta = parseJson<{ design?: { title: string; version: number }; elements?: { tag: string; anchor: string }[] }>(m.metaJson, {});
  const design = meta.design;
  const elements = meta.elements ?? [];
  return (
    <div className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-2.5" data-testid="thread-message">
      <Avatar name={who} human={human} />
      <div className="min-w-0">
        <p className="flex items-baseline">
          <span className="mr-2 text-sm font-semibold text-ink">{who}</span>
          <span className="measured text-xs text-faint">{clock(m.at)}</span>
          <Lane lane={lane} />
        </p>
        {design && <p className="text-xs text-muted" data-testid="message-design">看着 {design.title} v{design.version}</p>}
        {elements.length > 0 && (
          <p className="mt-0.5 flex flex-wrap items-center gap-1" data-testid="message-elements">
            {elements.map((e, i) => (
              <span key={i} className="rounded-chip border border-rule px-1.5 py-0.5 text-xs text-muted"><span className="measured">&lt;{e.tag}&gt;</span> {e.anchor}</span>
            ))}
          </p>
        )}
        <p className="whitespace-pre-wrap text-[0.95rem] leading-relaxed text-ink"><Rich text={m.content ?? ''} /></p>
      </div>
    </div>
  );
}

export function StatusLine({ children, at, lane }: { children: ReactNode; at?: string | undefined; lane?: string | null | undefined }) {
  return (
    <p className="measured flex items-baseline gap-2 pl-[2.375rem] text-xs text-muted">
      <span aria-hidden className="text-cool">•</span>
      <span className="min-w-0 whitespace-pre-wrap">{children}</span>
      {at && <span className="shrink-0">{clock(at)}</span>}
      <Lane lane={lane} />
    </p>
  );
}

export function HandoffCard({ m, lane }: { m: MessageLike; lane?: string | null | undefined }) {
  const meta = parseJson<{ from?: string; to?: string; next?: string }>(m.metaJson, {});
  return (
    <article className="ml-[2.375rem] border-l-[3px] border-ink py-0.5 pl-3.5" data-testid="handoff-card">
      <p className="flex items-baseline gap-2 text-xs text-muted">
        <span className="font-semibold text-ink">交接</span>
        {meta.from && meta.to && <span>{meta.from} → {meta.to}</span>}
        <span className="measured ml-auto shrink-0">{clock(m.at)}</span>
        <Lane lane={lane} />
      </p>
      <p className="mt-0.5 whitespace-pre-wrap text-sm text-ink">{m.content}</p>
      {meta.next && <p className="mt-0.5 text-xs text-muted">下一步：{meta.next}</p>}
    </article>
  );
}

export function DecisionCard({ m, foldedCount, children }: { m: MessageLike; foldedCount: number; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const meta = parseJson<{ openQuestions?: string | null }>(m.metaJson, {});
  const propose = useMutation({ mutationFn: async () => unwrap(await api.messages[':id']['propose-adr'].$post({ param: { id: m.id } })) });
  return (
    <article className="rounded-chip bg-ok-soft px-4 py-3" data-testid="decision-card">
      <p className="flex items-baseline gap-2 text-xs text-muted">
        <span className="font-semibold text-ok">结论</span>
        <span className="measured ml-auto shrink-0">{clock(m.at)}</span>
      </p>
      <p className="mt-0.5 whitespace-pre-wrap text-sm text-ink">{m.content}</p>
      {meta.openQuestions && <p className="mt-1 text-xs text-muted">遗留：{meta.openQuestions}</p>}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {foldedCount > 0 && (
          <Button size="sm" variant="quiet" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="decision-toggle">
            {open ? '收起讨论' : `展开 ${foldedCount} 条讨论`}
          </Button>
        )}
        <Button size="sm" variant="quiet" disabled={propose.isPending || propose.isSuccess} onClick={() => propose.mutate()} data-testid="decision-to-adr">
          {propose.isSuccess ? '已提交 ADR 提案' : '沉淀为 ADR 提案'}
        </Button>
      </div>
      {open && <div className="mt-2 space-y-2 border-t border-rule pt-2">{children}</div>}
    </article>
  );
}

export function DraftLink({ m, projectId }: { m: MessageLike; projectId: string }) {
  const taskId = parseJson<{ draftTaskId?: string }>(m.metaJson, {}).draftTaskId;
  if (!taskId) return null;
  return (
    <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId, taskId }} className="ml-[2.375rem] inline-block text-sm font-medium text-ink underline decoration-rule-2 underline-offset-[3px] hover:decoration-ink" data-testid="draft-link">
      查看草稿并派发
    </Link>
  );
}

// 会话里的一条消息；任务时间线和工作台讨论共用
export function MessageItem({ m, names, projectId, lane }: { m: MessageLike; names: Record<string, string>; projectId: string; lane?: string | null | undefined }) {
  if (m.kind === 'handoff') return <HandoffCard m={m} lane={lane} />;
  if (m.kind === 'status' || m.kind === 'proposal_notice') {
    return (
      <div>
        <StatusLine at={m.at} lane={lane}>{m.senderId === 'platform' ? m.content : `${senderOf(m, names)}：${m.content}`}</StatusLine>
        <DraftLink m={m} projectId={projectId} />
      </div>
    );
  }
  return <ChatRow m={m} names={names} lane={lane} />;
}

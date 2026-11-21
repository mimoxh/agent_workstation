import { Link } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PROPOSAL_LABEL, PROPOSAL_TONE, RUN_LABEL, STATUS_LABEL, TRIGGER_LABEL } from '@/components/board/labels';
import type { BadgeTone } from '@/components/ui/badge';
import { Button, buttonClass } from '@/components/ui/button';
import { Empty, ErrorState, Loading } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/icons';
import { clock, tokens } from '@/lib/format';
import { useTimeline, type TimelineItem } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { DecisionCard, MessageItem, StatusLine, type MessageLike } from './cards';
import { foldByDecision } from './fold';

// 卡片头的实心色条：等人橙、在动蓝、收口绿、出问题红，其余灰
const HEAD: Record<BadgeTone, string> = {
  amber: 'bg-accent text-accent-ink',
  cool: 'bg-cool text-cool-ink',
  ok: 'bg-ok text-ok-ink',
  bad: 'bg-bad text-bad-ink',
  neutral: 'bg-paper-3 text-ink-2',
  line: 'bg-paper-3 text-ink-2',
};

type MessageEntry = Extract<TimelineItem, { type: 'message' }>;

const isMessage = (i: TimelineItem): i is MessageEntry => i.type === 'message';
const toMessage = (i: MessageEntry): MessageLike => ({ id: i.id, senderType: i.senderType, senderId: i.senderId, senderName: i.senderName, kind: i.kind, content: i.content, metaJson: i.metaJson, at: i.at });

// 关键事件之外的过程细节：每次运行、阶段切换、Agent 的收尾语；交接卡已经说明了发生什么
const isDetail = (i: TimelineItem) => i.type === 'run' || i.type === 'stage' || (i.type === 'message' && i.kind === 'status' && i.senderId !== 'platform');

function Entry({ item, projectId, names, stages }: { item: TimelineItem; projectId: string; names: Record<string, string>; stages: Record<string, string> }) {
  switch (item.type) {
    case 'message':
      return <MessageItem m={toMessage(item)} names={names} projectId={projectId} lane={item.lane} />;
    case 'stage':
      return <StatusLine at={item.at} lane={item.lane}>进入阶段「{stages[item.stage] ?? item.stage}」</StatusLine>;
    case 'status':
      return <StatusLine at={item.at} lane={item.lane}>任务状态：{STATUS_LABEL[item.to as keyof typeof STATUS_LABEL] ?? item.to}</StatusLine>;
    case 'interrupt':
      return <StatusLine at={item.at} lane={item.lane}>运行被打断</StatusLine>;
    case 'run':
      return (
        <StatusLine at={item.at} lane={item.lane}>
          <Link to="/projects/$projectId/runs/$runId" params={{ projectId, runId: item.runId }} className="hover:underline" data-testid="timeline-run">
            {item.agentName ?? 'Agent'} 运行（{TRIGGER_LABEL[item.trigger ?? ''] ?? item.trigger}）· {RUN_LABEL[item.status ?? ''] ?? item.status} · {tokens(item.tokens)} tok
          </Link>
        </StatusLine>
      );
    case 'proposal': {
      const waiting = PROPOSAL_TONE[item.status] === 'amber';
      return (
        <article className="ml-[38px] overflow-hidden rounded-card bg-paper shadow-[var(--shadow-card)]" data-testid="proposal-card">
          <p className={cn('flex items-center gap-2 px-4 py-2 text-xs font-bold', HEAD[PROPOSAL_TONE[item.status] ?? 'neutral'])}>
            <Icon name="diff" className="size-3.5" />
            <span>{PROPOSAL_LABEL[item.status] ?? item.status}</span>
            {item.authorName && <span className="min-w-0 truncate font-medium">{item.authorName}</span>}
            <span className="ml-auto shrink-0 font-normal tabular-nums opacity-85">{clock(item.at)}</span>
          </p>
          <div className="flex flex-wrap items-center gap-2.5 px-4 pb-4 pt-3">
            <span className="min-w-0 flex-1 text-sm font-semibold text-ink">{item.reason ?? '改动提案'}</span>
            <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId, taskId: item.taskId }} search={{ view: 'changes' }} className={buttonClass(waiting ? 'primary' : 'default', 'sm')}>审阅</Link>
          </div>
        </article>
      );
    }
    case 'test': {
      const ok = item.passed === item.total;
      return (
        <article className="ml-[38px] overflow-hidden rounded-card bg-paper shadow-[var(--shadow-card)]" data-testid="test-card">
          <p className={cn('flex items-center gap-2 px-4 py-2 text-xs font-bold', ok ? 'bg-ok text-ok-ink' : 'bg-bad text-bad-ink')}>
            <Icon name={ok ? 'check' : 'alert'} className="size-3.5" />
            <span>{ok ? '验收通过' : '验收失败'}</span>
            <span className="tabular-nums font-medium">{item.passed}/{item.total}</span>
            <span className="ml-auto shrink-0 font-normal tabular-nums opacity-85">{clock(item.at)}</span>
          </p>
          {!ok && (
            <div className="px-4 pb-4 pt-3">
              <code className="block truncate rounded-ctl bg-code px-3.5 py-2.5 font-mono text-xs text-code-bad">{item.failed.join('、')}</code>
            </div>
          )}
        </article>
      );
    }
  }
}

// 协作时间线：这件事上发生的一切按时间排成一条流，子任务带泳道标签
// embedded：放进整页滚动里，不自己滚、不自动跳到底
export function Timeline({ taskId, projectId, names, stages, embedded }: { taskId: string; projectId: string; names: Record<string, string>; stages: Record<string, string>; embedded?: boolean }) {
  const q = useTimeline(taskId);
  const logRef = useRef<HTMLDivElement>(null);
  const [detailed, setDetailed] = useState(false);
  const items = q.data;
  const hidden = (items ?? []).filter(isDetail).length;
  const rows = useMemo(
    () => foldByDecision((items ?? []).filter((i) => detailed || !isDetail(i)), (i) => isMessage(i) && i.kind === 'chat', (i) => isMessage(i) && i.kind === 'decision'),
    [items, detailed],
  );

  useEffect(() => {
    const el = logRef.current;
    if (el && !embedded) el.scrollTop = el.scrollHeight;
  }, [items?.length, detailed, embedded]);

  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;

  return (
    <div ref={logRef} className={cn('px-5 py-6 md:px-10 lg:px-14', !embedded && 'h-full min-h-0 overflow-y-auto')} data-testid="timeline">
      <div className="mx-auto flex w-full max-w-[54rem] flex-col gap-4">
      {rows.length === 0 && <Empty title="还没有动态" icon="chat">派发或在下方发话后，协作过程都会出现在这里。</Empty>}
      {hidden > 0 && (
        <Button size="sm" variant="quiet" className="self-start" aria-pressed={detailed} onClick={() => setDetailed(!detailed)} data-testid="timeline-detail">
          {detailed ? '只看关键事件' : `显示全部过程（${hidden} 条）`}
        </Button>
      )}
      {rows.map(({ item, folded }) =>
        isMessage(item) && item.kind === 'decision' ? (
          <DecisionCard key={item.id} m={toMessage(item)} foldedCount={folded.length}>
            {folded.map((f) => <Entry key={f.id} item={f} projectId={projectId} names={names} stages={stages} />)}
          </DecisionCard>
        ) : (
          <Entry key={item.id} item={item} projectId={projectId} names={names} stages={stages} />
        ),
      )}
      </div>
    </div>
  );
}

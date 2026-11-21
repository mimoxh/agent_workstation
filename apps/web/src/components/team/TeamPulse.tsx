import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { TOOL_LABEL } from '@/components/board/labels';
import { DmDialog } from '@/components/chat/Thread';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useTeamPulse, type PulseAgent } from '@/lib/queries';
import { cn } from '@/lib/utils';

const activityOf = (a: PulseAgent) => {
  if (!a.run) return null;
  return a.run.activity ? (TOOL_LABEL[a.run.activity] ?? a.run.activity) : '思考中';
};

function Member({ a, projectId, onDm, highlight }: { a: PulseAgent; projectId: string; onDm: () => void; highlight: boolean }) {
  const paused = a.status === 'paused';
  const activity = activityOf(a);
  return (
    <li className={cn('group mx-2 flex min-h-11 items-center gap-2.5 rounded-ctl px-2 py-1 transition-colors duration-150 hover:bg-hover', !a.run && !highlight && 'opacity-80')} data-testid="member-row">
      <span aria-hidden className={cn('relative grid size-[26px] shrink-0 place-items-center rounded-full text-[11px] font-semibold', a.run ? 'bg-cool-tag text-cool-tag-ink shadow-[0_0_0_2px_var(--color-paper),0_0_0_4px_var(--color-cool)]' : 'bg-tag text-tag-ink')}>{a.name.slice(0, 1)}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className="truncate text-sm font-semibold text-ink">{a.name}</span>
          {a.isSteward === 1 && <span className="measured shrink-0 text-xs font-medium text-cool">steward</span>}
        </span>
        {a.run ? (
          <span className="block truncate text-xs font-medium text-cool" data-testid="member-activity">
            {activity}
            {a.run.taskId && a.run.taskTitle && (
              <>
                {' · '}
                <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId, taskId: a.run.taskId }} className="hover:underline">{a.run.taskTitle}</Link>
              </>
            )}
          </span>
        ) : (
          <span className="block truncate text-xs text-muted" title={a.role ?? undefined}>{a.role}</span>
        )}
      </span>
      <Button size="sm" variant="quiet" className="opacity-0 focus:opacity-100 group-hover:opacity-100" aria-label={`私聊 ${a.name}`} onClick={onDm}>私聊</Button>
      {a.run ? <Badge tone="cool">运行中</Badge> : paused ? <Badge tone="amber">已暂停</Badge> : <Badge>待命</Badge>}
    </li>
  );
}

// 团队脉搏：谁在哪件事上、此刻做到哪一步
export function TeamPulse({ projectId, names, only, highlightTemplates, className }: { projectId: string; names: Record<string, string>; only?: (a: PulseAgent) => boolean; highlightTemplates?: string[]; className?: string }) {
  const pulse = useTeamPulse(projectId);
  const [dm, setDm] = useState<PulseAgent | null>(null);
  const agents = (pulse.data ?? []).filter((a) => !only || only(a));
  const busy = agents.filter((a) => a.run).length;
  return (
    <section className={className} aria-label="成员">
      <h2 className="flex items-center gap-2 px-4 pb-2 pt-4 text-sm font-bold text-ink">
        成员 <span className="font-medium tabular-nums text-muted">{agents.length + 1}</span>
        {busy > 0 && (
          <span className="ml-auto inline-flex items-center gap-1.5 text-xs font-medium tabular-nums text-cool">
            <span aria-hidden className="size-[7px] animate-pulse-soft rounded-full bg-cool" />
            {busy} 在跑
          </span>
        )}
      </h2>
      <ul className="grid gap-px">
        <li className="mx-2 flex min-h-11 items-center gap-2.5 px-2">
          <span aria-hidden className="grid size-[26px] shrink-0 place-items-center rounded-full bg-accent-tag text-[11px] font-semibold text-accent-tag-ink">你</span>
          <span className="text-sm font-semibold text-ink">本地用户</span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted">全权</span>
          <Badge tone="amber">人</Badge>
        </li>
        {agents.map((a) => <Member key={a.id} a={a} projectId={projectId} highlight={highlightTemplates?.includes(a.templateId ?? '') ?? false} onDm={() => setDm(a)} />)}
      </ul>
      {dm && <DmDialog agentId={dm.id} agentName={dm.name} projectId={projectId} names={names} onClose={() => setDm(null)} />}
    </section>
  );
}

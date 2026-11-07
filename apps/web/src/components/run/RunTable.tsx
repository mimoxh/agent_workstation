import { Link } from '@tanstack/react-router';
import { RUN_LABEL, RUN_TONE, TRIGGER_LABEL } from '@/components/board/labels';
import { Badge } from '@/components/ui/badge';
import { duration, shortId, tokens, when } from '@/lib/format';
import type { RunRow } from '@/lib/queries';

const TH = 'px-4 py-2.5 text-left text-sm font-normal text-muted';
const TD = 'px-4 py-2 text-sm text-ink-2';

export function RunTable({ runs, projectId, showTask }: { runs: RunRow[]; projectId: string; showTask: boolean }) {
  return (
    <table className="w-full border-collapse" data-testid="run-table">
      <thead className="sticky top-0 bg-paper">
        <tr className="border-b border-rule">
          <th className={TH}>Run</th>
          <th className={TH}>Agent</th>
          {showTask && <th className={TH}>任务</th>}
          <th className={TH}>模型</th>
          <th className={TH}>触发</th>
          <th className={TH}>状态</th>
          <th className={`${TH} text-right`}>tokens</th>
          <th className={`${TH} text-right`}>耗时</th>
          <th className={`${TH} text-right`}>开始于</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.id} className="border-b border-rule" data-testid="run-row">
            <td className={TD}>
              <Link to="/projects/$projectId/runs/$runId" params={{ projectId, runId: r.id }} className="measured text-xs text-cool hover:underline">{shortId(r.id)}</Link>
            </td>
            <td className={`${TD} whitespace-nowrap`}>{r.agentName ?? '—'}</td>
            {showTask && (
              <td className={`${TD} max-w-56 truncate`}>
                {r.taskId ? <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId, taskId: r.taskId }} className="hover:underline">{r.taskTitle}</Link> : '—'}
              </td>
            )}
            <td className={`${TD} measured whitespace-nowrap text-xs`}>{r.provider}:{r.model}</td>
            <td className={`${TD} text-xs text-muted`}>{TRIGGER_LABEL[r.trigger ?? ''] ?? r.trigger}</td>
            <td className={TD}><Badge tone={RUN_TONE[r.status ?? ''] ?? 'neutral'}>{RUN_LABEL[r.status ?? ''] ?? r.status}</Badge></td>
            <td className={`${TD} measured text-right text-xs`}>{tokens((r.tokensIn ?? 0) + (r.tokensOut ?? 0))}</td>
            <td className={`${TD} measured text-right text-xs`}>{duration(r.startedAt, r.endedAt)}</td>
            <td className={`${TD} measured whitespace-nowrap text-right text-xs`}>{when(r.startedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

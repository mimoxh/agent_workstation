import { Link } from '@tanstack/react-router';
import { RUN_LABEL, RUN_TONE, TRIGGER_LABEL } from '@/components/board/labels';
import { Badge } from '@/components/ui/badge';
import { duration, shortId, tokens, when } from '@/lib/format';
import type { RunRow } from '@/lib/queries';

const TH = 'whitespace-nowrap border-b border-rule bg-paper-2 px-3.5 py-2.5 text-left text-xs font-semibold text-muted';
const TD = 'border-b border-rule px-3.5 py-3 text-sm text-ink-2 group-last:border-b-0';

// overflow-clip 只裁圆角、不成为滚动容器，表头仍能吸顶在外层滚动里
export function RunTable({ runs, projectId, showTask }: { runs: RunRow[]; projectId: string; showTask: boolean }) {
  return (
    <div className="overflow-clip rounded-card bg-paper shadow-[var(--shadow-card)]">
      <table className="w-full border-collapse" data-testid="run-table">
        <thead className="sticky top-0 z-[1]">
          <tr>
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
            <tr key={r.id} className="group transition-colors duration-100 hover:bg-hover" data-testid="run-row">
              <td className={TD}>
                <Link to="/projects/$projectId/runs/$runId" params={{ projectId, runId: r.id }} className="measured text-xs font-medium text-cool hover:underline">{shortId(r.id)}</Link>
              </td>
              <td className={`${TD} whitespace-nowrap font-medium text-ink`}>{r.agentName ?? '—'}</td>
              {showTask && (
                <td className={`${TD} max-w-56 truncate`}>
                  {r.taskId ? <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId, taskId: r.taskId }} className="hover:text-ink hover:underline">{r.taskTitle}</Link> : <span className="text-faint">—</span>}
                </td>
              )}
              <td className={`${TD} measured whitespace-nowrap text-xs text-muted`}>{r.provider}:{r.model}</td>
              <td className={`${TD} whitespace-nowrap text-xs text-muted`}>{TRIGGER_LABEL[r.trigger ?? ''] ?? r.trigger}</td>
              <td className={TD}><Badge tone={RUN_TONE[r.status ?? ''] ?? 'neutral'}>{RUN_LABEL[r.status ?? ''] ?? r.status}</Badge></td>
              <td className={`${TD} measured text-right text-xs`}>{tokens((r.tokensIn ?? 0) + (r.tokensOut ?? 0))}</td>
              <td className={`${TD} measured text-right text-xs`}>{duration(r.startedAt, r.endedAt)}</td>
              <td className={`${TD} whitespace-nowrap text-right text-xs tabular-nums text-muted`}>{when(r.startedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

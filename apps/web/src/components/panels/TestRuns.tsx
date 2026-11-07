import { Link } from '@tanstack/react-router';
import { Fragment, useState } from 'react';
import { TEST_LABEL, TEST_TONE } from '@/components/board/labels';
import { Badge } from '@/components/ui/badge';
import { Empty, ErrorState, Loading } from '@/components/ui/feedback';
import { seconds, when } from '@/lib/format';
import { useArtifact, useTaskTestRuns, useWsTestRuns, type TestRun } from '@/lib/queries';

function Output({ artifactId }: { artifactId: string }) {
  const q = useArtifact(artifactId);
  if (q.isLoading) return <Loading label="读取输出…" className="p-3" />;
  return <pre className="measured max-h-72 overflow-auto whitespace-pre-wrap bg-paper-3 p-3 text-xs text-ink-2">{q.data?.content || '（无输出）'}</pre>;
}

const TH = 'px-4 py-2.5 text-left text-sm font-normal text-muted';
const TD = 'px-4 py-2.5 text-sm text-ink-2';

function TestRunTable({ rows, projectId, showTask }: { rows: TestRun[]; projectId: string; showTask: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="h-full overflow-auto" data-testid="testrun-table">
      <table className="w-full border-collapse">
        <thead className="sticky top-0 bg-paper">
          <tr className="border-b border-rule">
            <th className={TH}>状态</th>
            <th className={TH}>命令</th>
            {showTask && <th className={TH}>任务</th>}
            <th className={`${TH} text-right`}>耗时</th>
            <th className={`${TH} text-right`}>提交</th>
            <th className={`${TH} text-right`}>完成于</th>
            <th className={TH}><span className="sr-only">输出</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <Fragment key={r.id}>
              <tr className="border-b border-rule">
                <td className={TD}><Badge tone={TEST_TONE[r.status ?? ''] ?? 'neutral'}>{TEST_LABEL[r.status ?? ''] ?? r.status}</Badge></td>
                <td className={TD}><code>{r.command}</code></td>
                {showTask && (
                  <td className={`${TD} max-w-56 truncate`}>
                    {r.taskId ? <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId, taskId: r.taskId }} className="hover:underline">{r.taskTitle}</Link> : '—'}
                  </td>
                )}
                <td className={`${TD} measured text-right text-xs`}>{seconds(r.duration)}</td>
                <td className={`${TD} measured text-right text-xs`}>{r.commit_sha?.slice(0, 7) ?? '—'}</td>
                <td className={`${TD} measured text-right text-xs`}>{when(r.createdAt)}</td>
                <td className={`${TD} text-right`}>
                  {r.output_ref && (
                    <button type="button" className="text-xs text-cool hover:underline" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>
                      {open === r.id ? '收起' : '输出'}
                    </button>
                  )}
                </td>
              </tr>
              {open === r.id && r.output_ref && (
                <tr className="border-b border-rule">
                  <td colSpan={showTask ? 7 : 6}><Output artifactId={r.output_ref} /></td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function WsTestRunsPanel({ wsId, projectId }: { wsId: string; projectId: string }) {
  const q = useWsTestRuns(wsId);
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} />;
  if (!q.data?.length) return <Empty title="暂无测试记录">任务进入测试阶段后，平台执行验收命令并把结果作为证据留在这里。</Empty>;
  return <TestRunTable rows={q.data} projectId={projectId} showTask />;
}

export function TaskTestRunsPanel({ taskId, projectId }: { taskId: string; projectId: string }) {
  const q = useTaskTestRuns(taskId);
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} />;
  if (!q.data?.length) return <Empty title="验收还没有运行" />;
  return <TestRunTable rows={q.data} projectId={projectId} showTask={false} />;
}

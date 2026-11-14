import { Link } from '@tanstack/react-router';
import { Fragment, useState } from 'react';
import { TEST_LABEL, TEST_TONE } from '@/components/board/labels';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, ErrorState, Loading } from '@/components/ui/feedback';
import { seconds, when } from '@/lib/format';
import { useArtifact, useTaskTestRuns, type TestRun } from '@/lib/queries';

interface DesignMatchMeta { kind: 'design_match'; ratio?: number; maxDiff?: number; designShot?: string; actualShot?: string; diffShot?: string | null }

const shotUrl = (id: string) => `/api/artifacts/${id}/image`;

// 设计稿对比的三张图：设计稿 / 实现 / 差异；叠加把实现盖在稿子上调透明度对位
function DesignMatchOutput({ meta, output }: { meta: DesignMatchMeta; output: string }) {
  const [overlay, setOverlay] = useState(false);
  const [opacity, setOpacity] = useState(0.5);
  const limit = meta.maxDiff ?? 0.25;
  const shots = [
    { id: meta.designShot, label: '设计稿' },
    { id: meta.actualShot, label: '实现' },
    { id: meta.diffShot, label: '差异' },
  ].filter((s): s is { id: string; label: string } => !!s.id);
  return (
    <div className="space-y-2 bg-paper-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        {typeof meta.ratio === 'number' && <Badge tone={meta.ratio <= limit ? 'ok' : 'bad'}>差异 {(meta.ratio * 100).toFixed(2)}% · 上限 {(limit * 100).toFixed(0)}%</Badge>}
        <span className="text-xs text-muted">{output}</span>
        {meta.designShot && meta.actualShot && (
          <>
            <Button size="sm" variant="quiet" aria-pressed={overlay} onClick={() => setOverlay((v) => !v)} className="aria-pressed:bg-paper aria-pressed:text-ink" data-testid="design-match-overlay">叠加</Button>
            {overlay && <input type="range" min={0} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} aria-label="实现图层透明度" data-testid="design-match-opacity" />}
          </>
        )}
      </div>
      {overlay && meta.designShot && meta.actualShot ? (
        <div className="relative inline-block max-w-full" data-testid="design-match-stack">
          <img src={shotUrl(meta.designShot)} alt="设计稿" className="block max-w-full rounded-card border border-rule" />
          <img src={shotUrl(meta.actualShot)} alt="实现" className="absolute inset-0 size-full rounded-card" style={{ opacity }} />
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-3">
          {shots.map((s) => (
            <figure key={s.id} className="min-w-0">
              <img src={shotUrl(s.id)} alt={s.label} className="w-full rounded-card border border-rule" data-testid={`design-match-${s.label}`} />
              <figcaption className="mt-1 text-center text-xs text-muted">{s.label}</figcaption>
            </figure>
          ))}
        </div>
      )}
    </div>
  );
}

function Output({ artifactId }: { artifactId: string }) {
  const q = useArtifact(artifactId);
  if (q.isLoading) return <Loading label="读取输出…" className="p-3" />;
  const meta = q.data?.meta as DesignMatchMeta | null;
  if (meta?.kind === 'design_match') return <DesignMatchOutput meta={meta} output={q.data?.content ?? ''} />;
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

export function TaskTestRunsPanel({ taskId, projectId }: { taskId: string; projectId: string }) {
  const q = useTaskTestRuns(taskId);
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} />;
  if (!q.data?.length) return <Empty title="验收还没有运行" />;
  return <TestRunTable rows={q.data} projectId={projectId} showTask={false} />;
}

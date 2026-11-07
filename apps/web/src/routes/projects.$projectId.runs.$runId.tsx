import { useMutation } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { RUN_LABEL, RUN_TONE, TRIGGER_LABEL } from '@/components/board/labels';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, ErrorState, Loading } from '@/components/ui/feedback';
import { api, unwrap } from '@/lib/api';
import { clock, duration, money, num, shortId } from '@/lib/format';
import { useRun } from '@/lib/queries';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/projects/$projectId/runs/$runId')({ component: RunPage });

interface Step {
  t: string;
  type: 'model' | 'tool' | 'fallback';
  from?: string;
  to?: string;
  text?: string;
  toolCalls?: { id: string; name: string; args: unknown }[];
  usage?: { inputTokens?: number; outputTokens?: number };
  usageEstimated?: boolean;
  name?: string;
  args?: unknown;
  result?: unknown;
  truncated?: boolean;
  ms?: number;
  error?: string;
}

const pretty = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));

function Block({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <p className="mb-1 text-xs text-muted">{label}</p>
      <pre className="measured max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-pill bg-paper-3 p-2 text-xs text-ink-2">{pretty(value)}</pre>
    </div>
  );
}

function StepRow({ s, open, onRetry }: { s: Step; open: boolean; onRetry?: (() => void) | undefined }) {
  const model = s.type === 'model';
  if (s.type === 'fallback') {
    return <p className="rounded-pill border-l-2 border-accent bg-accent-soft px-3 py-2 text-sm text-ink-2" data-testid="trace-fallback">{s.from} 不可用，切到 {s.to}{s.error ? `：${s.error}` : ''}</p>;
  }
  return (
    <details className={cn('rounded-pill border border-rule bg-paper-2', s.error && 'border-l-2 border-l-bad')} open={open} data-testid="trace-step">
      <summary className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
        <span className="measured w-16 shrink-0 text-xs text-muted">{clock(s.t)}</span>
        <span className={cn('min-w-0 flex-1 truncate', model ? 'text-ink-2' : 'text-cool')}>
          {model ? (s.toolCalls?.length ? `模型 → ${s.toolCalls.map((c) => c.name).join('、')}` : '模型回复') : `工具 ${s.name}`}
        </span>
        {s.error && <Badge tone="bad">出错</Badge>}
        {s.usage && <span className="measured shrink-0 text-xs text-muted">{s.usage.inputTokens ?? 0}+{s.usage.outputTokens ?? 0} tok{s.usageEstimated ? '（估）' : ''}</span>}
        {s.ms !== undefined && <span className="measured shrink-0 text-xs text-muted">{s.ms}ms</span>}
      </summary>
      <div className="space-y-2 border-t border-rule p-3">
        {s.text && <p className="whitespace-pre-wrap text-sm text-ink-2">{s.text}</p>}
        {s.toolCalls?.map((c) => <Block key={c.id} label={c.name} value={c.args} />)}
        {s.args !== undefined && <Block label="参数" value={s.args} />}
        {s.result !== undefined && <Block label={s.truncated ? '结果（已截断）' : '结果'} value={s.result} />}
        {onRetry && <Button size="sm" onClick={onRetry} data-testid="retry-from">从这一步重试</Button>}
      </div>
    </details>
  );
}

function RunPage() {
  const { projectId, runId } = Route.useParams();
  const run = useRun(runId);
  const [steps, setSteps] = useState<Step[]>([]);
  const [finished, setFinished] = useState(false);
  const cancel = useMutation({ mutationFn: async () => unwrap(await api.runs[':id'].cancel.$post({ param: { id: runId } })) });
  const navigate = useNavigate();
  const retry = useMutation({
    mutationFn: async (step: number) => unwrap(await api.runs[':id'].retry.$post({ param: { id: runId }, json: { step } })),
    onSuccess: (r) => void navigate({ to: '/projects/$projectId/runs/$runId', params: { projectId, runId: r.runId ?? runId } }),
  });

  useEffect(() => {
    setSteps([]);
    setFinished(false);
    const es = new EventSource(`/api/runs/${runId}/stream`);
    es.addEventListener('step', (ev) => setSteps((p) => [...p, JSON.parse((ev as MessageEvent<string>).data) as Step]));
    es.addEventListener('finished', () => {
      setFinished(true);
      es.close();
    });
    return () => es.close();
  }, [runId]);

  if (run.isLoading) return <Loading />;
  if (run.isError || !run.data) return <ErrorState error={run.error} />;
  const r = run.data;
  const status = r.status ?? '';

  return (
    <div className="h-full overflow-y-auto" data-testid="run-page">
      <header className="border-b border-rule bg-paper-2 px-6 py-4">
        <p className="measured text-xs text-muted">run {shortId(r.id)} · {TRIGGER_LABEL[r.trigger ?? ''] ?? r.trigger} · {r.provider}:{r.model}</p>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-[1.75rem] font-bold text-ink">{r.agentName ?? 'Agent'}</h1>
          <Badge tone={RUN_TONE[status] ?? 'neutral'}>{RUN_LABEL[status] ?? status}</Badge>
          {r.stopReason && r.stopReason !== 'completed' && <span className="measured text-xs text-muted">{r.stopReason}</span>}
          <span className="flex-1" />
          {status === 'running' && <Button variant="danger" disabled={cancel.isPending} onClick={() => cancel.mutate()} data-testid="cancel-run">取消运行</Button>}
        </div>
        <p className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted">
          {r.taskId && <span>任务 <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId, taskId: r.taskId }} className="text-cool hover:underline">{r.taskTitle}</Link></span>}
          <span data-testid="run-tokens">tokens <span className="measured text-ink-2">{num(r.tokensIn)}+{num(r.tokensOut)}</span></span>
          <span>耗时 <span className="measured text-ink-2">{duration(r.startedAt, r.endedAt)}</span></span>
          <span>成本 <span className="measured text-ink-2">{money(r.cost)}</span></span>
          {r.fallbackFrom && <span className="text-accent" data-testid="run-fallback">本次由备用模型完成（原 {r.fallbackFrom}）</span>}
        </p>
        {r.error && <p className="mt-2 rounded-pill bg-bad-soft px-3 py-2 text-sm text-bad">{r.error}</p>}
      </header>
      <section className="space-y-2 px-6 py-4" data-testid="run-trace" aria-label="运行轨迹">
        {steps.length === 0 && (finished ? <Empty title="这次运行没有留下轨迹" /> : <Loading label="等待第一步…" className="p-0" />)}
        {steps.map((s, i) => <StepRow key={i} s={s} open={i === steps.length - 1} onRetry={finished && r.taskId && s.type === 'model' ? () => retry.mutate(i) : undefined} />)}
      </section>
    </div>
  );
}

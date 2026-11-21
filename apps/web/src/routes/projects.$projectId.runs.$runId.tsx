import { useMutation } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { RUN_LABEL, RUN_TONE, TRIGGER_LABEL } from '@/components/board/labels';
import { Callout, Page, PageHeader, SectionTitle } from '@/components/layout/Page';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, ErrorState, Loading } from '@/components/ui/feedback';
import { Icon, type IconName } from '@/components/ui/icons';
import { TerminalView } from '@/components/run/Terminal';
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

const TL_ITEM = 'relative grid grid-cols-[28px_minmax(0,1fr)] gap-3 pb-[18px] before:absolute before:bottom-0 before:left-[13.5px] before:top-7 before:w-px before:bg-rule-2 last:before:hidden';
const TL_DOT = 'grid size-7 place-items-center rounded-full shadow-[inset_0_0_0_1px_var(--color-rule-2)] [&_svg]:size-3.5';

function Dot({ icon, tone }: { icon: IconName; tone: string }) {
  return <span aria-hidden className={cn(TL_DOT, tone)}><Icon name={icon} /></span>;
}

function Block({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="grid gap-1">
      <p className="text-xs font-medium text-muted">{label}</p>
      <pre className="measured max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-ctl bg-code px-3.5 py-3 font-mono text-xs leading-[1.65] text-code-ink">{pretty(value)}</pre>
    </div>
  );
}

function StepRow({ s, open, onRetry }: { s: Step; open: boolean; onRetry?: (() => void) | undefined }) {
  const model = s.type === 'model';
  if (s.type === 'fallback') {
    return (
      <div className={TL_ITEM}>
        <Dot icon="refresh" tone="bg-accent text-accent-ink" />
        <p className="rounded-ctl bg-accent-soft px-3.5 py-2.5 text-sm text-ink-2" data-testid="trace-fallback">{s.from} 不可用，切到 {s.to}{s.error ? `：${s.error}` : ''}</p>
      </div>
    );
  }
  const dot = s.error ? { icon: 'alert' as const, tone: 'bg-bad-soft text-bad' } : model ? { icon: 'robot' as const, tone: 'bg-paper-2 text-muted' } : { icon: 'terminal' as const, tone: 'bg-cool-soft text-cool' };
  return (
    <div className={TL_ITEM}>
      <Dot icon={dot.icon} tone={dot.tone} />
      <details className={cn('group min-w-0 overflow-hidden rounded-card bg-paper shadow-card', s.error && 'shadow-[var(--shadow-card),inset_3px_0_0_var(--color-bad)]')} open={open} data-testid="trace-step">
        <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-2.5 text-sm hover:bg-hover [&::-webkit-details-marker]:hidden">
          <Icon name="chev-r" className="size-3.5 shrink-0 text-muted transition-transform group-open:rotate-90" />
          <span className="measured w-16 shrink-0 text-xs text-muted">{clock(s.t)}</span>
          <span className={cn('min-w-0 flex-1 truncate font-medium', model ? 'text-ink' : 'text-cool')}>
            {model ? (s.toolCalls?.length ? `模型 → ${s.toolCalls.map((c) => c.name).join('、')}` : '模型回复') : `工具 ${s.name}`}
          </span>
          {s.error && <Badge tone="bad">出错</Badge>}
          {s.usage && <span className="measured shrink-0 text-xs text-muted">{s.usage.inputTokens ?? 0}+{s.usage.outputTokens ?? 0} tok{s.usageEstimated ? '（估）' : ''}</span>}
          {s.ms !== undefined && <span className="measured shrink-0 text-xs text-muted">{s.ms}ms</span>}
        </summary>
        <div className="grid gap-2.5 border-t border-rule px-4 pb-4 pt-3">
          {s.text && <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-2">{s.text}</p>}
          {s.toolCalls?.map((c) => <Block key={c.id} label={c.name} value={c.args} />)}
          {s.args !== undefined && <Block label="参数" value={s.args} />}
          {s.result !== undefined && <Block label={s.truncated ? '结果（已截断）' : '结果'} value={s.result} />}
          {onRetry && <div><Button size="sm" onClick={onRetry} data-testid="retry-from"><Icon name="refresh" />从这一步重试</Button></div>}
        </div>
      </details>
    </div>
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
  const harness = !!r.engine && r.engine !== 'builtin';

  return (
    <div className="h-full overflow-y-auto" data-testid="run-page">
      <Page>
        <PageHeader
          icon="robot"
          title={r.agentName ?? 'Agent'}
          desc={<span className="measured text-xs">run {shortId(r.id)} · {TRIGGER_LABEL[r.trigger ?? ''] ?? r.trigger} · {harness ? `引擎 ${r.engine}${r.model && r.model !== 'harness' ? ` · ${r.model}` : ''}` : `${r.provider}:${r.model}`}</span>}
          actions={
            <>
              <Badge tone={RUN_TONE[status] ?? 'neutral'}>{RUN_LABEL[status] ?? status}</Badge>
              {r.stopReason && r.stopReason !== 'completed' && <span className="measured text-xs text-muted">{r.stopReason}</span>}
              {status === 'running' && <Button variant="danger" disabled={cancel.isPending} onClick={() => cancel.mutate()} data-testid="cancel-run"><Icon name="stop" />取消运行</Button>}
            </>
          }
        >
          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm text-muted">
            {r.taskId && <span className="flex items-center gap-1.5"><Icon name="board" className="size-[13px]" />任务 <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId, taskId: r.taskId }} className="font-medium text-cool hover:underline">{r.taskTitle}</Link></span>}
            <span data-testid="run-tokens">tokens <span className="measured text-ink-2">{num(r.tokensIn)}+{num(r.tokensOut)}</span></span>
            <span className="flex items-center gap-1.5"><Icon name="clock" className="size-[13px]" />耗时 <span className="measured text-ink-2">{duration(r.startedAt, r.endedAt)}</span></span>
            <span className="flex items-center gap-1.5"><Icon name="coin" className="size-[13px]" />成本 <span className="measured text-ink-2">{money(r.cost)}</span></span>
            {r.fallbackFrom && <span className="font-medium text-accent" data-testid="run-fallback">本次由备用模型完成（原 {r.fallbackFrom}）</span>}
          </div>
          {r.error && <Callout icon="alert" tone="bad" className="mt-4">{r.error}</Callout>}
        </PageHeader>
        {harness && (
          <>
            <SectionTitle className="mt-2">终端</SectionTitle>
            <TerminalView id={r.id} className="mb-6 h-[30rem]" />
          </>
        )}
        <SectionTitle className="mt-2">{harness ? '平台工具调用' : '运行轨迹'}</SectionTitle>
        <section data-testid="run-trace" aria-label="运行轨迹">
          {steps.length === 0 && (finished ? <Empty icon="list" title="这次运行没有留下轨迹" /> : <Loading label="等待第一步…" className="p-0" />)}
          {steps.map((s, i) => <StepRow key={i} s={s} open={i === steps.length - 1} onRetry={finished && r.taskId && s.type === 'model' ? () => retry.mutate(i) : undefined} />)}
        </section>
      </Page>
    </div>
  );
}

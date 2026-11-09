import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogForm } from '@/components/ui/dialog';
import { Empty, ErrorState, Loading } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/icons';
import { Field, Input, Textarea } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { when } from '@/lib/format';
import { useQaPlan } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { CASE_LABEL, CASE_TONE, PLAN_LABEL, RUN_LABEL, RUN_TONE, isActive, pct, useDocs, type CaseData, type Doc, type ManualResult, type PlanData, type SuiteData } from './model';
import { ROW, Scroll, TABLE, TD, TH, Toolbar, VerdictBadge, useAskAgent, type QaProps } from './shared';

function Pick<T extends { id: string }>({ label, items, name, picked, onChange, empty }: { label: string; items: T[]; name: (t: T) => string; picked: string[]; onChange: (ids: string[]) => void; empty: string }) {
  return (
    <fieldset>
      <legend className="mb-1 text-xs text-muted">{label}</legend>
      {items.length === 0 ? <p className="text-sm text-faint">{empty}</p> : (
        <div className="max-h-36 space-y-1 overflow-y-auto">
          {items.map((t) => (
            <label key={t.id} className="flex items-center gap-2 text-sm text-ink-2">
              <input type="checkbox" checked={picked.includes(t.id)} onChange={(e) => onChange(e.target.checked ? [...picked, t.id] : picked.filter((x) => x !== t.id))} data-testid="qa-plan-pick" />
              <span className="truncate">{name(t)}</span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

function PlanDialog({ wsId, suites, cases, onClose, onDone }: { wsId: string; suites: Doc<SuiteData>[]; cases: Doc<CaseData>[]; onClose: () => void; onDone: (id: string) => void }) {
  const [name, setName] = useState('');
  const [version, setVersion] = useState('');
  const [ref, setRef] = useState('');
  const [pickedSuites, setSuites] = useState(suites.map((s) => s.id));
  const [pickedCases, setCases] = useState<string[]>([]);
  const [minPass, setMinPass] = useState('100');
  const [minCov, setMinCov] = useState('');
  const save = useMutation({
    meta: { silent: true },
    mutationFn: async () => unwrap(await api.workstations[':id'].entities.$post({ param: { id: wsId }, json: { entityType: 'TestPlan', reason: '人工创建', data: { name: name.trim(), version: version.trim(), ref: ref.trim(), status: 'draft', suites: pickedSuites, cases: pickedCases, criteria: { minPassRate: Math.min(100, Math.max(0, Number(minPass) || 0)) / 100, minCoverage: minCov.trim() ? Number(minCov) : null } } } })),
    onSuccess: (r) => { onClose(); onDone(r.id); },
  });
  return (
    <Dialog title="新建测试计划" onClose={onClose} testId="qa-plan-dialog" className="w-[36rem]">
      <DialogForm error={save.error?.message} submitting={save.isPending} submitLabel="创建" canSubmit={!!name.trim() && pickedSuites.length + pickedCases.length > 0} onSubmit={() => save.mutate()} onCancel={onClose}>
        <Field label="名称" required><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} data-testid="qa-plan-name" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="版本"><Input value={version} onChange={(e) => setVersion(e.target.value)} /></Field>
          <Field label="分支或提交" hint="留空用目标分支"><Input className="measured" value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
        </div>
        <Pick label="自动化套件" items={suites} name={(s) => s.data.name} picked={pickedSuites} onChange={setSuites} empty="还没有套件" />
        <Pick label="手工用例" items={cases} name={(c) => c.data.title} picked={pickedCases} onChange={setCases} empty="还没有有效的用例" />
        <div className="grid grid-cols-2 gap-3">
          <Field label="通过率准出线（%）"><Input className="measured" inputMode="numeric" value={minPass} onChange={(e) => setMinPass(e.target.value)} /></Field>
          <Field label="行覆盖率准出线（%）" hint="不填则不检查"><Input className="measured" inputMode="numeric" value={minCov} onChange={(e) => setMinCov(e.target.value)} /></Field>
        </div>
      </DialogForm>
    </Dialog>
  );
}

const MANUAL_ACTIONS: { id: ManualResult['status']; label: string }[] = [{ id: 'passed', label: '通过' }, { id: 'failed', label: '失败' }, { id: 'blocked', label: '阻塞' }, { id: 'skipped', label: '跳过' }];

function ManualCase({ doc, result, planId, locked }: { doc: Doc<CaseData> | undefined; result: ManualResult | undefined; planId: string; locked: boolean }) {
  const [note, setNote] = useState(result?.note ?? '');
  const record = useMutation({ mutationFn: async (status: ManualResult['status']) => unwrap(await api['qa-plans'][':id'].manual.$post({ param: { id: planId }, json: { caseId: doc!.id, status, ...(note.trim() ? { note: note.trim() } : {}) } })) });
  if (!doc) return <li className="py-2 text-sm text-faint">用例已被删除</li>;
  return (
    <li className="border-b border-rule py-3 last:border-0" data-testid="qa-manual-case">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 basis-60 text-sm text-ink">{doc.data.title}</span>
        {result && <Badge tone={CASE_TONE[result.status] ?? 'neutral'}>{CASE_LABEL[result.status] ?? result.status}</Badge>}
        {!locked && (
          <span className="flex gap-1">
            {MANUAL_ACTIONS.map((a) => <Button key={a.id} size="sm" disabled={record.isPending} aria-pressed={result?.status === a.id} onClick={() => record.mutate(a.id)} data-testid={`qa-manual-${a.id}`}>{a.label}</Button>)}
          </span>
        )}
      </div>
      {doc.data.preconditions && <p className="mt-1 text-xs text-muted">前置：{doc.data.preconditions}</p>}
      {(doc.data.steps ?? []).length > 0 && (
        <ol className="mt-1.5 space-y-0.5 text-sm text-ink-2">
          {doc.data.steps!.map((s, i) => <li key={i} className="grid grid-cols-[1.25rem_1fr_1fr] gap-2"><span className="measured text-xs text-faint">{i + 1}</span><span>{s.action}</span><span className="text-muted">{s.expected}</span></li>)}
        </ol>
      )}
      {!locked && <Input className="mt-2" placeholder="备注（可选，点结果按钮时一起保存）" aria-label="备注" value={note} onChange={(e) => setNote(e.target.value)} />}
      {locked && result?.note && <p className="mt-1 text-xs text-muted">备注：{result.note}</p>}
    </li>
  );
}

function SignDialog({ planId, blocked, onClose }: { planId: string; blocked: boolean; onClose: () => void }) {
  const [note, setNote] = useState('');
  const [override, setOverride] = useState(false);
  const sign = useMutation({
    meta: { silent: true },
    mutationFn: async () => unwrap(await api['qa-plans'][':id'].sign.$post({ param: { id: planId }, json: { ...(note.trim() ? { note: note.trim() } : {}), ...(override ? { override } : {}) } })),
    onSuccess: onClose,
  });
  return (
    <Dialog title="发布签字" onClose={onClose} testId="qa-sign-dialog">
      <DialogForm error={sign.error?.message} submitting={sign.isPending} submitLabel="签字" canSubmit={!blocked || (override && !!note.trim())} onSubmit={() => sign.mutate()} onCancel={onClose}>
        <p className="text-sm text-ink-2">签字后结论冻结成报告，计划不能再修改。</p>
        {blocked && (
          <label className="flex items-center gap-2 rounded-pill bg-bad-soft p-2.5 text-sm text-bad">
            <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} data-testid="qa-sign-override" />结论是阻断，我确认放行
          </label>
        )}
        <Field label={blocked ? '放行原因' : '备注'} required={blocked}><Textarea autoFocus rows={3} value={note} onChange={(e) => setNote(e.target.value)} data-testid="qa-sign-note" /></Field>
      </DialogForm>
    </Dialog>
  );
}

function PlanDetail({ doc, ws, cases, go }: { doc: Doc<PlanData>; ws: QaProps['ws']; cases: Doc<CaseData>[]; go: QaProps['go'] }) {
  const q = useQaPlan(ws.id, doc.id);
  const [signing, setSigning] = useState(false);
  const ask = useAskAgent(ws.id);
  const start = useMutation({ mutationFn: async () => unwrap(await api['qa-plans'][':id'].start.$post({ param: { id: doc.id } })) });
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const p = doc.data;
  const d = q.data;
  const signed = p.status === 'signed';
  const running = d.runs.some((r) => isActive(r.status));
  const total = (p.cases ?? []).length;
  const started = d.runs.length > 0 || Object.keys(p.manual_results ?? {}).length > 0;
  return (
    <Scroll testId="qa-plan-detail">
      <Button variant="quiet" size="sm" className="-ml-2 mb-2" onClick={() => go('plans')}><Icon name="chev" className="size-3.5 rotate-90" />全部计划</Button>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-title font-semibold text-ink">{p.name}</h2>
        {p.version && <code className="measured text-xs text-muted">{p.version}</code>}
        <Badge tone={signed ? 'ok' : p.status === 'running' ? 'cool' : 'neutral'}>{PLAN_LABEL[p.status ?? 'draft']}</Badge>
        <span className="flex-1" />
        {!signed && (p.suites ?? []).length > 0 && <Button disabled={start.isPending || running} onClick={() => start.mutate()} data-testid="qa-plan-start">{d.runs.length ? '重新运行套件' : '运行套件'}</Button>}
        {!signed && <Button onClick={() => ask.mutate(`@测试负责人 为测试计划 ${doc.id}（${p.name}）起草结论摘要`)} disabled={ask.isPending} data-testid="qa-plan-summary">AI 起草摘要</Button>}
        {!signed && <Button variant="primary" disabled={running || !started} onClick={() => setSigning(true)} data-testid="qa-plan-sign">签字</Button>}
      </div>

      <section className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 border-y border-rule py-2.5" data-testid="qa-plan-verdict" data-level={d.verdict.level}>
        <span className="flex items-center gap-2 text-sm text-muted">结论 <VerdictBadge level={d.verdict.level} /></span>
        <span className="text-sm text-muted">通过率 <b className="measured font-semibold text-ink">{d.verdict.passRate === null ? '—' : pct(d.verdict.passRate * 100)}</b></span>
        <span className="text-sm text-muted">行覆盖率 <b className="measured font-semibold text-ink">{pct(d.coverage)}</b></span>
        {total > 0 && <span className="text-sm text-muted">手工 <b className="measured font-semibold text-ink">{total - d.manual.pending}/{total}</b></span>}
        <span className="text-sm text-muted">未关闭缺陷 <b className="measured font-semibold text-ink">{d.openBugs}</b></span>
      </section>
      {d.verdict.reasons.length > 0 && !signed && (
        <ul className="mt-2 space-y-0.5 text-sm text-ink-2">
          {d.verdict.reasons.map((r) => <li key={r.text} className="flex gap-2"><span className={r.level === 'block' ? 'text-bad' : 'text-accent'}>{r.level === 'block' ? '阻断' : '风险'}</span>{r.text}</li>)}
        </ul>
      )}
      {p.summary && <section className="mt-4"><h3 className="text-sm font-medium text-ink">结论摘要</h3><p className="mt-1 whitespace-pre-wrap text-sm text-ink-2">{p.summary}</p></section>}

      {d.report && (
        <section className="mt-4" data-testid="qa-plan-report">
          <h3 className="text-sm font-medium text-ink">发布报告 <span className="text-xs font-normal text-muted">{when(p.signoff?.at)} 签字{p.signoff?.override ? ' · 人工放行' : ''}</span></h3>
          <pre className="mt-1 whitespace-pre-wrap rounded-pill bg-paper-2 p-3 text-sm text-ink-2">{d.report}</pre>
        </section>
      )}

      {d.runs.length > 0 && (
        <section className="mt-5">
          <h3 className="text-sm font-medium text-ink">自动化</h3>
          <div className="overflow-x-auto">
            <table className={TABLE}>
              <thead><tr className="border-b border-rule"><th className={TH}>状态</th><th className={TH}>套件</th><th className={TH}>提交</th><th className={TH}>结果</th></tr></thead>
              <tbody>
                {d.runs.map((r) => (
                  <tr key={r.id} className={ROW} onClick={() => go('runs', r.id)}>
                    <td className={TD}><Badge tone={RUN_TONE[r.status] ?? 'neutral'}>{RUN_LABEL[r.status] ?? r.status}</Badge></td>
                    <td className={cn(TD, 'text-ink')}>{r.suiteName}</td>
                    <td className={TD}><code className="measured text-xs">{r.commitSha.slice(0, 7)}</code></td>
                    <td className={cn(TD, 'measured text-xs')}>{r.passed}/{r.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {total > 0 && (
        <section className="mt-5">
          <h3 className="text-sm font-medium text-ink">手工用例</h3>
          <ul>{(p.cases ?? []).map((id) => <ManualCase key={id} doc={cases.find((c) => c.id === id)} result={p.manual_results?.[id]} planId={doc.id} locked={signed} />)}</ul>
        </section>
      )}
      {signing && <SignDialog planId={doc.id} blocked={d.verdict.level === 'blocked'} onClose={() => setSigning(false)} />}
    </Scroll>
  );
}

export function Plans({ ws, item, go }: QaProps) {
  const plans = useDocs<PlanData>(ws.id, 'TestPlan');
  const suites = useDocs<SuiteData>(ws.id, 'TestSuite');
  const cases = useDocs<CaseData>(ws.id, 'TestCase');
  const [creating, setCreating] = useState(false);
  if (plans.isLoading) return <Loading />;
  const open = plans.docs.find((p) => p.id === item);
  if (open) return <PlanDetail key={open.id} doc={open} ws={ws} cases={cases.docs} go={go} />;
  return (
    <Scroll testId="qa-plans">
      <Toolbar><span className="flex-1" /><Button variant="primary" onClick={() => setCreating(true)} data-testid="qa-plan-new"><Icon name="plus" className="size-3.5" />新建计划</Button></Toolbar>
      {plans.docs.length === 0 ? <Empty title="还没有测试计划">为一个版本选好要跑的套件和手工用例，定准出标准，跑完签字。</Empty> : (
        <div className="overflow-x-auto">
          <table className={TABLE}>
            <thead><tr className="border-b border-rule"><th className={TH}>名称</th><th className={TH}>版本</th><th className={TH}>内容</th><th className={TH}>状态</th><th className={cn(TH, 'text-right')}>更新</th></tr></thead>
            <tbody>
              {plans.docs.map((p) => (
                <tr key={p.id} className={ROW} onClick={() => go('plans', p.id)} data-testid="qa-plan-row">
                  <td className={cn(TD, 'text-ink')}>{p.data.name}</td>
                  <td className={cn(TD, 'measured text-xs')}>{p.data.version || '—'}</td>
                  <td className={cn(TD, 'text-xs')}>{(p.data.suites ?? []).length} 个套件 · {(p.data.cases ?? []).length} 条手工</td>
                  <td className={TD}><Badge tone={p.data.status === 'signed' ? 'ok' : p.data.status === 'running' ? 'cool' : 'neutral'}>{PLAN_LABEL[p.data.status ?? 'draft']}</Badge></td>
                  <td className={cn(TD, 'measured text-right text-xs')}>{when(p.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <PlanDialog wsId={ws.id} suites={suites.docs} cases={cases.docs.filter((c) => c.data.status === 'active')} onClose={() => setCreating(false)} onDone={(id) => go('plans', id)} />}
    </Scroll>
  );
}

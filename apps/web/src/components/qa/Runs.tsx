import { useMutation } from '@tanstack/react-query';
import { Fragment, useMemo, useState } from 'react';
import { Segmented } from '@/components/design/panes';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogForm } from '@/components/ui/dialog';
import { Empty, ErrorState, Loading } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/icons';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { seconds, when } from '@/lib/format';
import { useArtifact, useQaHistory, useQaRun, useQaRuns, type QaCaseRow, type QaCluster, type QaRunDetail } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { PassBar, StatusStrip } from './charts';
import { CASE_LABEL, CASE_TONE, CONFIDENCE_LABEL, RUN_LABEL, RUN_TONE, TRIAGE_LABEL, TRIGGER_LABEL, isActive, useDocs, type Doc, type SuiteData } from './model';
import { NewBugDialog, ROW, Scroll, TABLE, TD, TH, Toolbar, type BugDraft, type QaProps } from './shared';

const CASE_LIMIT = 500;

function StartDialog({ wsId, suites, onClose, onDone }: { wsId: string; suites: Doc<SuiteData>[]; onClose: () => void; onDone: (id: string) => void }) {
  const [suiteId, setSuiteId] = useState(suites[0]?.id ?? '');
  const [ref, setRef] = useState('');
  const start = useMutation({
    meta: { silent: true },
    mutationFn: async () => unwrap(await api.workstations[':id'].qa.runs.$post({ param: { id: wsId }, json: { suiteId, ...(ref.trim() ? { ref: ref.trim() } : {}) } })),
    onSuccess: (r) => { onClose(); onDone(r.id); },
  });
  return (
    <Dialog title="运行套件" onClose={onClose} testId="qa-start-dialog">
      <DialogForm error={start.error?.message} submitting={start.isPending} submitLabel="开始运行" canSubmit={!!suiteId} onSubmit={() => start.mutate()} onCancel={onClose}>
        <Field label="套件" required>
          <Select value={suiteId} onChange={(e) => setSuiteId(e.target.value)} data-testid="qa-start-suite">{suites.map((s) => <option key={s.id} value={s.id}>{s.data.name}</option>)}</Select>
        </Field>
        <Field label="分支或提交" hint="留空用目标分支。可以填开发任务的分支（aw/xxxx）提前验证">
          <Input className="measured" value={ref} onChange={(e) => setRef(e.target.value)} data-testid="qa-start-ref" />
        </Field>
      </DialogForm>
    </Dialog>
  );
}

function SuiteDialog({ wsId, suite, onClose }: { wsId: string; suite: Doc<SuiteData> | null; onClose: () => void }) {
  const d = suite?.data;
  const [name, setName] = useState(d?.name ?? '');
  const [command, setCommand] = useState(d?.command ?? '');
  const [report, setReport] = useState(d?.report_path ?? '');
  const [coverage, setCoverage] = useState(d?.coverage_path ?? '');
  const [timeout, setTimeoutSec] = useState(String(d?.timeout_sec ?? 900));
  const [auto, setAuto] = useState(d?.auto_run ?? false);
  const [description, setDescription] = useState(d?.description ?? '');
  const save = useMutation({
    meta: { silent: true },
    mutationFn: async () => unwrap(await api.workstations[':id'].qa.suites.$post({
      param: { id: wsId },
      json: { ...(suite ? { id: suite.id, baseVersion: suite.version } : {}), data: { name: name.trim(), command: command.trim(), report_path: report.trim(), ...(coverage.trim() ? { coverage_path: coverage.trim() } : {}), ...(Number(timeout) > 0 ? { timeout_sec: Math.floor(Number(timeout)) } : {}), auto_run: auto, description } },
    })),
    onSuccess: onClose,
  });
  return (
    <Dialog title={suite ? '编辑套件' : '新建套件'} onClose={onClose} testId="qa-suite-dialog" className="w-[34rem]">
      <DialogForm error={save.error?.message} submitting={save.isPending} submitLabel="保存" canSubmit={!!name.trim() && !!command.trim() && !!report.trim()} onSubmit={() => save.mutate()} onCancel={onClose}>
        <Field label="名称" required><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} data-testid="qa-suite-name" /></Field>
        <Field label="命令" required hint="在仓库根目录执行。不能用管道和变量，不能装依赖。例：pnpm vitest run --reporter=junit --outputFile=reports/junit.xml">
          <Input className="measured" value={command} onChange={(e) => setCommand(e.target.value)} data-testid="qa-suite-command" />
        </Field>
        <Field label="JUnit 报告路径" required hint="相对仓库根目录。Playwright 用 --reporter=junit 时平台会自动指定输出到这里">
          <Input className="measured" value={report} onChange={(e) => setReport(e.target.value)} data-testid="qa-suite-report" />
        </Field>
        <Field label="覆盖率报告路径" hint="coverage-summary.json 或 lcov.info，没有可以不填">
          <Input className="measured" value={coverage} onChange={(e) => setCoverage(e.target.value)} />
        </Field>
        <Field label="超时（秒）"><Input className="measured" inputMode="numeric" value={timeout} onChange={(e) => setTimeoutSec(e.target.value)} /></Field>
        <label className="flex items-center gap-2 text-sm text-ink-2">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} data-testid="qa-suite-auto" />目标分支有新提交时自动运行
        </label>
        <Field label="说明"><Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      </DialogForm>
    </Dialog>
  );
}

function Suites({ wsId, autoOpen }: { wsId: string; autoOpen: boolean }) {
  const { docs, isLoading } = useDocs<SuiteData>(wsId, 'TestSuite');
  const [editing, setEditing] = useState<Doc<SuiteData> | 'new' | null>(autoOpen ? 'new' : null);
  if (isLoading) return <Loading />;
  return (
    <>
      <Toolbar><span className="flex-1 text-xs text-muted">命令由人审定，Agent 只能按名字运行，不能改写</span><Button variant="primary" onClick={() => setEditing('new')} data-testid="qa-suite-new"><Icon name="plus" className="size-3.5" />新建套件</Button></Toolbar>
      {docs.length === 0 ? <Empty title="还没有套件">建一个会生成 JUnit 报告的测试命令。</Empty> : (
        <div className="overflow-x-auto">
          <table className={TABLE}>
            <thead><tr className="border-b border-rule"><th className={TH}>名称</th><th className={TH}>命令</th><th className={TH}>报告</th><th className={TH}>自动运行</th></tr></thead>
            <tbody>
              {docs.map((s) => (
                <tr key={s.id} className={ROW} onClick={() => setEditing(s)} data-testid="qa-suite-row">
                  <td className={cn(TD, 'text-ink')}>{s.data.name}</td>
                  <td className={TD}><code className="measured text-xs">{s.data.command}</code></td>
                  <td className={TD}><code className="measured text-xs">{s.data.report_path}</code></td>
                  <td className={TD}>{s.data.auto_run ? <Badge tone="cool">开</Badge> : <span className="text-faint">关</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <SuiteDialog key={editing === 'new' ? 'new' : editing.id} wsId={wsId} suite={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function RunList({ wsId, go }: { wsId: string; go: QaProps['go'] }) {
  const runs = useQaRuns(wsId);
  const suites = useDocs<SuiteData>(wsId, 'TestSuite');
  const [starting, setStarting] = useState(false);
  if (runs.isLoading) return <Loading />;
  if (runs.isError) return <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />;
  const rows = runs.data ?? [];
  return (
    <>
      <Toolbar>
        <span className="flex-1" />
        <Button variant="primary" disabled={suites.docs.length === 0} onClick={() => setStarting(true)} data-testid="qa-run-new"><Icon name="play" className="size-3.5" />运行套件</Button>
      </Toolbar>
      {rows.length === 0 ? <Empty title="还没有运行记录">{suites.docs.length === 0 ? '先到「套件」里配置一条测试命令。' : '点「运行套件」开始第一次运行。'}</Empty> : (
        <div className="overflow-x-auto">
          <table className={TABLE} data-testid="qa-run-table">
            <thead><tr className="border-b border-rule"><th className={TH}>状态</th><th className={TH}>套件</th><th className={TH}>版本</th><th className={TH}>结果</th><th className={cn(TH, 'text-right')}>耗时</th><th className={TH}>来源</th><th className={cn(TH, 'text-right')}>时间</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={ROW} onClick={() => go('runs', r.id)} data-testid="qa-run-row">
                  <td className={TD}><Badge tone={RUN_TONE[r.status] ?? 'neutral'} className={isActive(r.status) ? 'animate-pulse-soft' : undefined}>{RUN_LABEL[r.status] ?? r.status}</Badge></td>
                  <td className={cn(TD, 'max-w-56 truncate text-ink')}>{r.suiteName}</td>
                  <td className={TD}><code className="measured text-xs">{r.ref} @ {r.commitSha.slice(0, 7)}</code></td>
                  <td className={TD}>
                    {r.total > 0 ? <span className="flex items-center gap-2"><PassBar passed={r.passed} failed={r.failed + r.errored} skipped={r.skipped} /><span className="measured text-xs">{r.passed}/{r.total}</span></span> : <span className="text-xs text-faint">{r.error ? '无结果' : '—'}</span>}
                  </td>
                  <td className={cn(TD, 'measured text-right text-xs')}>{r.durationMs === null ? '—' : seconds(r.durationMs / 1000)}</td>
                  <td className={cn(TD, 'text-xs')}>{TRIGGER_LABEL[r.trigger] ?? r.trigger}</td>
                  <td className={cn(TD, 'measured text-right text-xs')}>{when(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {starting && <StartDialog wsId={wsId} suites={suites.docs} onClose={() => setStarting(false)} onDone={(id) => go('runs', id)} />}
    </>
  );
}

function Output({ id }: { id: string }) {
  const q = useArtifact(id);
  if (q.isLoading) return <Loading label="读取输出…" className="p-3" />;
  return <pre className="measured max-h-96 overflow-auto whitespace-pre-wrap rounded-pill bg-paper-3 p-3 text-xs text-ink-2" data-testid="qa-output">{q.data?.content || '（无输出）'}</pre>;
}

const bugDraft = (c: { name: string; caseKey: string; failureMessage?: string | null; failureDetail?: string | null }, runId: string, suite: string): BugDraft => ({
  title: `${c.name} 失败`, severity: 'p2', actual: c.failureMessage ?? '', steps: c.failureDetail?.slice(0, 1500) ?? '', run_id: runId, case_key: c.caseKey, case_name: `${suite}: ${c.name}`,
});

function CaseDialog({ wsId, c, runId, suite, onClose, onBug, go }: { wsId: string; c: QaCaseRow; runId: string; suite: string; onClose: () => void; onBug: (d: BugDraft) => void; go: QaProps['go'] }) {
  const h = useQaHistory(wsId, c.caseKey);
  const quarantine = useMutation({
    mutationFn: async () => unwrap(await api.workstations[':id'].entities.$post({ param: { id: wsId }, json: { entityType: 'TestQuarantine', data: { name: c.name, case_key: c.caseKey, status: 'active', reason: '从运行详情隔离' }, reason: '人工隔离' } })),
    onSuccess: onClose,
  });
  const failing = c.status === 'failed' || c.status === 'error';
  const items = [...(h.data?.history ?? [])].reverse().map((x) => ({ status: x.status, runId: x.runId, title: `${x.commitSha.slice(0, 7)} · ${when(x.createdAt)} · ${CASE_LABEL[x.status] ?? x.status}` }));
  return (
    <Dialog title={c.name} onClose={onClose} testId="qa-case-dialog" className="w-[42rem]">
      <p className="measured -mt-3 mb-3 break-all text-xs text-muted">{c.classname}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={CASE_TONE[c.status] ?? 'neutral'}>{CASE_LABEL[c.status] ?? c.status}</Badge>
        <span className="measured text-xs text-muted">{seconds(c.durationMs / 1000)}</span>
        {c.isNew && <Badge tone="bad">新增失败</Badge>}
        {c.quarantined && <Badge tone="amber">已隔离</Badge>}
        {h.data?.flakiness.flaky && <Badge tone="amber">不稳定</Badge>}
      </div>
      <p className="mb-1 mt-4 text-xs text-muted">最近 {items.length} 次（旧 → 新）</p>
      {h.isLoading ? <Loading className="p-0" /> : <StatusStrip items={items} onPick={(id) => { onClose(); go('runs', id); }} />}
      {c.failureMessage && <p className="measured mt-4 whitespace-pre-wrap break-words rounded-pill bg-bad-soft p-2.5 text-xs text-bad">{c.failureMessage}</p>}
      {c.failureDetail && <pre className="measured mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-pill bg-paper-3 p-2.5 text-xs text-ink-2">{c.failureDetail}</pre>}
      <div className="mt-4 flex justify-end gap-2">
        {failing && !c.quarantined && <Button onClick={() => quarantine.mutate()} disabled={quarantine.isPending} data-testid="qa-quarantine">隔离</Button>}
        {failing && <Button variant="primary" onClick={() => { onClose(); onBug(bugDraft(c, runId, suite)); }} data-testid="qa-case-bug">建缺陷</Button>}
        <Button variant="quiet" onClick={onClose}>关闭</Button>
      </div>
    </Dialog>
  );
}

function Cluster({ g, results, onBug, onCase }: { g: QaCluster; results: QaCaseRow[]; onBug: (c: QaCaseRow) => void; onCase: (c: QaCaseRow) => void }) {
  const first = results.find((r) => r.caseKey === g.cases[0]?.caseKey);
  return (
    <li className="border-b border-rule py-3 last:border-0" data-testid="qa-cluster">
      <div className="flex flex-wrap items-start gap-2">
        <span className="measured shrink-0 pt-0.5 text-sm font-semibold text-bad">{g.cases.length}</span>
        <p className="measured min-w-0 flex-1 basis-64 whitespace-pre-wrap break-words text-xs text-ink">{g.message || '（没有错误信息）'}</p>
        {g.triage && <Badge tone={g.triage.category === 'product_bug' ? 'bad' : g.triage.category === 'flaky' ? 'amber' : 'neutral'} data-testid="qa-triage-badge">{TRIAGE_LABEL[g.triage.category] ?? g.triage.category} · 置信度{CONFIDENCE_LABEL[g.triage.confidence] ?? ''}</Badge>}
        {first && <Button size="sm" onClick={() => onBug(first)} data-testid="qa-cluster-bug">建缺陷</Button>}
      </div>
      {g.triage && (
        <div className="ml-6 mt-1.5 text-sm text-ink-2">
          <p>{g.triage.summary}</p>
          <p className="measured mt-0.5 whitespace-pre-wrap break-words text-xs text-muted">{g.triage.evidence}</p>
        </div>
      )}
      <ul className="ml-6 mt-1.5 space-y-0.5">
        {g.cases.slice(0, 12).map((c) => {
          const row = results.find((r) => r.caseKey === c.caseKey);
          return (
            <li key={c.caseKey} className="flex items-center gap-2 text-sm">
              <button type="button" className="min-w-0 truncate text-left text-ink-2 hover:underline" onClick={() => row && onCase(row)}>{c.name}</button>
              {row?.isNew && <Badge tone="bad">新增</Badge>}
              {row?.quarantined && <Badge tone="amber">已隔离</Badge>}
            </li>
          );
        })}
        {g.cases.length > 12 && <li className="text-xs text-muted">还有 {g.cases.length - 12} 个</li>}
      </ul>
    </li>
  );
}

type Filter = 'failing' | 'all' | 'skipped';

function CaseTree({ results, onCase }: { results: QaCaseRow[]; onCase: (c: QaCaseRow) => void }) {
  const hasFailing = results.some((r) => r.status === 'failed' || r.status === 'error');
  const [filter, setFilter] = useState<Filter>(hasFailing ? 'failing' : 'all');
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return results.filter((r) => (filter === 'all' || (filter === 'skipped' ? r.status === 'skipped' : r.status === 'failed' || r.status === 'error')) && (!needle || `${r.classname} ${r.name}`.toLowerCase().includes(needle)));
  }, [results, filter, q]);
  const groups = useMemo(() => {
    const m = new Map<string, QaCaseRow[]>();
    for (const r of shown.slice(0, CASE_LIMIT)) m.set(r.classname, [...(m.get(r.classname) ?? []), r]);
    return [...m];
  }, [shown]);
  return (
    <section className="mt-6">
      <Toolbar>
        <h2 className="text-sm font-medium text-ink">用例</h2>
        <Segmented label="用例筛选" value={filter} onChange={setFilter} options={[{ id: 'failing', label: '失败' }, { id: 'all', label: `全部 ${results.length}` }, { id: 'skipped', label: '跳过' }]} />
        <Input className="ml-auto w-56" placeholder="搜索用例" aria-label="搜索用例" value={q} onChange={(e) => setQ(e.target.value)} data-testid="qa-case-search" />
      </Toolbar>
      {groups.length === 0 && <p className="py-2 text-sm text-muted">没有符合条件的用例。</p>}
      <div data-testid="qa-case-tree">
        {groups.map(([classname, rows]) => (
          <details key={classname} open={groups.length <= 12} className="border-b border-rule">
            <summary className="measured cursor-pointer truncate py-1.5 text-xs text-muted">{classname || '（未分组）'} <span className="text-faint">{rows.length}</span></summary>
            <ul className="pb-1.5">
              {rows.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => onCase(c)} className="flex w-full items-center gap-2 rounded-[3px] px-1 py-1 text-left text-sm transition-colors duration-150 hover:bg-hover" data-testid="qa-case-row">
                    <Badge tone={CASE_TONE[c.status] ?? 'neutral'}>{CASE_LABEL[c.status] ?? c.status}</Badge>
                    <span className="min-w-0 flex-1 truncate text-ink-2">{c.name}</span>
                    {c.isNew && <Badge tone="bad">新增</Badge>}
                    {c.quarantined && <Badge tone="amber">已隔离</Badge>}
                    <span className="measured shrink-0 text-xs text-faint">{seconds(c.durationMs / 1000)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </details>
        ))}
      </div>
      {shown.length > CASE_LIMIT && <p className="mt-2 text-xs text-muted">只显示前 {CASE_LIMIT} 个，用搜索缩小范围。</p>}
    </section>
  );
}

function Compare({ c }: { c: NonNullable<QaRunDetail['comparison']> }) {
  const cell = (label: string, n: number, cls: string) => (
    <div className="min-w-24 flex-1 px-3 py-2"><span className="block text-xs text-muted">{label}</span><span className={cn('measured text-title font-semibold', n > 0 ? cls : 'text-ink-2')}>{n}</span></div>
  );
  return (
    <div className="mt-3 flex flex-wrap divide-x divide-rule border-y border-rule" data-testid="qa-compare">
      {cell('新增失败', c.newFailures, 'text-bad')}
      {cell('持续失败', c.stillFailing, 'text-accent')}
      {cell('已修复', c.fixed, 'text-ok')}
      {cell('新增用例', c.added, 'text-ink')}
      {cell('移除用例', c.removed, 'text-ink')}
    </div>
  );
}

function RunDetail({ id, wsId, go }: { id: string; wsId: string; go: QaProps['go'] }) {
  const q = useQaRun(id);
  const [openCase, setOpenCase] = useState<QaCaseRow | null>(null);
  const [draft, setDraft] = useState<BugDraft | null>(null);
  const retry = useMutation({ mutationFn: async () => unwrap(await api['qa-runs'][':id'].retry.$post({ param: { id } })), onSuccess: (r) => go('runs', r.id) });
  const cancel = useMutation({ mutationFn: async () => unwrap(await api['qa-runs'][':id'].cancel.$post({ param: { id } })) });
  const triage = useMutation({ mutationFn: async () => unwrap(await api['qa-runs'][':id'].triage.$post({ param: { id } })) });
  const [output, setOutput] = useState(false);
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const d = q.data;
  const r = d.run;
  const active = isActive(r.status);
  const failing = r.failed + r.errored;
  return (
    <Scroll testId="qa-run-detail">
      <Button variant="quiet" size="sm" className="-ml-2 mb-2" onClick={() => go('runs')}><Icon name="chev" className="size-3.5 rotate-90" />全部运行</Button>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={RUN_TONE[r.status] ?? 'neutral'} className={active ? 'animate-pulse-soft' : undefined} data-testid="qa-run-status">{RUN_LABEL[r.status] ?? r.status}</Badge>
        <h2 className="text-title font-semibold text-ink">{r.suiteName}</h2>
        <code className="measured text-xs text-muted">{r.ref} @ {r.commitSha.slice(0, 7)}</code>
        <span className="flex-1" />
        {active && <Button onClick={() => cancel.mutate()} disabled={cancel.isPending} data-testid="qa-run-cancel">取消</Button>}
        {!active && failing > 0 && (
          <Button onClick={() => triage.mutate()} disabled={triage.isPending || d.triageStatus === 'requested'} data-testid="qa-run-triage">
            {d.triageStatus === 'requested' ? '分析中…' : d.triageStatus === 'done' ? '重新分析' : 'AI 分析失败'}
          </Button>
        )}
        {!active && <Button onClick={() => retry.mutate()} disabled={retry.isPending} data-testid="qa-run-retry">重跑同一提交</Button>}
      </div>
      <p className="mt-1 text-xs text-muted">
        <code className="measured">{d.config.command}</code> · {TRIGGER_LABEL[r.trigger] ?? r.trigger} · {when(r.createdAt)}{r.durationMs !== null ? ` · ${seconds(r.durationMs / 1000)}` : ''}
      </p>
      {r.total > 0 && <p className="measured mt-3 text-sm text-ink-2" data-testid="qa-run-counts">{r.passed} 通过 · {failing} 失败 · {r.skipped} 跳过 · 共 {r.total}</p>}
      {r.error && <p className="mt-3 rounded-pill bg-bad-soft p-2.5 text-sm text-bad" data-testid="qa-run-error">{r.envError ? '环境问题：' : ''}{r.error}</p>}
      {d.comparison && <Compare c={d.comparison} />}
      {d.baseline === null && r.total > 0 && !active && <p className="mt-2 text-xs text-muted">这是第一次运行，下次开始和它对比。</p>}

      {d.clusters.length > 0 && (
        <section className="mt-6">
          <h2 className="text-sm font-medium text-ink">失败（{d.clusters.length} 类错误）</h2>
          <ul>{d.clusters.map((g) => <Cluster key={g.fingerprint} g={g} results={d.results} onCase={setOpenCase} onBug={(c) => setDraft(bugDraft(c, r.id, r.suiteName))} />)}</ul>
        </section>
      )}
      {d.results.length > 0 && <CaseTree results={d.results} onCase={setOpenCase} />}

      {r.outputArtifactId && (
        <section className="mt-6">
          <Button variant="quiet" size="sm" className="-ml-2" aria-expanded={output} onClick={() => setOutput(!output)} data-testid="qa-output-toggle">{output ? '收起原始输出' : '查看原始输出'}</Button>
          {output && <Output id={r.outputArtifactId} />}
        </section>
      )}
      {openCase && <CaseDialog wsId={wsId} c={openCase} runId={r.id} suite={r.suiteName} go={go} onClose={() => setOpenCase(null)} onBug={setDraft} />}
      {draft && <NewBugDialog wsId={wsId} draft={draft} onClose={() => setDraft(null)} onDone={(bug) => go('bugs', bug)} />}
    </Scroll>
  );
}

export function Runs({ ws, item, go }: QaProps) {
  const [tab, setTab] = useState<'runs' | 'suites'>(item === 'suites' ? 'suites' : 'runs');
  if (item && item !== 'suites') return <RunDetail key={item} id={item} wsId={ws.id} go={go} />;
  return (
    <Scroll testId="qa-runs">
      <Toolbar><Segmented label="运行页" value={tab} onChange={setTab} options={[{ id: 'runs', label: '运行记录' }, { id: 'suites', label: '套件' }]} /></Toolbar>
      <Fragment key={tab}>{tab === 'runs' ? <RunList wsId={ws.id} go={go} /> : <Suites wsId={ws.id} autoOpen={item === 'suites'} />}</Fragment>
    </Scroll>
  );
}

import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Dialog, DialogForm } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { parseJson } from '@/lib/format';
import { useModels, useQaGateSuites, type BoardTask, type DispatchTarget } from '@/lib/queries';
import { FIELD_LABEL, fieldsOf, fromChecks, parseChecks, qaSuiteChecks, toChecks } from './schemaForm';

// 派发到子孙工作台：类型与字段取目标插件的 tasks 声明
export function DispatchDialog({ task, targets, onClose }: { task: BoardTask; targets: DispatchTarget[]; onClose: () => void }) {
  const input = parseJson<Record<string, unknown>>(task.inputJson, {});
  const [targetId, setTargetId] = useState(targets[0]?.id ?? '');
  const target = targets.find((t) => t.id === targetId);
  const [typeId, setTypeId] = useState(target?.taskTypes[0]?.id ?? '');
  const [module, setModule] = useState(typeof input.module === 'string' ? input.module : '');
  const [enums, setEnums] = useState<Record<string, string>>({});
  const [acceptance, setAcceptance] = useState(fromChecks(task.acceptanceJson));
  const otherChecks = parseChecks(task.acceptanceJson).filter((c) => c.kind !== 'command' && c.kind !== 'qa_suite');
  const [suites, setSuites] = useState<string[]>(qaSuiteChecks(task.acceptanceJson).map((c) => c.suite!));
  const gates = useQaGateSuites(targetId).data ?? [];
  const [reason, setReason] = useState('');
  const [budget, setBudget] = useState('');
  const cloud = useModels().data?.models.filter((m) => !m.local).map((m) => m.id) ?? [];

  const type = target?.taskTypes.find((t) => t.id === typeId);
  const fields = fieldsOf(type?.inputSchema).filter((f) => f.name !== 'title');
  const enumFields = fields.filter((f) => f.enum);
  const moduleRequired = fields.some((f) => f.name === 'module' && f.required);

  const dispatch = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const checks = toChecks(acceptance, [...otherChecks, ...suites.map((suite) => ({ kind: 'qa_suite', suite }))]);
      return unwrap(
        await api.tasks[':id'].dispatch.$post({
          param: { id: task.id },
          json: {
            targetWorkstationId: targetId,
            typeId,
            input: {
              ...input,
              title: task.title,
              ...Object.fromEntries(enumFields.map((f) => [f.name, enums[f.name] ?? f.enum![0]!])),
              ...(module.trim() ? { module: module.trim() } : {}),
            },
            ...(checks.length > 0 ? { acceptance: checks } : {}),
            ...(reason.trim() ? { reason: reason.trim() } : {}),
            ...(Number(budget) > 0 ? { budget: { tokens: Number(budget) } } : {}),
          },
        }),
      );
    },
    onSuccess: onClose,
  });

  return (
    <Dialog title={`派发「${task.title}」`} onClose={onClose} testId="dispatch-dialog">
      <DialogForm
        error={dispatch.error?.message}
        submitting={dispatch.isPending}
        submitLabel="派发"
        canSubmit={!!targetId && !!typeId && (!moduleRequired || !!module.trim())}
        onSubmit={() => dispatch.mutate()}
        onCancel={onClose}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="目标工作台">
            <Select
              value={targetId}
              data-testid="dispatch-target"
              onChange={(e) => {
                setTargetId(e.target.value);
                setTypeId(targets.find((t) => t.id === e.target.value)?.taskTypes[0]?.id ?? '');
                setEnums({});
              }}
            >
              {targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
          <Field label="任务类型">
            <Select value={typeId} data-testid="dispatch-type" onChange={(e) => { setTypeId(e.target.value); setEnums({}); }}>
              {(target?.taskTypes ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
          {enumFields.map((f) => (
            <Field key={f.name} label={FIELD_LABEL[f.name] ?? f.name} required={f.required}>
              <Select value={enums[f.name] ?? f.enum![0]!} onChange={(e) => setEnums({ ...enums, [f.name]: e.target.value })}>
                {f.enum!.map((v) => <option key={v}>{v}</option>)}
              </Select>
            </Field>
          ))}
        </div>
        <Field label={FIELD_LABEL.module!} required={moduleRequired}>
          <Input className="measured" value={module} onChange={(e) => setModule(e.target.value)} data-testid="dispatch-module" />
        </Field>
        <Field label="验收命令" hint="每行一条；目标插件的默认验收会自动合并">
          <Textarea className="measured" rows={2} value={acceptance} onChange={(e) => setAcceptance(e.target.value)} />
        </Field>
        {gates.length > 0 && (
          <Field label="质量套件" hint="验收时在绑定目标台的测试台上运行">
            <div className="space-y-1">
              {gates.map((s) => (
                <label key={s.id} className="flex items-center gap-2 text-sm text-ink-2">
                  <input type="checkbox" checked={suites.includes(s.id)} onChange={(e) => setSuites(e.target.checked ? [...suites, s.id] : suites.filter((x) => x !== s.id))} data-testid="dispatch-gate-suite" />
                  <span className="truncate">{s.name}<span className="text-faint"> · {s.qaWorkstationName}</span></span>
                </label>
              ))}
            </div>
          </Field>
        )}
        <div className="grid grid-cols-[minmax(0,1fr)_10rem] gap-3">
          <Field label="派发说明">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <Field label="任务预算（tokens）">
            <Input className="measured" type="number" min={1} value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="不限" data-testid="dispatch-budget" />
          </Field>
        </div>
        {cloud.length > 0 && <p className="text-xs text-muted" data-testid="cloud-notice">任务内容和相关代码片段会发送给云端模型：{cloud.join('、')}</p>}
      </DialogForm>
    </Dialog>
  );
}

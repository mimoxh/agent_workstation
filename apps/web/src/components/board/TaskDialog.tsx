import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Dialog, DialogForm } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { parseJson } from '@/lib/format';
import { useQaGateSuites, type BoardTask, type WorkstationDetail } from '@/lib/queries';
import { FIELD_LABEL, fieldsOf, fromChecks, parseChecks, qaSuiteChecks, toChecks } from './schemaForm';

// 新建 / 编辑草稿：字段由任务类型的 inputSchema 决定
export function TaskDialog({ ws, task, onClose }: { ws: WorkstationDetail; task?: BoardTask | undefined; onClose: () => void }) {
  const types = ws.manifest?.tasks ?? [];
  const input = parseJson<Record<string, unknown>>(task?.inputJson, {});
  const [title, setTitle] = useState(task?.title ?? '');
  const [intent, setIntent] = useState(task?.intent ?? '');
  const [typeId, setTypeId] = useState(task?.typeId ?? types[0]?.id ?? '');
  const [module, setModule] = useState(typeof input.module === 'string' ? input.module : '');
  const [enums, setEnums] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'module' && k !== 'title').map(([k, v]) => [k, String(v)])),
  );
  const [acceptance, setAcceptance] = useState(fromChecks(task?.acceptanceJson));
  // 非 command 验收原样保留；qa_suite 用下面的复选框改
  const otherChecks = parseChecks(task?.acceptanceJson).filter((c) => c.kind !== 'command' && c.kind !== 'qa_suite');
  const [suites, setSuites] = useState<string[]>(qaSuiteChecks(task?.acceptanceJson).map((c) => c.suite!));
  const gates = useQaGateSuites(ws.id).data ?? [];
  const [assignee, setAssignee] = useState('');

  const type = types.find((t) => t.id === typeId);
  const fields = fieldsOf(type?.inputSchema).filter((f) => f.name !== 'title');
  const enumFields = fields.filter((f) => f.enum);
  const moduleRequired = fields.some((f) => f.name === 'module' && f.required);
  const agents = ws.agents.filter((a) => a.status !== 'paused' && a.isSteward !== 1);

  const save = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const values: Record<string, unknown> = {
        ...Object.fromEntries(enumFields.map((f) => [f.name, enums[f.name] ?? f.enum![0]!])),
        ...(module.trim() ? { module: module.trim() } : {}),
      };
      const checks = toChecks(acceptance, [...otherChecks, ...suites.map((suite) => ({ kind: 'qa_suite', suite }))]);
      const common = {
        title: title.trim(),
        ...(Object.keys(values).length > 0 ? { input: values } : {}),
      };
      if (task) {
        return unwrap(await api.tasks[':id'].$patch({ param: { id: task.id }, json: { ...common, intent: intent.trim() || null, acceptance: checks } }));
      }
      return unwrap(
        await api.workstations[':id'].tasks.$post({
          param: { id: ws.id },
          json: {
            ...common,
            ...(intent.trim() ? { intent: intent.trim() } : {}),
            ...(type ? { typeId: type.id } : {}),
            ...(checks.length > 0 ? { acceptance: checks } : {}),
            ...(assignee ? { assigneeAgentId: assignee } : {}),
          },
        }),
      );
    },
    onSuccess: onClose,
  });

  return (
    <Dialog title={task ? '编辑任务' : `在「${ws.name}」新建任务`} onClose={onClose} testId="task-dialog">
      <DialogForm
        error={save.error?.message}
        submitting={save.isPending}
        submitLabel={task ? '保存' : '创建任务'}
        canSubmit={!!title.trim() && (!moduleRequired || !!module.trim())}
        onSubmit={() => save.mutate()}
        onCancel={onClose}
      >
        <Field label="标题" required>
          <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} data-testid="new-task-title" placeholder="给任务看板加状态筛选" />
        </Field>
        <Field label="意图" hint="为什么要做，Agent 会读到这段">
          <Textarea rows={2} value={intent} onChange={(e) => setIntent(e.target.value)} />
        </Field>
        {types.length > 1 && !task && (
          <Field label="任务类型">
            <Select value={typeId} onChange={(e) => { setTypeId(e.target.value); setEnums({}); }}>
              {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
        )}
        {enumFields.length > 0 && (
          <div className="grid grid-cols-2 gap-3">
            {enumFields.map((f) => (
              <Field key={f.name} label={FIELD_LABEL[f.name] ?? f.name} required={f.required}>
                <Select value={enums[f.name] ?? f.enum![0]!} onChange={(e) => setEnums({ ...enums, [f.name]: e.target.value })}>
                  {f.enum!.map((v) => <option key={v}>{v}</option>)}
                </Select>
              </Field>
            ))}
          </div>
        )}
        <Field label={FIELD_LABEL.module!} required={moduleRequired} hint="改动不得越出这个路径；派发时也可以再填">
          <Input className="measured" value={module} onChange={(e) => setModule(e.target.value)} data-testid="new-task-module" placeholder="apps/web/src/components/board/" />
        </Field>
        <Field label="验收命令" hint={type?.acceptance.length ? '每行一条；插件默认验收会自动合并' : '每行一条，退出码 0 视为通过'}>
          <Textarea className="measured" rows={2} value={acceptance} onChange={(e) => setAcceptance(e.target.value)} data-testid="new-task-acceptance" placeholder="pnpm test" />
        </Field>
        {gates.length > 0 && (
          <Field label="质量套件" hint="验收时在任务分支上运行本台的测试套件">
            <div className="space-y-1">
              {gates.map((s) => (
                <label key={s.id} className="flex items-center gap-2 text-sm text-ink-2">
                  <input type="checkbox" checked={suites.includes(s.id)} onChange={(e) => setSuites(e.target.checked ? [...suites, s.id] : suites.filter((x) => x !== s.id))} data-testid="task-gate-suite" />
                  <span className="truncate">{s.name}</span>
                </label>
              ))}
            </div>
          </Field>
        )}
        {!task && agents.length > 0 && (
          <Field label="直接指派" hint="留空则保存为草稿">
            <Select value={assignee} onChange={(e) => setAssignee(e.target.value)} data-testid="new-task-assignee">
              <option value="">不指派</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          </Field>
        )}
      </DialogForm>
    </Dialog>
  );
}

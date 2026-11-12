import { useMutation } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogForm } from '@/components/ui/dialog';
import { Empty, ErrorState, Loading } from '@/components/ui/feedback';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { parseJson, when } from '@/lib/format';
import { useEntityVersions, useWsEntities, type EntityRow, type Manifest } from '@/lib/queries';
import { cn } from '@/lib/utils';

export type EntityDef = Manifest['entities'][string];
type Data = Record<string, unknown>;

const STATE_TONE: Record<string, BadgeTone> = { accepted: 'ok', 已完成: 'ok', proposed: 'amber', 进行中: 'cool', superseded: 'neutral', 未开始: 'neutral', 高: 'bad', 中: 'amber', 低: 'neutral', 未处理: 'amber', 应对中: 'cool', 已关闭: 'ok' };
const STATE_LABEL: Record<string, string> = { accepted: '生效', proposed: '提议中', superseded: '已取代' };

export function EntityDialog({ wsId, entityType, def, row, onClose }: { wsId: string; entityType: string; def: EntityDef; row?: EntityRow | undefined; onClose: () => void }) {
  const [data, setData] = useState<Data>(() => parseJson<Data>(row?.dataJson, {}));
  const [reason, setReason] = useState('');
  const set = (k: string, v: string) => setData({ ...data, [k]: v });
  const save = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const note = reason.trim() ? { reason: reason.trim() } : {};
      return row
        ? unwrap(await api.entities[':id'].$patch({ param: { id: row.id }, json: { data, baseVersion: row.version, ...note } }))
        : unwrap(await api.workstations[':id'].entities.$post({ param: { id: wsId }, json: { entityType, data, ...note } }));
    },
    onSuccess: onClose,
  });
  const missing = Object.entries(def.fields).some(([k, f]) => f.required && !data[k]);
  return (
    <Dialog title={`${row ? '修改' : '新建'}${def.label ?? entityType}`} onClose={onClose} testId="entity-dialog">
      <DialogForm error={save.error?.message} submitting={save.isPending} submitLabel="保存" canSubmit={!missing} onSubmit={() => save.mutate()} onCancel={onClose}>
        {Object.entries(def.fields).map(([k, f]) => {
          const value = String(data[k] ?? '');
          return (
            <Field key={k} label={f.label ?? k} required={f.required}>
              {f.type === 'enum' ? (
                <Select value={value} onChange={(e) => set(k, e.target.value)}>
                  <option value="">—</option>
                  {f.enum?.map((v) => <option key={v} value={v}>{STATE_LABEL[v] ?? v}</option>)}
                </Select>
              ) : f.type === 'text' || f.type === 'markdown' ? (
                <Textarea rows={3} value={value} onChange={(e) => set(k, e.target.value)} />
              ) : (
                <Input type={f.type === 'date' ? 'date' : 'text'} value={value} onChange={(e) => set(k, e.target.value)} data-testid={`entity-${k}`} />
              )}
            </Field>
          );
        })}
        {row && (
          <Field label="修改理由">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        )}
      </DialogForm>
    </Dialog>
  );
}

function History({ id, current, editable }: { id: string; current: number; editable: boolean }) {
  const q = useEntityVersions(id);
  const rollback = useMutation({
    mutationFn: async (version: number) => unwrap(await api.entities[':id'].rollback.$post({ param: { id }, json: { version } })),
  });
  return (
    <ol className="space-y-1">
      {(q.data ?? []).map((v) => (
        <li key={v.id} className="measured flex gap-3 text-xs text-muted">
          <span className="text-cool">v{v.version}</span>
          <span>{v.authorType === 'human' ? '本地用户' : 'Agent'}</span>
          <span>{when(v.createdAt)}</span>
          {v.reason && <span className="font-sans text-ink-2">{v.reason}</span>}
          {editable && v.version !== current && (
            <button type="button" className="font-sans text-cool hover:underline" disabled={rollback.isPending} onClick={() => rollback.mutate(v.version)} data-testid="entity-rollback">回滚到此版本</button>
          )}
        </li>
      ))}
    </ol>
  );
}

function Row({ row, def, editable, onEdit, extra }: { row: EntityRow; def: EntityDef; editable: boolean; onEdit: () => void; extra?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const data = parseJson<Data>(row.dataJson, {});
  const titleKey = def.titleField ?? Object.keys(def.fields)[0] ?? '';
  const stateKey = Object.entries(def.fields).find(([, f]) => f.type === 'enum')?.[0];
  const dateKey = Object.entries(def.fields).find(([, f]) => f.type === 'date')?.[0];
  const state = stateKey ? String(data[stateKey] ?? '') : '';
  const rest = Object.entries(def.fields).filter(([k]) => k !== titleKey && k !== stateKey && k !== dateKey && data[k]);
  return (
    <li className="relative border-b border-l border-rule border-l-rule-2 py-3 pl-5 before:absolute before:-left-1 before:top-5 before:size-[7px] before:rounded-full before:bg-cool">
      <div className="flex items-center gap-3">
        <span className="measured w-10 shrink-0 text-xs text-cool">v{row.version}</span>
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="min-w-0 flex-1 truncate text-left text-md text-ink hover:underline">
          {String(data[titleKey] ?? '未命名')}
        </button>
        {dateKey && !!data[dateKey] && <span className="measured text-xs text-muted">{String(data[dateKey])}</span>}
        <span className="measured text-xs text-muted">{when(row.updatedAt ?? row.createdAt)}</span>
        {state && <Badge tone={STATE_TONE[state] ?? 'neutral'}>{STATE_LABEL[state] ?? state}</Badge>}
        {extra}
      </div>
      {open && (
        <div className="mt-3 space-y-3 pl-[3.25rem]">
          {rest.map(([k, f]) => (
            <div key={k}>
              <p className="text-xs text-muted">{f.label ?? k}</p>
              <p className="whitespace-pre-wrap text-sm text-ink-2">{String(data[k])}</p>
            </div>
          ))}
          <History id={row.id} current={row.version} editable={editable} />
          {editable && <Button size="sm" onClick={onEdit}>修改</Button>}
        </div>
      )}
    </li>
  );
}

// 结构化实体的版本轨：table / timeline 板块共用，字段全部来自 manifest
export function EntityPanel({ wsId, entityType, def, editable, sortByDate, rowExtra, emptyExtra }: { wsId: string; entityType: string; def: EntityDef; editable: boolean; sortByDate?: boolean; rowExtra?: (row: EntityRow) => ReactNode; emptyExtra?: ReactNode }) {
  const q = useWsEntities(wsId);
  const [dialog, setDialog] = useState<{ row?: EntityRow } | null>(null);
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} />;
  const label = def.label ?? entityType;
  const dateKey = Object.entries(def.fields).find(([, f]) => f.type === 'date')?.[0];
  const rows = (q.data?.entities ?? []).filter((e) => e.entityType === entityType);
  if (sortByDate && dateKey) {
    rows.sort((a, b) => String(parseJson<Data>(a.dataJson, {})[dateKey] ?? '9').localeCompare(String(parseJson<Data>(b.dataJson, {})[dateKey] ?? '9')));
  }
  return (
    <div className="h-full overflow-y-auto" data-testid={`entity-panel-${entityType}`}>
      <div className={cn('flex items-center justify-between px-6 pt-4', rows.length === 0 && 'hidden')}>
        <p className="text-sm text-muted">{label} <span className="measured">{rows.length}</span></p>
        {editable && <Button variant="primary" onClick={() => setDialog({})}>新建{label}</Button>}
      </div>
      {rows.length === 0 ? (
        <Empty title={`还没有${label}`}>
          <p>{def.description}</p>
          {emptyExtra}
          {editable && <Button variant="primary" className="mt-3" onClick={() => setDialog({})}>新建{label}</Button>}
        </Empty>
      ) : (
        <ol className="px-6 py-3">
          {rows.map((r) => <Row key={r.id} row={r} def={def} editable={editable} onEdit={() => setDialog({ row: r })} extra={rowExtra?.(r)} />)}
        </ol>
      )}
      {dialog && <EntityDialog wsId={wsId} entityType={entityType} def={def} row={dialog.row} onClose={() => setDialog(null)} />}
    </div>
  );
}

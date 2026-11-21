import { useMutation } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogForm } from '@/components/ui/dialog';
import { Empty, ErrorState, Loading } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/icons';
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
    <ol className="grid gap-1.5 rounded-ctl bg-paper-2 px-3.5 py-2.5">
      {(q.data ?? []).map((v) => (
        <li key={v.id} className="measured flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span className="font-semibold text-ink-2">v{v.version}</span>
          <span>{v.authorType === 'human' ? '本地用户' : 'Agent'}</span>
          <span>{when(v.createdAt)}</span>
          {v.reason && <span className="font-sans text-ink-2">{v.reason}</span>}
          {editable && v.version !== current && (
            <button type="button" className="font-sans font-medium text-cool hover:underline disabled:opacity-50" disabled={rollback.isPending} onClick={() => rollback.mutate(v.version)} data-testid="entity-rollback">回滚到此版本</button>
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
    <li className="border-b border-rule last:border-b-0">
      <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 transition-colors duration-100 hover:bg-hover', open && 'bg-paper-2 hover:bg-paper-2')}>
        <Icon name="chev" className={cn('size-3.5 shrink-0 text-muted transition-transform duration-150', !open && '-rotate-90')} />
        <span className="measured shrink-0 rounded-chip bg-cool-soft px-1.5 py-0.5 text-xs font-semibold text-cool">v{row.version}</span>
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="min-w-0 flex-[1_1_12rem] truncate text-left text-sm font-semibold text-ink hover:underline">
          {String(data[titleKey] ?? '未命名')}
        </button>
        {dateKey && !!data[dateKey] && <span className="measured text-xs text-muted">{String(data[dateKey])}</span>}
        <span className="measured text-xs text-muted max-sm:hidden">{when(row.updatedAt ?? row.createdAt)}</span>
        {state && <Badge tone={STATE_TONE[state] ?? 'neutral'}>{STATE_LABEL[state] ?? state}</Badge>}
        {extra}
      </div>
      {open && (
        <div className="grid gap-3 bg-paper-2 px-4 pb-4 pl-[2.6rem] max-sm:pl-4">
          {rest.length > 0 && (
            <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-sm max-sm:grid-cols-1 max-sm:gap-y-1">
              {rest.map(([k, f]) => (
                <div key={k} className="contents">
                  <dt className="text-muted">{f.label ?? k}</dt>
                  <dd className="whitespace-pre-wrap text-ink-2 max-sm:mb-1.5">{String(data[k])}</dd>
                </div>
              ))}
            </dl>
          )}
          <History id={row.id} current={row.version} editable={editable} />
          {editable && <Button size="sm" className="w-fit" onClick={onEdit}><Icon name="edit" />修改</Button>}
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
    <div className="h-full overflow-y-auto px-5 py-4" data-testid={`entity-panel-${entityType}`}>
      <div className={cn('mb-3 flex flex-wrap items-center justify-between gap-2', rows.length === 0 && 'hidden')}>
        <p className="text-sm text-muted">{label} <span className="font-semibold tabular-nums text-ink">{rows.length}</span></p>
        {editable && <Button variant="primary" onClick={() => setDialog({})}><Icon name="plus" />新建{label}</Button>}
      </div>
      {rows.length === 0 ? (
        <Empty title={`还没有${label}`} icon="table">
          <p>{def.description}</p>
          {emptyExtra}
          {editable && <Button variant="primary" className="mt-3" onClick={() => setDialog({})}><Icon name="plus" />新建{label}</Button>}
        </Empty>
      ) : (
        <ol className="overflow-hidden rounded-card bg-paper shadow-[var(--shadow-card)]">
          {rows.map((r) => <Row key={r.id} row={r} def={def} editable={editable} onEdit={() => setDialog({ row: r })} extra={rowExtra?.(r)} />)}
        </ol>
      )}
      {dialog && <EntityDialog wsId={wsId} entityType={entityType} def={def} row={dialog.row} onClose={() => setDialog(null)} />}
    </div>
  );
}

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, Loading, toast } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/icons';
import { Field, Input } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { when } from '@/lib/format';
import { useAsset, useAssets, useClipRequests, type AssetDetail, type AssetRow, type ClipRequest, type WorkstationDetail } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { ASSET_KIND_LABEL, CLIP_STATUS_LABEL, CLIP_STATUS_TONE, seconds } from './model';

type KindFilter = 'all' | 'image' | 'video' | 'audio';
type SourceFilter = 'all' | 'upload' | 'generated';

const KINDS: { value: KindFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'audio', label: '音频' },
];
const SOURCES: { value: SourceFilter; label: string }[] = [
  { value: 'all', label: '全部来源' },
  { value: 'upload', label: '上传' },
  { value: 'generated', label: '生成' },
];

function Thumb({ a }: { a: AssetRow }) {
  if (a.kind === 'image') return <img src={`/api/media/${a.artifactId}`} alt={a.name} className="size-full object-cover" loading="lazy" />;
  if (a.kind === 'video' && a.poster) return <img src={`/api/media/${a.poster}`} alt={a.name} className="size-full object-cover" loading="lazy" />;
  return (
    <span className="grid size-full place-items-center bg-paper-3 text-muted">
      <Icon name={a.kind === 'video' ? 'film' : 'wave'} className="size-6" />
    </span>
  );
}

function ClipCard({ req, onDecide, busy }: { req: ClipRequest; onDecide: (decision: 'approve' | 'reject') => void; busy: boolean }) {
  const cost = `$${(req.estimatedCostMicros / 1e6).toFixed(3)}`;
  return (
    <li className="grid gap-1.5 rounded-ctl border border-rule bg-paper px-3 py-2.5" data-testid={`clip-request-${req.id}`}>
      <span className="flex items-center gap-2">
        <Badge tone={CLIP_STATUS_TONE[req.status] ?? 'neutral'}>{CLIP_STATUS_LABEL[req.status] ?? req.status}</Badge>
        <span className="text-xs tabular-nums text-muted">{seconds(req.duration)} · 预估 {cost}{req.provider ? ` · ${req.provider}` : ''}</span>
        <span className="ml-auto text-xs text-muted">{when(req.createdAt ?? null)}</span>
      </span>
      <p className="line-clamp-3 text-xs text-ink-2">{req.prompt}</p>
      {req.negativePrompt ? <p className="line-clamp-1 text-xs text-muted">反向：{req.negativePrompt}</p> : null}
      {req.error ? <p className="text-xs text-bad">{req.error}</p> : null}
      {req.status === 'pending' ? (
        <span className="flex items-center gap-1.5">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => onDecide('approve')} data-testid={`clip-approve-${req.id}`}>
            <Icon name="check" />批准（{cost}）
          </Button>
          <Button size="sm" disabled={busy} onClick={() => onDecide('reject')} data-testid={`clip-reject-${req.id}`}>拒绝</Button>
        </span>
      ) : null}
    </li>
  );
}

function AssetDetailPane({ id, onClose, onGone }: { id: string; onClose: () => void; onGone: () => void }) {
  const q = useAsset(id);
  const a = q.data;
  const [license, setLicense] = useState<string | null>(null);
  const [tags, setTags] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async (d: AssetDetail) =>
      unwrap(
        await api.assets[':id'].$patch({
          param: { id: d.id },
          json: { name: name ?? d.name, license: license ?? d.license, tags: (tags ?? d.tags.join(', ')).split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean), baseVersion: d.version },
        }),
      ),
    meta: { silent: true },
    onSuccess: () => {
      toast('素材信息已保存', 'ok');
      setLicense(null);
      setTags(null);
      setName(null);
    },
    onError: (e) => setError(e.message),
  });
  const remove = useMutation({
    mutationFn: async (assetId: string) => unwrap(await api.assets[':id'].$delete({ param: { id: assetId } })),
    meta: { silent: true },
    onSuccess: onGone,
    onError: (e) => setError(e.message),
  });
  if (!a) return q.isError ? <Empty title="素材不存在" /> : <Loading className="flex-1" />;
  const used = a.usedBy ?? [];
  return (
    <aside className="flex w-[22rem] shrink-0 flex-col overflow-y-auto border-l border-rule bg-paper-2" data-testid="asset-detail">
      <header className="flex items-center gap-2 border-b border-rule px-4 py-2.5">
        <h3 className="min-w-0 flex-1 truncate text-title font-bold text-ink">{a.name}</h3>
        <Button variant="quiet" size="icon-sm" aria-label="关闭" onClick={onClose}><Icon name="close" /></Button>
      </header>
      <div className="grid gap-3 px-4 py-3">
        <div className="overflow-hidden rounded-ctl border border-rule bg-ink">
          {a.kind === 'image' ? <img src={`/api/media/${a.artifactId}`} alt={a.name} className="max-h-64 w-full object-contain" /> : null}
          {a.kind === 'video' ? <video src={`/api/media/${a.artifactId}`} controls preload="metadata" className="max-h-64 w-full bg-black" data-testid="asset-detail-video" /> : null}
          {a.kind === 'audio' ? <audio src={`/api/media/${a.artifactId}`} controls className="w-full px-2 py-3" /> : null}
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-ink-2">
          <dt className="text-muted">类型</dt>
          <dd>{ASSET_KIND_LABEL[a.kind] ?? a.kind} · {a.source === 'generated' ? '生成' : '上传'}</dd>
          <dt className="text-muted">规格</dt>
          <dd className="tabular-nums">{a.width ?? '?'}×{a.height ?? '?'}{a.duration ? ` · ${seconds(a.duration)}` : ''}</dd>
          <dt className="text-muted">格式</dt>
          <dd>{a.mime || '—'}</dd>
          {a.provider ? (<><dt className="text-muted">生成服务</dt><dd>{a.provider}</dd></>) : null}
          <dt className="text-muted">入库</dt>
          <dd>{when(a.createdAt)}</dd>
        </dl>
        {a.prompt ? <p className="rounded-ctl bg-paper-3 px-2.5 py-2 text-xs text-ink-2" data-testid="asset-detail-prompt">{a.prompt}</p> : null}
        <Field label="名称">
          <Input value={name ?? a.name} onChange={(e) => setName(e.target.value)} data-testid="asset-name" />
        </Field>
        <Field label="授权 / 来源" hint="用在哪、能不能商用，写清楚免得以后翻账">
          <Input value={license ?? a.license} onChange={(e) => setLicense(e.target.value)} placeholder="例如：团队内部素材 / CC BY 4.0" data-testid="asset-license" />
        </Field>
        <Field label="标签" hint="逗号分隔">
          <Input value={tags ?? a.tags.join(', ')} onChange={(e) => setTags(e.target.value)} data-testid="asset-tags" />
        </Field>
        {error ? <p className="text-xs text-bad" data-testid="asset-error">{error}</p> : null}
        <div className="flex items-center gap-2">
          <Button size="sm" variant="primary" disabled={save.isPending} onClick={() => save.mutate(a)} data-testid="asset-save">保存</Button>
          <Button size="sm" variant="danger" className="ml-auto" disabled={remove.isPending || used.length > 0} title={used.length ? '还有镜头在用' : '删除素材'} onClick={() => remove.mutate(a.id)} data-testid="asset-delete">
            <Icon name="trash" />删除
          </Button>
        </div>
        <div className="grid gap-1 border-t border-rule pt-2">
          <span className="text-xs font-semibold text-ink">用在 {used.length} 个镜头</span>
          {used.length === 0 ? <span className="text-xs text-muted">还没有镜头用它。还被用着的时候不能删。</span> : null}
          <ul className="grid gap-1">
            {used.map((u) => (
              <li key={u.shotId} className="truncate text-xs text-ink-2">· {u.title}</li>
            ))}
          </ul>
        </div>
      </div>
    </aside>
  );
}

// 素材面板：上传 / 挑素材 / 批片段申请。片段申请是 Agent 写的待办，人在这里决定花不花这笔钱
export function AssetPanel({ ws }: { ws: WorkstationDetail }) {
  const q = useAssets(ws.id);
  const clips = useClipRequests(ws.id);
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<KindFilter>('all');
  const [source, setSource] = useState<SourceFilter>('all');
  const [picked, setPicked] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const f of files) {
        const body = new FormData();
        body.append('file', f);
        const res = await fetch(`/api/workstations/${ws.id}/assets`, { method: 'POST', body });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `上传失败（${res.status}）`);
        }
      }
      return files.length;
    },
    meta: { silent: true },
    onSuccess: (n) => {
      setError(null);
      toast(`上传了 ${n} 个素材`, 'ok');
      void qc.invalidateQueries({ queryKey: ['video-assets', ws.id] });
    },
    onError: (e) => setError(e.message),
  });
  const decide = useMutation({
    mutationFn: async (input: { id: string; decision: 'approve' | 'reject' }) =>
      unwrap(await api['clip-requests'][':id'].decide.$post({ param: { id: input.id }, json: { decision: input.decision } })),
    onSuccess: (r) => {
      toast(r.status === 'rejected' ? '已拒绝这次申请' : '已批准，开始生成片段（花费记在本台账上）', 'ok');
      void qc.invalidateQueries({ queryKey: ['video-clips', ws.id] });
    },
    onError: (e) => setError(e.message),
  });

  const list = useMemo(() => {
    const all = q.data?.assets ?? [];
    return all.filter((a) => (kind === 'all' || a.kind === kind) && (source === 'all' || a.source === source));
  }, [q.data, kind, source]);
  const requests = clips.data?.requests ?? [];
  const pending = requests.filter((r) => r.status === 'pending');
  const active = requests.filter((r) => r.status === 'running' || r.status === 'approved');

  if (!q.data) return q.isError ? <Empty title="素材加载失败" /> : <Loading className="flex-1" />;

  return (
    <div className="flex min-h-0 min-w-0 flex-1" data-testid="video-assets">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-rule bg-paper px-4 py-2.5">
          <h2 className="text-title font-bold text-ink">素材</h2>
          <span className="text-xs tabular-nums text-muted">{list.length}{list.length !== (q.data.assets.length) ? ` / ${q.data.assets.length}` : ''}</span>
          <span className="ml-auto flex flex-wrap items-center gap-1.5">
            <span className="inline-flex gap-0.5 rounded-btn bg-paper-3 p-[3px]">
              {KINDS.map((k) => (
                <button key={k.value} type="button" aria-pressed={kind === k.value} onClick={() => setKind(k.value)} className={cn('h-[22px] rounded-btn px-2 text-xs transition-colors duration-150', kind === k.value ? 'bg-primary font-semibold text-primary-ink' : 'text-muted hover:text-ink')} data-testid={`asset-kind-${k.value}`}>
                  {k.label}
                </button>
              ))}
            </span>
            <span className="inline-flex gap-0.5 rounded-btn bg-paper-3 p-[3px]">
              {SOURCES.map((s) => (
                <button key={s.value} type="button" aria-pressed={source === s.value} onClick={() => setSource(s.value)} className={cn('h-[22px] rounded-btn px-2 text-xs transition-colors duration-150', source === s.value ? 'bg-primary font-semibold text-primary-ink' : 'text-muted hover:text-ink')} data-testid={`asset-source-${s.value}`}>
                  {s.label}
                </button>
              ))}
            </span>
            <Button size="sm" variant="primary" disabled={upload.isPending} onClick={() => input.current?.click()} data-testid="asset-upload">
              <Icon name="upload" />{upload.isPending ? '上传中…' : '上传'}
            </Button>
            <input
              ref={input}
              type="file"
              multiple
              accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime,audio/mpeg,audio/wav,audio/ogg"
              className="hidden"
              data-testid="asset-file-input"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = '';
                if (files.length) upload.mutate(files);
              }}
            />
          </span>
        </header>
        {error ? <p className="shrink-0 border-b border-rule bg-bad-soft px-4 py-2 text-sm text-bad" data-testid="asset-error">{error}</p> : null}
        {pending.length || active.length ? (
          <div className="shrink-0 border-b border-rule bg-paper-2 px-4 py-3" data-testid="clip-requests">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-sm font-semibold text-ink">片段申请</span>
              {pending.length ? <Badge tone="amber">{pending.length} 条等审批</Badge> : null}
              {active.length ? <Badge tone="cool">{active.length} 条在生成</Badge> : null}
              <span className="text-xs text-muted">批准才开始生成并记预算</span>
            </div>
            <ul className="grid gap-2">
              {[...pending, ...active].map((r) => (
                <ClipCard key={r.id} req={r} busy={decide.isPending} onDecide={(decision) => decide.mutate({ id: r.id, decision })} />
              ))}
            </ul>
          </div>
        ) : null}
        <div
          className={cn('min-h-0 flex-1 overflow-y-auto p-4', dropping && 'bg-accent-soft')}
          onDragOver={(e) => {
            e.preventDefault();
            setDropping(true);
          }}
          onDragLeave={() => setDropping(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDropping(false);
            const files = [...e.dataTransfer.files];
            if (files.length) upload.mutate(files);
          }}
          data-testid="asset-drop"
        >
          {list.length === 0 ? (
            <Empty title="还没有素材" icon="layers">把图片、短片或者音频拖到这里，或者点右上角上传。生成片段要先让人批准申请。</Empty>
          ) : (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-3">
              {list.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => setPicked(a.id)}
                    className={cn('grid w-full gap-1.5 rounded-ctl border bg-paper p-1.5 text-left transition-colors duration-150', picked === a.id ? 'border-ink' : 'border-rule hover:bg-paper-2')}
                    data-testid={`asset-card-${a.id}`}
                  >
                    <span className="block aspect-video overflow-hidden rounded-chip bg-paper-3">
                      <Thumb a={a} />
                    </span>
                    <span className="flex items-center gap-1.5 px-1">
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{a.name}</span>
                      <Badge tone={a.source === 'generated' ? 'cool' : 'line'}>{ASSET_KIND_LABEL[a.kind] ?? a.kind}</Badge>
                    </span>
                    <span className="flex items-center gap-1.5 px-1 text-xs text-muted">
                      <span className="tabular-nums">{a.width ?? '?'}×{a.height ?? '?'}{a.duration ? ` · ${seconds(a.duration)}` : ''}</span>
                      {a.used ? <span className="ml-auto tabular-nums" title="被几个镜头用着">用 {a.used}</span> : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
      {picked ? <AssetDetailPane key={picked} id={picked} onClose={() => setPicked(null)} onGone={() => { setPicked(null); void qc.invalidateQueries({ queryKey: ['video-assets', ws.id] }); }} /> : null}
    </div>
  );
}

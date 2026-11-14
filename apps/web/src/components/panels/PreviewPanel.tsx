import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty } from '@/components/ui/feedback';
import { Field, Input } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { parseJson } from '@/lib/format';
import { useWsEntities } from '@/lib/queries';
import { cn } from '@/lib/utils';

interface PreviewConfig { urlField?: string; baselineField?: string; entity?: string }

// 页面实体的 route 可以是完整地址，也可以是相对路径（拼在本地地址后面）
const joinUrl = (origin: string, route: string) => (/^https?:\/\//.test(route) ? route : `${origin.replace(/\/+$/, '')}/${route.replace(/^\/+/, '')}`);

const pct = (r: number) => `${(r * 100).toFixed(2)}%`;

// 页面预览：给本地运行的页面截图；登记了 Page 的可以一键套用地址，并和仓库里的基线截图做像素对比
export function PreviewPanel({ wsId, config }: { wsId: string; config?: PreviewConfig }) {
  const urlField = config?.urlField ?? 'route';
  const baselineField = config?.baselineField ?? 'screenshot_ref';
  const [origin, setOrigin] = useState('http://localhost:5173');
  const [url, setUrl] = useState('http://localhost:5173');
  const [baseline, setBaseline] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const entities = useWsEntities(wsId);
  const pages = (entities.data?.entities ?? [])
    .filter((e) => e.entityType === (config?.entity ?? 'Page'))
    .map((e) => ({ id: e.id, data: parseJson<Record<string, unknown>>(e.dataJson, {}) }))
    .filter((p) => typeof p.data[urlField] === 'string' && p.data[urlField]);

  const shot = useMutation({
    mutationFn: async () =>
      unwrap(await api.workstations[':id'].screenshot.$post({ param: { id: wsId }, json: { url, ...(baseline.trim() ? { baseline: baseline.trim() } : {}) } })),
  });
  const compare = shot.data?.compare;

  const pick = (p: (typeof pages)[number]) => {
    setPicked(p.id);
    setUrl(joinUrl(origin, String(p.data[urlField])));
    setBaseline(typeof p.data[baselineField] === 'string' ? String(p.data[baselineField]) : '');
  };

  return (
    <div className="@container h-full min-h-0" data-testid="preview-panel">
    <div className={cn('grid h-full min-h-0', pages.length > 0 ? 'grid-rows-[auto_minmax(0,1fr)] @2xl:grid-cols-[15rem_minmax(0,1fr)] @2xl:grid-rows-1' : 'grid-cols-1')}>
      {pages.length > 0 && (
        <div className="flex max-h-40 min-h-0 flex-col gap-1 overflow-y-auto border-b border-rule p-2 @2xl:max-h-none @2xl:border-b-0 @2xl:border-r" data-testid="preview-pages">
          <p className="px-1 pb-1 text-xs text-muted">页面 {pages.length}</p>
          {pages.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-current={picked === p.id}
              onClick={() => pick(p)}
              className={cn('rounded-pill border p-2 text-left transition-colors duration-150', picked === p.id ? 'border-rule bg-paper-2' : 'border-transparent hover:bg-paper-2')}
            >
              <span className="block truncate text-sm text-ink-2">{String(p.data.name ?? p.data[urlField])}</span>
              <span className="measured block truncate text-xs text-muted">{String(p.data[urlField])}</span>
            </button>
          ))}
        </div>
      )}
      <div className="flex min-h-0 flex-col">
        <div className="flex flex-wrap items-end gap-2 border-b border-rule px-4 py-2">
          {pages.length > 0 && (
            <Field label="本地地址" className="w-52">
              <Input className="measured h-8" aria-label="本地地址" value={origin} onChange={(e) => setOrigin(e.target.value)} />
            </Field>
          )}
          <Field label="页面地址" className="min-w-64 flex-1">
            <Input className="measured h-8" aria-label="页面地址" value={url} onChange={(e) => setUrl(e.target.value)} data-testid="preview-url" />
          </Field>
          <Field label="基线（仓库内路径，可选）" className="w-64">
            <Input className="measured h-8" aria-label="基线路径" value={baseline} placeholder="shots/home.png" onChange={(e) => setBaseline(e.target.value)} data-testid="preview-baseline" />
          </Field>
          <Button disabled={shot.isPending || !url.trim()} onClick={() => shot.mutate()} data-testid="preview-shot">
            {shot.isPending ? '截图中…' : baseline.trim() ? '截图并对比' : '截图'}
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {shot.data ? (
            <div className="space-y-3">
              {compare && (
                <p className="flex items-center gap-2 text-sm text-ink-2" data-testid="preview-compare">
                  {'ratio' in compare && typeof compare.ratio === 'number' ? (
                    <>
                      <Badge tone={compare.ratio <= 0.02 ? 'ok' : 'bad'}>差异 {pct(compare.ratio)}</Badge>
                      <span className="text-xs text-muted">基线取自 {compare.ref}；visual 验收默认上限 2%</span>
                    </>
                  ) : (
                    <Badge tone="bad">{'error' in compare ? compare.error : '对比失败'}</Badge>
                  )}
                </p>
              )}
              <div className={cn('grid gap-3', compare && 'baselineId' in compare && compare.baselineId ? 'lg:grid-cols-2' : 'grid-cols-1')}>
                {compare && 'baselineId' in compare && compare.baselineId && (
                  <figure className="space-y-1">
                    <figcaption className="text-xs text-muted">基线</figcaption>
                    <img src={`/api/artifacts/${compare.baselineId}/image`} alt={`${baseline} 基线截图`} className="max-w-full rounded-card border border-rule" data-testid="preview-baseline-image" />
                  </figure>
                )}
                <figure className="space-y-1">
                  {compare && <figcaption className="text-xs text-muted">当前</figcaption>}
                  <img src={`/api/artifacts/${shot.data.artifactId}/image`} alt={`${url} 的截图`} className="max-w-full rounded-card border border-rule" data-testid="preview-image" />
                </figure>
              </div>
            </div>
          ) : (
            <Empty title="还没有截图">输入本地页面地址截一张图；填了基线路径会和仓库里的基线做像素对比。要做回归验收，在任务验收里加 visual 断言。</Empty>
          )}
        </div>
      </div>
    </div>
    </div>
  );
}

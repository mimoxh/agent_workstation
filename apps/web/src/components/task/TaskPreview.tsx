import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Segmented } from '@/components/design/panes';
import { DesignFrame } from '@/components/design/DesignFrame';
import { Badge } from '@/components/ui/badge';
import { Button, Spinner } from '@/components/ui/button';
import { Empty, Loading } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/icons';
import { api, unwrap } from '@/lib/api';
import { useTaskDesignHandoff, useTaskPreview } from '@/lib/queries';
import { cn } from '@/lib/utils';

type DeviceId = 'desktop' | 'tablet' | 'mobile';
const DEVICES: { id: DeviceId; label: string; width: number }[] = [
  { id: 'desktop', label: '桌面', width: 1280 },
  { id: 'tablet', label: '平板', width: 834 },
  { id: 'mobile', label: '手机', width: 390 },
];

const STATUS_LABEL: Record<string, string> = { starting: '启动中', running: '运行中', failed: '失败', stopped: '已停止' };
const STATUS_TONE: Record<string, 'cool' | 'ok' | 'bad' | 'neutral'> = { starting: 'cool', running: 'ok', failed: 'bad', stopped: 'neutral' };

// 预览 iframe 和平台同域但不同端口：sandbox 给脚本和表单，设计稿对照只走 DesignFrame
export function TaskPreview({ taskId, hasHandoff }: { taskId: string; hasHandoff: boolean }) {
  const qc = useQueryClient();
  const q = useTaskPreview(taskId);
  const handoff = useTaskDesignHandoff(hasHandoff ? taskId : null);
  const [device, setDevice] = useState<DeviceId>('desktop');
  const [compare, setCompare] = useState(false);
  const [nonce, setNonce] = useState(0);
  const refresh = () => qc.invalidateQueries({ queryKey: ['task-preview', taskId] });

  const start = useMutation({
    meta: { silent: true },
    mutationFn: async () => unwrap(await api.tasks[':id'].preview.$post({ param: { id: taskId } })),
    onSuccess: refresh,
  });
  const stop = useMutation({
    mutationFn: async () => unwrap(await api.tasks[':id'].preview.$delete({ param: { id: taskId } })),
    onSuccess: refresh,
  });

  if (q.isLoading) return <Loading />;
  const p = q.data;
  const status = p?.status ?? 'stopped';
  const url = p?.url;
  const log = p?.log ?? '';
  const width = DEVICES.find((d) => d.id === device)?.width ?? 1280;

  if (status === 'stopped') {
    return (
      <div className="grid h-full place-items-center p-6">
        <Empty title="预览还没启动" icon="preview" className="min-h-0">
          <p>在任务 worktree 里执行「视觉验收服务」命令，起好后 iframe 直接看实现效果。</p>
          <div className="mt-4 grid justify-items-center gap-3">
            <Button variant="primary" disabled={start.isPending} aria-busy={start.isPending || undefined} onClick={() => start.mutate()} data-testid="preview-start">
              {start.isPending ? <Spinner /> : <Icon name="play" />}启动预览
            </Button>
            {start.error && <p className="rounded-ctl bg-bad-soft px-3.5 py-2.5 text-sm text-bad" data-testid="preview-error">{start.error.message}</p>}
          </div>
        </Empty>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="task-preview">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-rule px-4 py-2">
        <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{STATUS_LABEL[status] ?? status}</Badge>
        {url && <code className="min-w-0 truncate text-xs text-muted">{url}</code>}
        <span className="flex-1" />
        {hasHandoff && status === 'running' && <Button size="sm" variant="quiet" aria-pressed={compare} onClick={() => setCompare((v) => !v)} className="aria-pressed:bg-paper-3 aria-pressed:text-ink" data-testid="preview-compare">对照设计稿</Button>}
        <Segmented label="设备" value={device} options={DEVICES} onChange={setDevice} />
        <Button size="sm" variant="quiet" disabled={status !== 'running'} onClick={() => setNonce((n) => n + 1)} data-testid="preview-reload"><Icon name="refresh" />刷新</Button>
        {url && <Button size="sm" variant="quiet" onClick={() => window.open(url, '_blank', 'noopener')} data-testid="preview-open"><Icon name="external" />在新窗口打开</Button>}
        <Button size="sm" variant="danger" disabled={stop.isPending} onClick={() => stop.mutate()} data-testid="preview-stop"><Icon name="stop" />停止</Button>
      </div>
      {status === 'running' && url ? (
        <div className={cn('grid min-h-0 flex-1 overflow-auto bg-paper-3 p-4', compare && handoff.data && 'grid-cols-2 gap-3')}>
          <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-card bg-paper shadow-[var(--shadow-card)]">
            <iframe key={nonce} title="任务预览" sandbox="allow-scripts allow-forms allow-same-origin" src={url} className="mx-auto block h-full border-0" style={{ width: 'min(100%, ' + width + 'px)' }} data-testid="preview-frame" />
          </div>
          {compare && handoff.data && (
            <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-card bg-paper shadow-[var(--shadow-card)]">
              <DesignFrame doc={handoff.data.html} title={`${handoff.data.title} v${handoff.data.version}`} device={device === 'tablet' ? 'tablet' : device === 'mobile' ? 'mobile' : 'desktop'} testId="preview-design" />
            </div>
          )}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {status === 'starting' && (
            <p className="mb-3 flex items-center gap-2.5 rounded-ctl bg-cool-soft px-3.5 py-2.5 text-sm text-ink-2" data-testid="preview-starting">
              <Spinner className="text-cool" />serve 启动中，好了会自动出现…
            </p>
          )}
          {status === 'failed' && (
            <div className="mb-3 flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-ctl bg-bad-soft px-3.5 py-2.5 text-sm text-ink-2" data-testid="preview-failed">
              <Icon name="alert" className="text-bad" />
              <p className="min-w-0 flex-1 text-bad">{p?.error?.split('\n')[0] ?? '启动失败'}</p>
              <Button size="sm" disabled={start.isPending} onClick={() => start.mutate()}>重试</Button>
            </div>
          )}
          {log && <pre className="overflow-auto whitespace-pre-wrap rounded-ctl bg-code px-3.5 py-3 font-mono text-xs leading-[1.65] text-code-ink" data-testid="preview-log">{log}</pre>}
        </div>
      )}
    </div>
  );
}

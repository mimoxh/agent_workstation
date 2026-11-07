import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Empty } from '@/components/ui/feedback';
import { Input } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';

// 页面预览：给本地运行的页面截图；对比基线走任务的 visual 验收
export function PreviewPanel({ wsId }: { wsId: string }) {
  const [url, setUrl] = useState('http://localhost:5173');
  const shot = useMutation({
    mutationFn: async () => unwrap(await api.workstations[':id'].screenshot.$post({ param: { id: wsId }, json: { url } })),
  });
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="preview-panel">
      <div className="flex items-center gap-2 border-b border-rule px-4 py-2">
        <Input className="measured h-8 max-w-md" aria-label="页面地址" value={url} onChange={(e) => setUrl(e.target.value)} data-testid="preview-url" />
        <Button disabled={shot.isPending || !url.trim()} onClick={() => shot.mutate()} data-testid="preview-shot">{shot.isPending ? '截图中…' : '截图'}</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {shot.data ? (
          <img src={`/api/artifacts/${shot.data.artifactId}/image`} alt={`${url} 的截图`} className="max-w-full rounded-card border border-rule" data-testid="preview-image" />
        ) : (
          <Empty title="还没有截图">输入本地页面地址截一张图。要做回归对比，在任务验收里加 visual 断言。</Empty>
        )}
      </div>
    </div>
  );
}

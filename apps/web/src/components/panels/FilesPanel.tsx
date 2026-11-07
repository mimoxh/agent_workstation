import { useState } from 'react';
import { Empty, ErrorState, Loading } from '@/components/ui/feedback';
import { bytes } from '@/lib/format';
import { useFile, useFiles } from '@/lib/queries';
import { cn } from '@/lib/utils';

function FileView({ wsId, path }: { wsId: string; path: string }) {
  const q = useFile(wsId, path);
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} />;
  const lines = q.data?.content.split('\n') ?? [];
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="file-view">
      <p className="measured flex justify-between gap-3 border-b border-rule px-4 py-2 text-xs text-muted">
        <span className="truncate">{path}</span>
        <span className="shrink-0">{q.data?.ref} · {lines.length} 行{q.data?.truncated ? '（已截断）' : ''}</span>
      </p>
      {q.data?.binary ? (
        <Empty title="二进制文件" />
      ) : (
        <div className="measured min-h-0 flex-1 overflow-auto bg-paper-3 py-2 text-sm leading-6 text-ink-2">
          {lines.map((l, i) => (
            <div key={i} className="flex min-w-max">
              <span className="w-12 shrink-0 select-none pr-3 text-right text-xs leading-6 text-muted">{i + 1}</span>
              <span className="whitespace-pre pr-4">{l}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function FilesPanel({ wsId }: { wsId: string }) {
  const [dir, setDir] = useState('');
  const [file, setFile] = useState<string | null>(null);
  const list = useFiles(wsId, dir);
  const parts = dir ? dir.split('/') : [];

  if (list.data?.error && !dir) return <Empty title="文件树不可用">{list.data.error}</Empty>;

  return (
    <div className="grid h-full min-h-0 grid-cols-[17rem_minmax(0,1fr)]" data-testid="file-tree">
      <div className="flex min-h-0 flex-col border-r border-rule">
        <nav aria-label="当前目录" className="measured flex flex-wrap gap-1 border-b border-rule px-3 py-2 text-xs text-muted">
          <button type="button" className="hover:text-ink" onClick={() => setDir('')}>{list.data?.ref ?? '根'}</button>
          {parts.map((p, i) => (
            <button key={i} type="button" className="hover:text-ink" onClick={() => setDir(parts.slice(0, i + 1).join('/'))}>/{p}</button>
          ))}
        </nav>
        <ul className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {list.isLoading && <Loading className="p-2" />}
          {dir && (
            <li>
              <button type="button" className="w-full rounded-pill px-2 py-1 text-left text-sm text-muted hover:bg-paper-2" onClick={() => setDir(parts.slice(0, -1).join('/'))}>..</button>
            </li>
          )}
          {list.data?.entries.map((e) => (
            <li key={e.path}>
              <button
                type="button"
                data-testid="file-entry"
                onClick={() => (e.type === 'tree' ? setDir(e.path) : setFile(e.path))}
                className={cn('flex w-full items-baseline justify-between gap-2 rounded-pill px-2 py-1 text-left text-sm hover:bg-paper-2', file === e.path ? 'bg-paper-2 text-ink' : e.type === 'tree' ? 'text-cool' : 'text-ink-2')}
              >
                <span className="truncate">{e.name}{e.type === 'tree' ? '/' : ''}</span>
                <span className="measured shrink-0 text-xs text-muted">{bytes(e.size)}</span>
              </button>
            </li>
          ))}
          {list.data?.entries.length === 0 && !list.isLoading && <li className="p-2 text-sm text-muted">{list.data.error ?? '空目录'}</li>}
        </ul>
      </div>
      <div className="min-w-0">
        {file ? <FileView wsId={wsId} path={file} /> : <Empty title="选择左侧文件查看内容">读取的是目标分支上的版本，不含未合并的改动。</Empty>}
      </div>
    </div>
  );
}

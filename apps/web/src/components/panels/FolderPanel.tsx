import { useState } from 'react';
import { Empty, ErrorState, Loading } from '@/components/ui/feedback';
import { bytes } from '@/lib/format';
import { useFolderFile, useFolderFiles, type ProjectDetail } from '@/lib/queries';
import { cn } from '@/lib/utils';

function FileView({ projectId, path }: { projectId: string; path: string }) {
  const q = useFolderFile(projectId, path);
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} />;
  const lines = q.data?.content.split('\n') ?? [];
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="file-view">
      <p className="measured flex justify-between gap-3 border-b border-rule px-4 py-2 text-xs text-muted">
        <span className="truncate">{path}</span>
        <span className="shrink-0">{bytes(q.data?.size)} · {lines.length} 行{q.data?.truncated ? '（已截断）' : ''}</span>
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

export function FolderPanel({ project }: { project: ProjectDetail }) {
  const [dir, setDir] = useState('');
  const [file, setFile] = useState<string | null>(null);
  const list = useFolderFiles(project.id, dir);
  const parts = dir ? dir.split('/') : [];

  if (!project.folderPath) return <Empty title="项目还没有绑定文件夹">在根工作台的设置里绑定一个本地文件夹（不需要是 git 仓库），Agent 就能读它，改动要你审批。</Empty>;

  return (
    <div className="grid h-full min-h-0 grid-cols-[17rem_minmax(0,1fr)]" data-testid="folder-tree">
      <div className="flex min-h-0 flex-col border-r border-rule">
        <nav aria-label="当前目录" className="measured flex flex-wrap gap-1 border-b border-rule px-3 py-2 text-xs text-muted">
          <button type="button" className="hover:text-ink" onClick={() => setDir('')}>根</button>
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
                data-testid="folder-entry"
                onClick={() => (e.type === 'dir' ? setDir(e.path) : setFile(e.path))}
                className={cn('flex w-full items-baseline justify-between gap-2 rounded-pill px-2 py-1 text-left text-sm hover:bg-paper-2', file === e.path ? 'bg-paper-2 text-ink' : e.type === 'dir' ? 'text-cool' : 'text-ink-2')}
              >
                <span className="truncate">{e.name}{e.type === 'dir' ? '/' : ''}</span>
                <span className="measured shrink-0 text-xs text-muted">{bytes(e.size)}</span>
              </button>
            </li>
          ))}
          {list.data?.entries.length === 0 && !list.isLoading && <li className="p-2 text-sm text-muted">空目录</li>}
          {list.isError && <li className="p-2 text-sm text-muted">{list.error.message}</li>}
          {list.data?.truncated && <li className="p-2 text-xs text-muted">条目过多，只显示前 500 个</li>}
        </ul>
      </div>
      <div className="min-w-0">
        {file ? (
          <FileView projectId={project.id} path={file} />
        ) : (
          <Empty title="选择左侧文件查看内容">读的是项目文件夹里的当前版本；Agent 的改动提案通过审批后才会写进来。</Empty>
        )}
      </div>
    </div>
  );
}

import { useState } from 'react';
import { Empty, ErrorState, Loading } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/icons';
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
      <p className="measured flex shrink-0 justify-between gap-3 border-b border-rule bg-paper-2 px-3.5 py-2 text-xs text-muted">
        <span className="truncate font-medium text-ink">{path}</span>
        <span className="shrink-0">{bytes(q.data?.size)} · {lines.length} 行{q.data?.truncated ? '（已截断）' : ''}</span>
      </p>
      {q.data?.binary ? (
        <Empty title="二进制文件" icon="files" />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto bg-paper-2 py-2.5 font-mono text-xs leading-[1.7] text-ink-2">
          {lines.map((l, i) => (
            <div key={i} className="flex min-w-max">
              <span className="w-12 shrink-0 select-none pr-3 text-right text-faint">{i + 1}</span>
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

  if (!project.folderPath) return <Empty title="项目还没有绑定文件夹" icon="folder">在根工作台的设置里绑定一个本地文件夹（不需要是 git 仓库），Agent 就能读它，改动要你审批。</Empty>;

  return (
    <div className="grid h-full min-h-0 grid-cols-[17rem_minmax(0,1fr)] max-md:grid-cols-1 max-md:grid-rows-[minmax(0,2fr)_minmax(0,3fr)]" data-testid="folder-tree">
      <div className="flex min-h-0 flex-col border-r border-rule max-md:border-b max-md:border-r-0">
        <nav aria-label="当前目录" className="measured flex flex-wrap items-center gap-0.5 border-b border-rule px-2.5 py-2 text-xs text-muted">
          <button type="button" className="rounded-chip px-1.5 py-0.5 font-medium text-ink-2 hover:bg-hover hover:text-ink" onClick={() => setDir('')}>根</button>
          {parts.map((p, i) => (
            <button key={i} type="button" className="rounded-chip px-1 py-0.5 hover:bg-hover hover:text-ink" onClick={() => setDir(parts.slice(0, i + 1).join('/'))}>/{p}</button>
          ))}
        </nav>
        <ul className="grid min-h-0 flex-1 content-start gap-px overflow-y-auto p-1.5">
          {list.isLoading && <Loading className="p-2" />}
          {dir && (
            <li>
              <button type="button" className="flex min-h-[30px] w-full items-center gap-1.5 rounded-ctl px-2 text-left text-sm text-muted hover:bg-hover" onClick={() => setDir(parts.slice(0, -1).join('/'))}><Icon name="chev-l" className="size-3.5" />..</button>
            </li>
          )}
          {list.data?.entries.map((e) => (
            <li key={e.path}>
              <button
                type="button"
                data-testid="folder-entry"
                onClick={() => (e.type === 'dir' ? setDir(e.path) : setFile(e.path))}
                aria-current={file === e.path || undefined}
                className={cn('flex min-h-[30px] w-full items-center gap-1.5 rounded-ctl px-2 text-left text-sm transition-colors duration-100 hover:bg-hover', file === e.path ? 'bg-paper-3 font-semibold text-ink' : 'text-ink-2')}
              >
                <Icon name={e.type === 'dir' ? 'folder' : 'doc'} className="size-3.5 shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate">{e.name}{e.type === 'dir' ? '/' : ''}</span>
                <span className="shrink-0 text-xs tabular-nums text-faint">{bytes(e.size)}</span>
              </button>
            </li>
          ))}
          {list.data?.entries.length === 0 && !list.isLoading && <li className="p-2 text-sm text-muted">空目录</li>}
          {list.isError && <li className="p-2 text-sm text-muted">{list.error.message}</li>}
          {list.data?.truncated && <li className="p-2 text-xs text-muted">条目过多，只显示前 500 个</li>}
        </ul>
      </div>
      <div className="min-h-0 min-w-0">
        {file ? (
          <FileView projectId={project.id} path={file} />
        ) : (
          <Empty title="选择左侧文件查看内容" icon="files">读的是项目文件夹里的当前版本；Agent 的改动提案通过审批后才会写进来。</Empty>
        )}
      </div>
    </div>
  );
}

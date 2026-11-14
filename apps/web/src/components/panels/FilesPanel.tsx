import { useState } from 'react';
import { Empty, ErrorState, Loading } from '@/components/ui/feedback';
import { Select } from '@/components/ui/input';
import { bytes } from '@/lib/format';
import { useBranches, useFile, useFiles } from '@/lib/queries';
import { cn } from '@/lib/utils';

function FileView({ wsId, path, branch }: { wsId: string; path: string; branch: string }) {
  const q = useFile(wsId, path, branch);
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
  const [branch, setBranch] = useState('');
  const list = useFiles(wsId, dir, branch);
  const refs = useBranches(wsId);
  const parts = dir ? dir.split('/') : [];
  const taskBranches = refs.data?.branches ?? [];

  if (list.data?.error && !dir && !branch) return <Empty title="文件树不可用">{list.data.error}</Empty>;

  return (
    // 右侧栏里宽度有限：窄时目录在上、文件在下，够宽再左右分栏
    <div className="@container h-full min-h-0" data-testid="file-tree">
    <div className="grid h-full min-h-0 grid-rows-[minmax(0,2fr)_minmax(0,3fr)] @2xl:grid-cols-[17rem_minmax(0,1fr)] @2xl:grid-rows-1">
      <div className="flex min-h-0 flex-col border-b border-rule @2xl:border-b-0 @2xl:border-r">
        {taskBranches.length > 0 && (
          <div className="border-b border-rule px-3 py-2">
            <Select
              aria-label="浏览的分支"
              className="measured w-full text-xs"
              value={branch}
              onChange={(e) => {
                setBranch(e.target.value);
                setFile(null);
              }}
              data-testid="file-branch"
            >
              <option value="">目标分支{refs.data?.target ? `（${refs.data.target}）` : ''}</option>
              {taskBranches.map((b) => (
                <option key={b.branch} value={b.branch}>{b.branch} · {b.title}</option>
              ))}
            </Select>
          </div>
        )}
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
      <div className="min-h-0 min-w-0">
        {file ? (
          <FileView wsId={wsId} path={file} branch={branch} />
        ) : (
          <Empty title="选择文件查看内容">{branch ? `读取的是任务分支 ${branch} 上已提交的版本。` : '读取的是目标分支上的版本；要看还没合并的改动，在上方切到任务分支。'}</Empty>
        )}
      </div>
    </div>
    </div>
  );
}

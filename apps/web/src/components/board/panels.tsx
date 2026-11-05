import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface Proposal { id: string; taskId: string | null; status: string | null; authorId: string | null; reason: string | null; patchJson: string | null; createdAt: string }
interface ReviewComment { id: string; proposalId: string; path: string | null; line: number | null; body: string | null }

// 改动审阅：左提案列表 + 右 diff 分段 + 审查表单
export function DiffPanel({ wsId }: { wsId: string }) {
  const [sel, setSel] = useState<string | null>(null);
  const [summary, setSummary] = useState('');
  const proposals = useQuery({
    queryKey: ['proposals', wsId],
    refetchInterval: 5000,
    queryFn: async () => {
      const res = await apiClient.workstations[':id'].proposals.$get({ param: { id: wsId } });
      return (await res.json()) as Proposal[];
    },
  });
  const cur = proposals.data?.find((p) => p.id === sel) ?? proposals.data?.filter((p) => p.status === 'pending' || p.status === 'changes_requested')[0];
  const review = async (decision: 'approve' | 'request_changes') => {
    if (!cur) return;
    await apiClient.proposals[':id'].review.$post({ param: { id: cur.id }, json: { decision, summary: summary || decision } });
    await proposals.refetch();
  };
  return (
    <div className="flex h-full">
      <div className="w-52 shrink-0 overflow-y-auto border-r border-neutral-200 p-2 text-xs" data-testid="proposal-list">
        {(proposals.data ?? []).map((p) => (
          <button key={p.id} onClick={() => setSel(p.id)} className={cn('mb-1 block w-full rounded border p-1.5 text-left', cur?.id === p.id ? 'border-blue-400 bg-blue-50' : 'border-neutral-200')}>
            <div className="font-medium">{(p.reason ?? '').slice(0, 40) || p.id.slice(0, 8)}</div>
            <Badge tone={p.status === 'merged' ? 'green' : p.status === 'pending' ? 'blue' : 'neutral'}>{p.status}</Badge>
            <div className="text-neutral-400">{p.createdAt?.slice(0, 16)}</div>
          </button>
        ))}
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto p-4">
        {!cur && <div className="text-sm text-neutral-400">选择左侧提案</div>}
        {cur && <DiffView diff={cur.patchJson ?? ''} comments={[]} />}
        {cur && (cur.status === 'pending' || cur.status === 'changes_requested') && (
          <div className="mt-4 flex gap-2 border-t pt-3" data-testid="review-form">
            <input value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="审查意见" className="h-8 flex-1 rounded border border-neutral-300 px-2 text-xs" />
            <Button size="sm" onClick={() => void review('approve')}>通过</Button>
            <Button size="sm" variant="outline" onClick={() => void review('request_changes')}>要求修改</Button>
          </div>
        )}
      </div>
    </div>
  );
}

// diff 按文件分段，增删行着色
export function DiffView({ diff, comments }: { diff: string; comments: ReviewComment[] }) {
  const files = diff.split(/^diff --git /m).filter(Boolean);
  if (files.length === 0) return <div className="text-xs text-neutral-400">（无 diff）</div>;
  return (
    <div className="space-y-3 text-xs" data-testid="diff-view">
      {files.map((f, i) => {
        const name = f.match(/b\/(\S+)/)?.[1] ?? `file-${i}`;
        const fComments = comments.filter((c) => c.path === name);
        return (
          <div key={i} className="rounded border border-neutral-200">
            <div className="border-b bg-neutral-50 px-2 py-1 font-mono font-medium">{name}</div>
            {fComments.length > 0 && <div className="border-b bg-amber-50 px-2 py-1">{fComments.map((c) => <div key={c.id}>[{c.line ?? '-'}] {c.body}</div>)}</div>}
            <pre className="overflow-x-auto p-2 font-mono">
              {f.split('\n').slice(4).map((l, j) => (
                <div key={j} className={cn(l.startsWith('+') ? 'bg-green-50 text-green-800' : l.startsWith('-') ? 'bg-red-50 text-red-800' : l.startsWith('@@') ? 'text-blue-600' : 'text-neutral-600')}>{l}</div>
              ))}
            </pre>
          </div>
        );
      })}
    </div>
  );
}

// 测试结果表（TestRun）
export function TestRunTable({ wsId }: { wsId: string }) {
  const rows = useQuery({
    queryKey: ['testruns', wsId],
    refetchInterval: 5000,
    queryFn: async () => {
      const res = await apiClient.workstations[':id'].entities.$get({ param: { id: wsId } });
      const d = (await res.json()) as { entities: { id: string; entityType: string; dataJson: string }[] };
      return d.entities.filter((e) => e.entityType === 'TestRun').map((e) => JSON.parse(e.dataJson) as { command: string; status: string; duration: number; commit_sha?: string });
    },
  });
  return (
    <div className="p-4 text-xs" data-testid="testrun-table">
      {(rows.data ?? []).length === 0 && <div className="text-neutral-400">暂无测试记录</div>}
      {(rows.data ?? []).map((r, i) => (
        <div key={i} className="mb-1 flex gap-3 rounded border border-neutral-200 px-2 py-1">
          <Badge tone={r.status === 'passed' ? 'green' : 'red'}>{r.status}</Badge>
          <code>{r.command}</code>
          <span className="text-neutral-400">{r.duration.toFixed(1)}s {r.commit_sha?.slice(0, 7)}</span>
        </div>
      ))}
    </div>
  );
}

// 文件树（targetBranch ls-tree + show）
export function FileTree({ wsId }: { wsId: string }) {
  const [path, setPath] = useState('');
  const [file, setFile] = useState<{ name: string; content: string } | null>(null);
  const list = useQuery({
    queryKey: ['files', wsId, path],
    queryFn: async () => {
      const res = await fetch(`/api/workstations/${wsId}/files?path=${encodeURIComponent(path)}`);
      return (await res.json()) as { entries: string[] };
    },
  });
  const open = async (p: string) => {
    const res = await fetch(`/api/workstations/${wsId}/file?path=${encodeURIComponent(p)}`);
    const d = (await res.json()) as { content: string };
    setFile({ name: p, content: d.content });
  };
  const entries = (list.data?.entries ?? []).map((l) => {
    const parts = l.split(/\s+/);
    const type = parts[1] ?? '';
    const name = parts.slice(3).join(' ');
    return { type, name };
  });
  return (
    <div className="flex h-full" data-testid="file-tree">
      <div className="w-56 shrink-0 overflow-y-auto border-r border-neutral-200 p-2 font-mono text-xs">
        {path && <button className="mb-1 text-blue-600" onClick={() => setPath(path.split('/').slice(0, -1).join('/'))}>..</button>}
        {entries.map((e) => (
          <button key={e.name} className="block w-full text-left hover:bg-neutral-100" onClick={() => (e.type === 'tree' ? setPath(e.name) : void open(e.name))}>
            {e.type === 'tree' ? '📁' : '📄'} {e.name.split('/').pop()}
          </button>
        ))}
      </div>
      <div className="min-w-0 flex-1 overflow-auto p-3">
        {file ? <pre className="text-xs">{file.content.split('\n').map((l, i) => <div key={i}>{i + 1}: {l}</div>)}</pre> : <div className="text-sm text-neutral-400">选择文件</div>}
      </div>
    </div>
  );
}

import { useMutation } from '@tanstack/react-query';
import { useState, type ChangeEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogForm } from '@/components/ui/dialog';
import { Empty, ErrorState, Loading, toast } from '@/components/ui/feedback';
import { Field, Input, Textarea } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { bytes, when } from '@/lib/format';
import { useKnowledgeSearch, useKnowledgeSources } from '@/lib/queries';

function NoteDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const add = useMutation({
    meta: { silent: true },
    mutationFn: async () => unwrap(await api.projects[':id'].knowledge.$post({ param: { id: projectId }, json: { name: name.trim(), content, kind: 'note' } })),
    onSuccess: onClose,
  });
  return (
    <Dialog title="新建笔记" onClose={onClose} testId="note-dialog">
      <DialogForm error={add.error?.message} submitting={add.isPending} submitLabel="保存" canSubmit={!!name.trim() && !!content.trim()} onSubmit={() => add.mutate()} onCancel={onClose}>
        <Field label="名称" required>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} data-testid="note-name" />
        </Field>
        <Field label="内容" required hint="支持 Markdown 标题，检索结果会带上标题路径">
          <Textarea rows={8} value={content} onChange={(e) => setContent(e.target.value)} data-testid="note-content" />
        </Field>
      </DialogForm>
    </Dialog>
  );
}

function Results({ projectId, query }: { projectId: string; query: string }) {
  const q = useKnowledgeSearch(projectId, query);
  if (q.isLoading) return <Loading label="检索中…" />;
  if (!q.data?.length) return <p className="px-1 py-2 text-sm text-muted">没有命中。</p>;
  return (
    <ul className="space-y-2" data-testid="knowledge-results">
      {q.data.map((h) => (
        <li key={h.chunkId} className="rounded-pill border border-rule p-2.5">
          <p className="text-xs text-muted">{h.sourceName}{h.anchor.headingPath.length > 0 && ` › ${h.anchor.headingPath.join(' › ')}`}</p>
          <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-sm text-ink-2">{h.text}</p>
        </li>
      ))}
    </ul>
  );
}

// 知识库只读：系统要改的进实体，系统只读的进这里（DECISIONS Q3）
export function KnowledgePanel({ projectId }: { projectId: string }) {
  const sources = useKnowledgeSources(projectId);
  const [noting, setNoting] = useState(false);
  const [query, setQuery] = useState('');
  const importFile = useMutation({
    mutationFn: async (file: File) =>
      unwrap(await api.projects[':id'].knowledge.$post({ param: { id: projectId }, json: { name: file.name, content: await file.text(), kind: file.name.endsWith('.md') ? 'md' : 'txt' } })),
    onSuccess: () => toast('已导入', 'ok'),
  });
  const remove = useMutation({ mutationFn: async (id: string) => unwrap(await api.knowledge[':id'].$delete({ param: { id } })) });
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) importFile.mutate(file);
    e.target.value = '';
  };

  if (sources.isError) return <ErrorState error={sources.error} />;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="knowledge-panel">
      <div className="flex flex-wrap items-center gap-2 border-b border-rule px-4 py-2">
        <Input className="h-8 w-64" placeholder="检索知识库" aria-label="检索知识库" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="knowledge-search" />
        <span className="flex-1" />
        <Button onClick={() => setNoting(true)} data-testid="knowledge-note">新建笔记</Button>
        <label className="inline-flex min-h-8 cursor-pointer items-center rounded-pill border border-rule-2 bg-paper-2 px-3 text-sm font-medium text-ink focus-within:outline-2 focus-within:outline-accent">
          导入 md / txt
          <input type="file" accept=".md,.txt,text/markdown,text/plain" className="sr-only" onChange={onFile} data-testid="knowledge-file" />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {query.trim() ? (
          <Results projectId={projectId} query={query.trim()} />
        ) : sources.isLoading ? (
          <Loading />
        ) : sources.data?.length === 0 ? (
          <Empty title="知识库是空的">导入规范、资料或手写笔记。Agent 只按需检索命中的片段，结论必须带引用。</Empty>
        ) : (
          <ul className="divide-y divide-rule" data-testid="knowledge-sources">
            {sources.data?.map((s) => (
              <li key={s.id} className="flex items-center gap-3 py-2">
                <span className="min-w-0 flex-1 truncate text-sm text-ink-2">{s.name}</span>
                <Badge>{s.kind}</Badge>
                <span className="measured shrink-0 text-xs text-muted">{bytes(s.size)}</span>
                <span className="measured shrink-0 text-xs text-muted">{when(s.createdAt)}</span>
                <Button size="sm" variant="quiet" aria-label={`删除 ${s.name}`} disabled={remove.isPending} onClick={() => remove.mutate(s.id)}>删除</Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {noting && <NoteDialog projectId={projectId} onClose={() => setNoting(false)} />}
    </div>
  );
}

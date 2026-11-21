import { useMutation } from '@tanstack/react-query';
import { useState, type ChangeEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button, buttonClass } from '@/components/ui/button';
import { Dialog, DialogForm } from '@/components/ui/dialog';
import { Empty, ErrorState, Loading, toast } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/icons';
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
  if (!q.data?.length) return <Empty title="没有命中。" icon="search" />;
  return (
    <ul className="grid gap-2.5" data-testid="knowledge-results">
      {q.data.map((h) => (
        <li key={h.chunkId} className="grid gap-1.5 rounded-card bg-paper p-4 shadow-[var(--shadow-card)]">
          <p className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-muted"><Icon name="book" className="size-3.5 shrink-0" />{h.sourceName}{h.anchor.headingPath.length > 0 && ` › ${h.anchor.headingPath.join(' › ')}`}</p>
          <p className="line-clamp-4 whitespace-pre-wrap text-sm leading-relaxed text-ink-2">{h.text}</p>
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
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-rule px-5 py-2.5">
        <Input className="w-64 max-sm:w-full" placeholder="检索知识库" aria-label="检索知识库" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="knowledge-search" />
        <span className="flex-1" />
        <Button onClick={() => setNoting(true)} data-testid="knowledge-note"><Icon name="edit" />新建笔记</Button>
        <label className={buttonClass('default', 'default', 'cursor-pointer focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus')}>
          <Icon name="upload" />
          导入 md / txt
          <input type="file" accept=".md,.txt,text/markdown,text/plain" className="sr-only" onChange={onFile} data-testid="knowledge-file" />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {query.trim() ? (
          <Results projectId={projectId} query={query.trim()} />
        ) : sources.isLoading ? (
          <Loading />
        ) : sources.data?.length === 0 ? (
          <Empty title="知识库是空的" icon="book">导入规范、资料或手写笔记。Agent 只按需检索命中的片段，结论必须带引用。</Empty>
        ) : (
          <ul className="overflow-hidden rounded-card bg-paper shadow-[var(--shadow-card)]" data-testid="knowledge-sources">
            {sources.data?.map((s) => (
              <li key={s.id} className="flex items-center gap-3 border-b border-rule px-4 py-2.5 last:border-b-0 hover:bg-hover">
                <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-chip bg-paper-2 text-ink-2"><Icon name={s.kind === 'note' ? 'edit' : 'doc'} className="size-3.5" /></span>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{s.name}</span>
                <Badge tone="line" className="measured font-medium">{s.kind}</Badge>
                <span className="measured shrink-0 text-xs text-muted">{bytes(s.size)}</span>
                <span className="measured shrink-0 text-xs text-muted max-sm:hidden">{when(s.createdAt)}</span>
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

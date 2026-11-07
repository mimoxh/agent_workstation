import { Fragment, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Empty } from '@/components/ui/feedback';
import { Textarea } from '@/components/ui/input';
import { parseDiff, type DiffLine } from '@/lib/diff';
import { cn } from '@/lib/utils';

export interface LineComment {
  id?: string;
  path: string | null;
  line: number | null;
  body: string | null;
  resolved?: number;
}

const ROW: Record<DiffLine['kind'], string> = {
  add: 'bg-ok-soft',
  del: 'bg-bad-soft',
  ctx: '',
  hunk: 'text-cool',
};
const SIGN: Record<DiffLine['kind'], string> = { add: '+', del: '-', ctx: ' ', hunk: '' };

function Note({ c }: { c: LineComment }) {
  return (
    <div className={cn('border-l-2 bg-paper-2 px-3 py-1.5 font-sans text-sm text-ink-2 whitespace-pre-wrap', c.resolved ? 'border-ok text-muted' : 'border-cool')}>
      {c.body}
    </div>
  );
}

function CommentBox({ onSave, onCancel }: { onSave: (body: string) => void; onCancel: () => void }) {
  const [body, setBody] = useState('');
  return (
    <div className="space-y-2 border-l-2 border-accent bg-paper-2 p-2 font-sans">
      <Textarea autoFocus rows={2} placeholder="行内意见，随审阅一起提交" value={body} onChange={(e) => setBody(e.target.value)} data-testid="line-comment-input" />
      <div className="flex gap-2">
        <Button size="sm" variant="primary" disabled={!body.trim()} onClick={() => onSave(body.trim())}>添加意见</Button>
        <Button size="sm" variant="quiet" onClick={onCancel}>取消</Button>
      </div>
    </div>
  );
}

// 按文件分段的 diff；传 onComment 时点新版行号可写行内意见
export function DiffView({ patch, comments, onComment }: { patch: string; comments: LineComment[]; onComment?: ((path: string, line: number, body: string) => void) | undefined }) {
  const files = useMemo(() => parseDiff(patch), [patch]);
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ path: string; line: number } | null>(null);

  if (files.length === 0) return <Empty title="没有可展示的 diff" />;

  return (
    <div className="space-y-3" data-testid="diff-view">
      {files.map((f) => {
        const open = !folded.has(f.path);
        const loose = comments.filter((c) => c.path === f.path && c.line === null);
        return (
          <section key={f.path} className="overflow-hidden rounded-card border border-rule bg-paper-3">
            <button
              type="button"
              aria-expanded={open}
              onClick={() => {
                const next = new Set(folded);
                if (open) next.add(f.path);
                else next.delete(f.path);
                setFolded(next);
              }}
              className="flex w-full items-center gap-3 border-b border-rule bg-paper-2 px-3 py-2 text-left"
            >
              <span className="measured min-w-0 flex-1 truncate text-sm text-ink-2">{f.path}</span>
              <span className="measured text-xs text-ok">+{f.additions}</span>
              <span className="measured text-xs text-bad">-{f.deletions}</span>
            </button>
            {open && (
              <div className="overflow-x-auto">
                {loose.map((c, i) => <Note key={c.id ?? i} c={c} />)}
                <div className="measured min-w-max py-1 text-sm leading-6 text-ink-2">
                  {f.lines.map((l, i) => {
                    const notes = l.newLine === null ? [] : comments.filter((c) => c.path === f.path && c.line === l.newLine);
                    const here = editing?.path === f.path && editing.line === l.newLine;
                    return (
                      <Fragment key={i}>
                        <div className={cn('flex', ROW[l.kind])}>
                          <span className="w-11 shrink-0 select-none pr-2 text-right text-xs leading-6 text-muted">{l.oldLine ?? ''}</span>
                          {onComment && l.newLine !== null ? (
                            <button
                              type="button"
                              title="写行内意见"
                              data-testid="diff-line"
                              onClick={() => setEditing({ path: f.path, line: l.newLine! })}
                              className="w-11 shrink-0 select-none pr-2 text-right text-xs leading-6 text-muted hover:text-accent"
                            >
                              {l.newLine}
                            </button>
                          ) : (
                            <span className="w-11 shrink-0 select-none pr-2 text-right text-xs leading-6 text-muted">{l.newLine ?? ''}</span>
                          )}
                          <span className="w-4 shrink-0 select-none text-muted">{SIGN[l.kind]}</span>
                          <span className="whitespace-pre pr-4">{l.text}</span>
                        </div>
                        {notes.map((c, j) => <Note key={c.id ?? j} c={c} />)}
                        {here && onComment && (
                          <CommentBox
                            onCancel={() => setEditing(null)}
                            onSave={(body) => {
                              onComment(f.path, l.newLine!, body);
                              setEditing(null);
                            }}
                          />
                        )}
                      </Fragment>
                    );
                  })}
                </div>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

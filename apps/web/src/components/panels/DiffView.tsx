import { Fragment, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Empty } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/icons';
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
  add: 'bg-diff-add text-diff-add-ink',
  del: 'bg-diff-del text-diff-del-ink',
  ctx: '',
  hunk: 'bg-cool-soft text-cool',
};
const SIGN: Record<DiffLine['kind'], string> = { add: '+', del: '-', ctx: ' ', hunk: '' };

function Note({ c }: { c: LineComment }) {
  return (
    <div className={cn('border-l-2 bg-paper-2 px-3.5 py-2 font-sans text-sm leading-relaxed whitespace-pre-wrap', c.resolved ? 'border-ok text-muted' : 'border-cool text-ink-2')}>
      {c.body}
    </div>
  );
}

function CommentBox({ onSave, onCancel }: { onSave: (body: string) => void; onCancel: () => void }) {
  const [body, setBody] = useState('');
  return (
    <div className="grid gap-2 border-l-2 border-accent bg-paper-2 px-3 py-2.5 font-sans">
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

  if (files.length === 0) return <Empty title="没有可展示的 diff" icon="diff" />;

  return (
    <div className="space-y-3" data-testid="diff-view">
      {files.map((f) => {
        const open = !folded.has(f.path);
        const loose = comments.filter((c) => c.path === f.path && c.line === null);
        return (
          <section key={f.path} className="overflow-hidden rounded-ctl bg-paper shadow-[var(--shadow-card)]">
            <button
              type="button"
              aria-expanded={open}
              onClick={() => {
                const next = new Set(folded);
                if (open) next.add(f.path);
                else next.delete(f.path);
                setFolded(next);
              }}
              className={cn('flex w-full items-center gap-2 bg-paper-2 px-3 py-2 text-left font-mono text-xs font-medium text-ink hover:bg-paper-3', open && 'border-b border-rule')}
            >
              <Icon name="chev" className={cn('size-3 shrink-0 text-muted transition-transform duration-150', !open && '-rotate-90')} />
              <span className="min-w-0 flex-1 truncate">{f.path}</span>
              <span className="text-ok">+{f.additions}</span>
              <span className="text-bad">-{f.deletions}</span>
            </button>
            {open && (
              <div className="overflow-x-auto">
                {loose.map((c, i) => <Note key={c.id ?? i} c={c} />)}
                <div className="min-w-max font-mono text-xs leading-[1.7] text-ink-2">
                  {f.lines.map((l, i) => {
                    const notes = l.newLine === null ? [] : comments.filter((c) => c.path === f.path && c.line === l.newLine);
                    const here = editing?.path === f.path && editing.line === l.newLine;
                    return (
                      <Fragment key={i}>
                        <div className={cn('flex', ROW[l.kind])}>
                          <span className="w-11 shrink-0 select-none pr-2 text-right opacity-70">{l.oldLine ?? ''}</span>
                          {onComment && l.newLine !== null ? (
                            <button
                              type="button"
                              title="写行内意见"
                              data-testid="diff-line"
                              onClick={() => setEditing({ path: f.path, line: l.newLine! })}
                              className="w-11 shrink-0 select-none pr-2 text-right opacity-70 hover:bg-cool-soft hover:text-cool hover:opacity-100"
                            >
                              {l.newLine}
                            </button>
                          ) : (
                            <span className="w-11 shrink-0 select-none pr-2 text-right opacity-70">{l.newLine ?? ''}</span>
                          )}
                          <span className="w-4 shrink-0 select-none opacity-70">{SIGN[l.kind]}</span>
                          <span className="whitespace-pre pr-4 pl-0.5">{l.text}</span>
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

import type { DesignTweak } from '@aw/domain';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { DesignComment } from './model';

export function Segmented<T extends string>({ label, testId, value, options, onChange, disabled }: { label: string; testId?: string; value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div role="group" aria-label={label} className="flex rounded-pill bg-paper-3 p-0.5">
      {options.map((o) => (
        <button key={o.id} type="button" disabled={disabled} aria-pressed={value === o.id} onClick={() => onChange(o.id)} data-testid={`${testId ?? label}-${o.id}`} className={cn('h-6 rounded-chip px-2 text-xs transition-colors duration-150 disabled:opacity-50', value === o.id ? 'bg-paper font-medium text-ink shadow-[var(--shadow-card)]' : 'text-muted hover:text-ink')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export interface PendingComment { selector: string; anchor: string; tag: string }

function CommentRow({ c, n, active, missing, names, onFocus, onResolve }: { c: DesignComment; n: number; active: boolean; missing: boolean; names: Record<string, string>; onFocus: () => void; onResolve: () => void }) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  return (
    <li ref={ref} className={cn('rounded-pill border p-2', active ? 'border-accent bg-accent-soft' : 'border-rule')} data-testid="design-comment">
      <button type="button" onClick={onFocus} className="block w-full text-left">
        <span className="flex items-center gap-1.5 text-xs text-muted">
          <span className="grid size-4 shrink-0 place-items-center rounded-full bg-accent-tag text-[10px] font-semibold text-accent-tag-ink">{n}</span>
          <span className="truncate">{c.anchor || c.selector || '整页'}</span>
          {missing && <Badge tone="bad">元素已变化</Badge>}
        </span>
        <span className="mt-1 block whitespace-pre-wrap text-sm text-ink">{c.body}</span>
      </button>
      <div className="mt-1 flex items-center justify-between">
        <span className="text-xs text-faint">{c.authorType === 'human' ? '你' : (names[c.authorId ?? ''] ?? 'Agent')} · v{c.version ?? '?'}</span>
        <Button size="sm" variant="quiet" onClick={onResolve} data-testid="comment-resolve">解决</Button>
      </div>
    </li>
  );
}

export function CommentsPane({ open, resolved, active, missing, pending, names, canSend, sending, onFocus, onResolve, onCancelPending, onSubmit, onSend }: {
  open: DesignComment[]; resolved: DesignComment[]; active: number | null; missing: number[]; pending: PendingComment | null; names: Record<string, string>; canSend: boolean; sending: boolean;
  onFocus: (n: number) => void; onResolve: (c: DesignComment) => void; onCancelPending: () => void; onSubmit: (body: string) => void; onSend: () => void;
}) {
  const [body, setBody] = useState('');
  const submit = () => {
    if (!body.trim()) return;
    onSubmit(body.trim());
    setBody('');
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="comments-pane">
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {pending && (
          <form className="space-y-2 rounded-pill border border-cool bg-cool-soft p-2" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <p className="truncate text-xs text-muted">评论 &lt;{pending.tag}&gt; {pending.anchor}</p>
            <Textarea autoFocus rows={2} value={body} aria-label="评论内容" placeholder="这里要怎么改？" onChange={(e) => setBody(e.target.value)} data-testid="comment-input" onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
            <div className="flex justify-end gap-1">
              <Button size="sm" variant="quiet" onClick={onCancelPending}>取消</Button>
              <Button size="sm" variant="primary" type="submit" disabled={!body.trim()} data-testid="comment-save">保存</Button>
            </div>
          </form>
        )}
        {open.length === 0 && !pending && <p className="p-2 text-sm text-muted">切到「评论」模式，点画布上的元素留下意见，攒够了一起发给设计师。</p>}
        <ul className="space-y-2">
          {open.map((c, i) => <CommentRow key={c.id} c={c} n={i + 1} active={active === i + 1} missing={missing.includes(i + 1)} names={names} onFocus={() => onFocus(i + 1)} onResolve={() => onResolve(c)} />)}
        </ul>
        {resolved.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer px-1 text-xs text-muted">已解决 {resolved.length}</summary>
            <ul className="mt-1 space-y-1">
              {resolved.map((c) => (
                <li key={c.id} className="rounded-pill bg-paper-2 p-2 text-muted">
                  <p className="whitespace-pre-wrap">{c.body}</p>
                  {c.note && <p className="mt-1 text-xs text-ok">{c.note}</p>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <div className="shrink-0 border-t border-rule p-2.5">
        <Button variant="primary" className="w-full" disabled={!canSend || open.length === 0 || sending} onClick={onSend} data-testid="comments-send">
          把 {open.length} 条评论发给设计师
        </Button>
      </div>
    </div>
  );
}

function TweakControl({ t, value, onChange }: { t: DesignTweak; value: string; onChange: (v: string) => void }) {
  if (t.type === 'color') {
    const hex = /^#[0-9a-f]{6}$/i.test(value);
    return (
      <div className="flex items-center gap-2">
        {hex && <input type="color" aria-label={t.label} value={value} onChange={(e) => onChange(e.target.value)} className="size-8 shrink-0 cursor-pointer rounded-pill border border-rule-2 bg-paper p-0.5" />}
        <Input className="measured" aria-label={`${t.label} 色值`} value={value} onChange={(e) => onChange(e.target.value)} />
      </div>
    );
  }
  if (t.type === 'select') {
    return (
      <Select className="w-full" aria-label={t.label} value={value} onChange={(e) => onChange(e.target.value)}>
        {(t.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
      </Select>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <input type="range" aria-label={t.label} min={t.min ?? 0} max={t.max ?? 100} step={t.step ?? 1} value={value} onChange={(e) => onChange(e.target.value)} className="min-w-0 flex-1 accent-[var(--color-primary)]" data-testid={`tweak-${t.id}`} />
      <span className="measured w-14 shrink-0 text-right text-xs text-muted">{value}{t.unit}</span>
    </div>
  );
}

export function TweaksPane({ tweaks, draft, dirty, saving, disabled, onChange, onReset, onSave }: { tweaks: DesignTweak[]; draft: Record<string, string>; dirty: boolean; saving: boolean; disabled: boolean; onChange: (id: string, v: string) => void; onReset: () => void; onSave: () => void }) {
  if (tweaks.length === 0) return <p className="p-5 text-sm text-muted">这份稿子没有旋钮。可以跟设计师说「给配色和圆角加旋钮」。</p>;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="tweaks-pane">
      <fieldset disabled={disabled} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3 disabled:opacity-50">
        {tweaks.map((t) => (
          <div key={t.id}>
            <p className="mb-1 text-xs text-muted">{t.label}</p>
            <TweakControl t={t} value={draft[t.id] ?? t.value} onChange={(v) => onChange(t.id, v)} />
          </div>
        ))}
      </fieldset>
      <div className="flex shrink-0 justify-end gap-1 border-t border-rule p-2.5">
        <Button variant="quiet" disabled={!dirty} onClick={onReset}>还原</Button>
        <Button variant="primary" disabled={!dirty || saving} onClick={onSave} data-testid="tweaks-save">保存为新版本</Button>
      </div>
    </div>
  );
}

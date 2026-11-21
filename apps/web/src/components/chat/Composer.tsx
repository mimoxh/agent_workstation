import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button, Spinner } from '@/components/ui/button';
import { toast } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/icons';
import { Textarea } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { useThreadMembers } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { mentionQuery } from './mention';

// 会话输入：@ 候选来自线程的真实成员，服务端按同一份名单解析提及
export type MessageMeta = { design: { id: string; title: string; version: number }; elements?: { selector: string; anchor: string; tag: string; html: string }[] | undefined };

export function Composer({ threadId, hint, placeholder, actions, wide, meta, onSent }: { threadId: string; hint?: string | undefined; placeholder?: string | undefined; actions?: ReactNode; wide?: boolean | undefined; meta?: MessageMeta | undefined; onSent?: (() => void) | undefined }) {
  const members = useThreadMembers(threadId).data ?? [];
  const [input, setInput] = useState('');
  const [cursor, setCursor] = useState(0);
  const [active, setActive] = useState(0);
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const q = mentionQuery(input, cursor);
  const candidates = useMemo(
    () => (q === null ? [] : members.filter((m) => m.name.toLowerCase().includes(q.toLowerCase())).slice(0, 6)),
    [q, members],
  );

  const pick = (name: string) => {
    const head = input.slice(0, cursor).replace(/@[^\s@]*$/, `@${name} `);
    setInput(head + input.slice(cursor));
    setCursor(head.length);
    setActive(0);
    inputRef.current?.focus();
  };

  const send = async () => {
    const content = input.trim();
    if (!content || sending) return;
    setSending(true);
    try {
      await unwrap(await api.threads[':id'].messages.$post({ param: { id: threadId }, json: { content, ...(meta ? { meta } : {}) } }));
      setInput('');
      setCursor(0);
      onSent?.();
    } catch (e) {
      toast(e instanceof Error ? e.message : '发送失败');
    } finally {
      setSending(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (candidates.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : candidates.length - 1)) % candidates.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(candidates[Math.min(active, candidates.length - 1)]!.name);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className={cn('shrink-0', wide ? 'px-5 pb-4 pt-2.5 md:px-10 lg:px-14' : 'border-t border-rule px-3 pb-3 pt-2.5')}>
      <div className={cn('relative grid gap-1.5', wide && 'mx-auto max-w-[54rem]')}>
        {candidates.length > 0 && (
          <ul className="absolute bottom-[calc(100%-4px)] left-3 z-10 grid min-w-60 animate-rise rounded-pop bg-paper p-1.5 shadow-[var(--shadow-pop)]" role="listbox" aria-label="提及成员">
            {candidates.map((c, i) => (
              <li key={c.id} role="option" aria-selected={i === active}>
                <button
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); pick(c.name); }}
                  className={cn('flex min-h-[34px] w-full items-center gap-2.5 rounded-ctl px-2.5 text-left text-sm', i === active ? 'bg-hover text-ink' : 'text-ink-2 hover:bg-hover')}
                >
                  <span aria-hidden className="grid size-5 shrink-0 place-items-center rounded-full bg-tag text-[10px] font-semibold text-tag-ink">{c.name.slice(0, 1)}</span>
                  {c.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-end gap-1.5 rounded-[22px] border border-field-line bg-paper-2 py-1.5 pl-4 pr-1.5 transition-[border-color,background-color,box-shadow] duration-150 hover:border-muted focus-within:border-focus focus-within:bg-paper focus-within:shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-focus)_22%,transparent)]">
          <Textarea
            ref={inputRef}
            rows={1}
            className="my-1.5 max-h-40 min-h-6 flex-1 resize-none self-center border-0 bg-transparent p-0 leading-normal [field-sizing:content] hover:border-0 focus-visible:bg-transparent focus-visible:shadow-none"
            value={input}
            placeholder={placeholder ?? '消息，@ 提及成员，Shift+Enter 换行'}
            aria-label="发消息"
            data-testid="thread-input"
            onChange={(e) => { setInput(e.target.value); setCursor(e.target.selectionStart); setActive(0); }}
            onSelect={(e) => setCursor(e.currentTarget.selectionStart)}
            onKeyDown={onKey}
          />
          <Button variant="primary" disabled={sending || !input.trim()} aria-busy={sending || undefined} onClick={() => void send()} data-testid="thread-send">
            {sending ? <Spinner /> : <Icon name="send" />}发送
          </Button>
        </div>
        {(hint || actions) && (
          <div className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1 pl-4">
            <p className="min-w-0 flex-1 truncate text-xs text-muted">{hint}</p>
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}

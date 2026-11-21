import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { api, unwrap } from '@/lib/api';
import { cn } from '@/lib/utils';

type Msg =
  | { type: 'snapshot'; data: string; alive: boolean; exitCode: number | null }
  | { type: 'data'; data: string }
  | { type: 'exit'; code: number | null };

type State = { kind: 'connecting' } | { kind: 'live' } | { kind: 'ended'; code: number | null } | { kind: 'missing' };

// xterm 只吃具体色值：从设计令牌里取，深浅模式跟着页面走
function themeOf() {
  const css = getComputedStyle(document.documentElement);
  const v = (n: string) => css.getPropertyValue(n).trim();
  const theme = Object.fromEntries(
    Object.entries({ background: v('--color-code'), foreground: v('--color-code-ink'), cursor: v('--color-code-ink'), selectionBackground: v('--color-code-dim') }).filter(([, c]) => c),
  );
  return { fontFamily: v('--font-mono'), theme };
}

// 外部 harness 的真实终端：连 /api/terminals/:id/ws，会话还活着时人可以直接打字接管
export function TerminalView({ id, className }: { id: string; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<State>({ kind: 'connecting' });

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    setState({ kind: 'connecting' });
    const { fontFamily, theme } = themeOf();
    const term = new Terminal({ cursorBlink: true, fontSize: 12, lineHeight: 1.25, scrollback: 5000, theme, ...(fontFamily ? { fontFamily } : {}) });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    let alive = false;
    let disposed = false;
    let ws: WebSocket | null = null;
    const send = (m: object) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
    const resize = () => {
      if (disposed || el.clientWidth === 0 || el.clientHeight === 0) return;
      try { fit.fit(); } catch { return; }
      if (alive) send({ type: 'resize', cols: term.cols, rows: term.rows });
    };
    // 服务重启后内存里没有这个会话，退回到落盘的终端记录
    const replaySaved = async () => {
      try {
        const r = await unwrap(await api.terminals[':id'].$get({ param: { id } }));
        if (disposed) return;
        if (r.log) term.write(r.log);
        setState(r.log ? { kind: 'ended', code: r.info?.exitCode ?? null } : { kind: 'missing' });
      } catch {
        if (!disposed) setState({ kind: 'missing' });
      }
    };
    const onMessage = (ev: MessageEvent) => {
      let m: Msg;
      try { m = JSON.parse(String(ev.data)) as Msg; } catch { return; }
      if (m.type === 'snapshot') {
        term.reset();
        if (m.data) term.write(m.data);
        alive = m.alive;
        if (m.alive) {
          setState({ kind: 'live' });
          resize();
        } else if (m.data) setState({ kind: 'ended', code: m.exitCode });
        else void replaySaved();
      } else if (m.type === 'data') term.write(m.data);
      else {
        alive = false;
        setState({ kind: 'ended', code: m.code });
      }
    };
    const onClose = () => {
      if (disposed || !alive) return;
      alive = false;
      setState({ kind: 'ended', code: null });
    };
    // 推迟一拍再连：StrictMode 的挂载-卸载-挂载不会先建一条马上又断的连接
    const connect = setTimeout(() => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/terminals/${encodeURIComponent(id)}/ws`);
      ws.onmessage = onMessage;
      ws.onclose = onClose;
    });
    const input = term.onData((data) => { if (alive) send({ type: 'input', data }); });
    const ro = new ResizeObserver(() => resize());
    ro.observe(el);
    return () => {
      disposed = true;
      clearTimeout(connect);
      ro.disconnect();
      input.dispose();
      ws?.close();
      term.dispose();
    };
  }, [id]);

  return (
    <div className={cn('flex min-h-0 flex-col overflow-hidden rounded-card bg-code', className)} data-testid="terminal">
      <div className="flex items-center gap-2 px-3.5 pb-1 pt-2.5 text-xs text-code-dim">
        <span className="min-w-0 flex-1 truncate">{state.kind === 'live' ? '会话进行中，可以直接在终端里输入接管' : state.kind === 'connecting' ? '连接中…' : state.kind === 'missing' ? '没有这次运行的终端记录' : '会话已结束，只读回放'}</span>
        {state.kind === 'live' && <Badge tone="cool" data-testid="terminal-live"><span aria-hidden className="size-1.5 animate-pulse-soft rounded-full bg-current" />运行中</Badge>}
        {state.kind === 'ended' && <Badge tone={state.code === 0 ? 'ok' : 'neutral'} data-testid="terminal-ended">已结束{state.code !== null ? ` · 退出码 ${state.code}` : ''}</Badge>}
      </div>
      <div ref={host} className="min-h-0 flex-1 px-2 pb-2" data-testid="terminal-screen" />
    </div>
  );
}

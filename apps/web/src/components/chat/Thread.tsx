import { useEffect, useRef, useState } from 'react';
import { apiClient } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export interface Msg {
  id: string;
  senderType: string | null;
  senderId: string | null;
  kind: string | null;
  content: string | null;
  createdAt: string;
}

const KIND_STYLE: Record<string, string> = {
  chat: 'bg-white',
  status: 'bg-blue-50 text-blue-800 italic',
  handoff: 'bg-amber-50',
};

// 线程视图：SSE 实时更新 + 底部输入（人发送）
export function ThreadView({ threadId }: { threadId: string }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMessages([]);
    const es = new EventSource(`/api/threads/${threadId}/stream`);
    es.addEventListener('message', (ev) => {
      const m = JSON.parse((ev as MessageEvent).data) as Msg;
      setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
    });
    return () => es.close();
  }, [threadId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const send = async () => {
    if (!input.trim() || sending) return;
    setSending(true);
    try {
      await apiClient.threads[':id'].messages.$post({ param: { id: threadId }, json: { content: input.trim() } });
      setInput('');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-full flex-col" data-testid="thread-view">
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
        {messages.length === 0 && <div className="p-2 text-xs text-neutral-400">暂无消息</div>}
        {messages.map((m) => (
          <div key={m.id} className={cn('rounded border border-neutral-100 px-2 py-1 text-xs', KIND_STYLE[m.kind ?? 'chat'] ?? 'bg-white')}>
            <div className="text-[10px] text-neutral-400">
              {m.senderType}:{m.senderId === 'local' ? '本地用户' : (m.senderId ?? '').slice(0, 8)} · {m.createdAt.slice(11, 19)}
            </div>
            <div className="whitespace-pre-wrap">{m.content}</div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div className="flex gap-1 border-t border-neutral-200 p-2">
        <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="@Agent名称 或消息" className="h-7 text-xs"
          onKeyDown={(e) => { if (e.key === 'Enter') void send(); }} data-testid="thread-input" />
        <Button size="sm" className="shrink-0 whitespace-nowrap" disabled={sending || !input.trim()} onClick={() => void send()}>发送</Button>
      </div>
    </div>
  );
}

// 任务线程：懒获取 threadId 后渲染
export function TaskThread({ taskId }: { taskId: string }) {
  const [threadId, setThreadId] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      const res = await apiClient.tasks[':id'].thread.$get({ param: { id: taskId } });
      if (res.ok) {
        const d = (await res.json()) as { thread: { id: string } };
        setThreadId(d.thread.id);
      }
    })();
  }, [taskId]);
  return threadId ? <ThreadView threadId={threadId} /> : <div className="p-2 text-xs text-neutral-400">加载会话…</div>;
}

export function WsThread({ wsId }: { wsId: string }) {
  const [threadId, setThreadId] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      const res = await apiClient.workstations[':id'].thread.$get({ param: { id: wsId } });
      if (res.ok) {
        const d = (await res.json()) as { thread: { id: string } };
        setThreadId(d.thread.id);
      }
    })();
  }, [wsId]);
  return threadId ? <ThreadView threadId={threadId} /> : <div className="p-2 text-xs text-neutral-400">加载会话…</div>;
}

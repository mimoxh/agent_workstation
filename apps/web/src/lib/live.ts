import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';

// 按顺序取第一个匹配：run_step 很频繁，只刷新脉搏和时间线
const RULES: [prefix: string, keys: string[]][] = [
  ['doc_', ['docs', 'doc', 'doc-gate', 'doc-health', 'doc-settings', 'style-guide', 'entities', 'entity-versions', 'timeline', 'thread-messages', 'inbox']],
  ['qa_', ['qa', 'task-quality', 'project-status', 'entities']],
  ['task_', ['tasks', 'task', 'project-tasks', 'project-status', 'overview', 'projects', 'inbox', 'proposals', 'timeline', 'pulse', 'task-branch', 'task-quality', 'files', 'file', 'qa']],
  ['proposal_', ['proposals', 'task', 'overview', 'inbox', 'timeline', 'task-branch', 'remote', 'files', 'file', 'folder']],
  ['inbox_', ['inbox', 'overview', 'projects']],
  ['message_', ['timeline', 'thread-messages', 'conversations']],
  ['thread_', ['thread', 'thread-messages', 'conversations']],
  ['run_step', ['pulse', 'timeline']],
  ['run_', ['runs', 'run', 'agent-status', 'overview', 'task', 'testruns', 'pulse', 'timeline', 'ledger', 'thread-active']],
  ['entity_', ['entities', 'entity-versions', 'testruns', 'timeline', 'knowledge', 'qa', 'project-status', 'docs', 'doc', 'doc-gate', 'doc-health', 'doc-settings', 'style-guide']],
  ['agent_', ['ws', 'project', 'agent-status', 'pulse']],
  ['workstation_', ['ws', 'project', 'overview', 'projects', 'repo', 'files', 'remote', 'tasks']],
  ['project_', ['projects', 'project', 'overview', 'ledger', 'plugins', 'folder']],
];

export const keysFor = (action: string) => RULES.find(([p]) => action.startsWith(p))?.[1] ?? [];

let connected = false;
const listeners = new Set<() => void>();
const setConnected = (v: boolean) => {
  if (connected === v) return;
  connected = v;
  for (const l of listeners) l();
};

export const useLiveConnected = () =>
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => connected,
  );

// 服务端推动作名，这里合并 200ms 内的变更后失效对应缓存，取代各处轮询
export function useLiveSync() {
  const qc = useQueryClient();
  useEffect(() => {
    const es = new EventSource('/api/stream');
    const pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      for (const key of pending) void qc.invalidateQueries({ queryKey: [key] });
      pending.clear();
    };
    es.addEventListener('ready', () => {
      // 断线期间可能错过变更，重连后全部刷新一次
      if (!connected) void qc.invalidateQueries();
      setConnected(true);
    });
    es.addEventListener('change', (ev) => {
      const { action } = JSON.parse((ev as MessageEvent<string>).data) as { action: string };
      for (const k of keysFor(action)) pending.add(k);
      timer ??= setTimeout(flush, 200);
    });
    es.onerror = () => setConnected(false);
    return () => {
      es.close();
      if (timer) clearTimeout(timer);
      setConnected(false);
    };
  }, [qc]);
}

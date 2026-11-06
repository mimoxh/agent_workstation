import { sanitizeError } from './runtime/models.js';

type Handler = (payload: Record<string, unknown>) => void | Promise<void>;

const handlers = new Map<string, Set<Handler>>();

const report = (action: string, e: unknown) => console.error(`[events] ${action} 处理器异常`, sanitizeError(String(e)));

// 进程内类型化事件总线；阶段 2 的运行时订阅 task_assigned 等
// 处理器互相隔离：同步抛错和异步 rejection 都就地记录，不影响发布方和其他处理器
export const events = {
  emit(action: string, payload: Record<string, unknown>) {
    for (const h of handlers.get(action) ?? []) {
      try {
        Promise.resolve(h(payload)).catch((e: unknown) => report(action, e));
      } catch (e) {
        report(action, e);
      }
    }
  },
  on(action: string, handler: Handler) {
    if (!handlers.has(action)) handlers.set(action, new Set());
    handlers.get(action)!.add(handler);
    return () => events.off(action, handler);
  },
  off(action: string, handler: Handler) {
    handlers.get(action)?.delete(handler);
  },
  listenerCount(action: string) {
    return handlers.get(action)?.size ?? 0;
  },
};

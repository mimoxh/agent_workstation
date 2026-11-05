type Handler = (payload: Record<string, unknown>) => void;

const handlers = new Map<string, Set<Handler>>();

// 进程内类型化事件总线；阶段 2 的运行时订阅 task_assigned 等
export const events = {
  emit(action: string, payload: Record<string, unknown>) {
    for (const h of handlers.get(action) ?? []) h(payload);
  },
  on(action: string, handler: Handler) {
    if (!handlers.has(action)) handlers.set(action, new Set());
    handlers.get(action)!.add(handler);
  },
};

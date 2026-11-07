import type { AppType } from '@aw/server/app';
import { hc } from 'hono/client';

// 类型化 API 客户端（Hono RPC）；/api 由 vite 代理到 8787
export const client = hc<AppType>('/');
export const api = client.api;

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

// 响应按状态码是联合类型，这里逐个分支取 body，再去掉错误分支
type BodyOf<R> = R extends { json(): Promise<infer T> } ? T : never;
type Success<R> = Exclude<BodyOf<R>, { error: string }>;

// 成功返回 body，失败抛出带服务端文案的 ApiError
export async function unwrap<R extends { ok: boolean; status: number; json(): Promise<unknown> }>(res: R): Promise<Success<R>> {
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const error = (data as { error?: unknown } | null)?.error;
    throw new ApiError(typeof error === 'string' ? error : `请求失败（${res.status}）`, res.status);
  }
  return data as Success<R>;
}

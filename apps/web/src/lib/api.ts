import type { AppType } from '@aw/server/app';
import { hc } from 'hono/client';

// 类型化 API 客户端（Hono RPC）；/api 由 vite 代理到 8787
export const client = hc<AppType>('/');
export const apiClient = client.api;

import { serve } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { createDb, migrateDb } from './db/client.js';
import { seed } from './db/seed.js';
import { inboxItem, run } from './db/schema.js';
import { createApp } from './app.js';
import { loadPlugins } from './plugins.js';
import { loadModels, sanitizeError } from './runtime/models.js';
import { startScheduler } from './runtime/scheduler.js';

// 最后一道兜底：单个任务的漏网异常不能带走常驻进程和其他 run
process.on('unhandledRejection', (e) => {
  console.error('[unhandledRejection]', sanitizeError(e instanceof Error ? (e.stack ?? e.message) : String(e)));
});

loadPlugins(); // 校验失败直接抛错退出
await loadModels();

const { db, sqlite } = createDb();
migrateDb(sqlite);
await seed(db);

// 启动恢复：running 的 run 标 interrupted 并进收件箱（M0 宁可多报）
const stale = await db.select().from(run).where(eq(run.status, 'running'));
for (const r of stale) {
  await db.update(run).set({ status: 'interrupted', stopReason: 'interrupted', endedAt: new Date().toISOString() }).where(eq(run.id, r.id));
  await db.insert(inboxItem).values({
    id: crypto.randomUUID(), workspaceId: 'default', projectId: null, kind: 'run_failed', refType: 'run', refId: r.id, status: 'open', createdAt: new Date().toISOString(),
  });
}

startScheduler(db);

const { app } = createApp(db);
const port = Number(process.env.AW_PORT ?? 8787);
const hostname = process.env.AW_HOST ?? '127.0.0.1';
serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`server listening on http://${info.address}:${info.port}`);
});

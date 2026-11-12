import { serve } from '@hono/node-server';
import { and, eq } from 'drizzle-orm';
import { createDb, migrateDb } from './db/client.js';
import { seed } from './db/seed.js';
import { agent, inboxItem, run, task, workstation } from './db/schema.js';
import { createApp } from './app.js';
import { loadPlugins } from './plugins.js';
import { loadModels, sanitizeError } from './runtime/models.js';
import { startScheduler } from './runtime/scheduler.js';
import { startRepoWatch } from './runtime/repo_watch.js';
import { startQaSchedule } from './runtime/qa/schedule.js';
import { recoverMergeQueue } from './runtime/dev_workflow.js';
import { recoverQaRuns } from './usecases/qa.js';
import { syncWorkstations } from './usecases/workstations.js';

// 最后一道兜底：单个任务的漏网异常不能带走常驻进程和其他 run
process.on('unhandledRejection', (e) => {
  console.error('[unhandledRejection]', sanitizeError(e instanceof Error ? (e.stack ?? e.message) : String(e)));
});

loadPlugins(); // 校验失败直接抛错退出
await loadModels();

const { db, sqlite } = createDb();
migrateDb(sqlite);
await seed(db);
await syncWorkstations(db);

// 启动恢复：running 的 run 标 interrupted 并进收件箱（M0 宁可多报）
const stale = await db.select().from(run).where(eq(run.status, 'running'));
for (const r of stale) {
  await db.update(run).set({ status: 'interrupted', stopReason: 'interrupted', endedAt: new Date().toISOString() }).where(eq(run.id, r.id));
  const owner = r.taskId ? (await db.select().from(task).where(eq(task.id, r.taskId)))[0] : undefined;
  const a = r.agentId ? (await db.select().from(agent).where(eq(agent.id, r.agentId)))[0] : undefined;
  const ws = a ? (await db.select().from(workstation).where(eq(workstation.id, a.workstationId)))[0] : undefined;
  await db.insert(inboxItem).values({
    id: crypto.randomUUID(), workspaceId: 'default', projectId: owner?.projectId ?? ws?.projectId ?? null, kind: 'run_failed', refType: 'run', refId: r.id, status: 'open', createdAt: new Date().toISOString(),
  });
}

// 等待命令确认的 run 已经不在了，确认项留着只会误导
await db.update(inboxItem).set({ status: 'resolved', resolutionJson: JSON.stringify({ resolution: 'interrupted' }) }).where(and(eq(inboxItem.kind, 'command_confirm'), eq(inboxItem.status, 'open')));
await recoverMergeQueue(db);
await recoverQaRuns(db);

startScheduler(db);
startRepoWatch(db);
startQaSchedule(db);

const { app } = createApp(db);
const port = Number(process.env.AW_PORT ?? 8787);
const hostname = process.env.AW_HOST ?? '127.0.0.1';
serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`server listening on http://${info.address}:${info.port}`);
});

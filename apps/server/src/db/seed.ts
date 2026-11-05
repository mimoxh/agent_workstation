import type { DB } from './client.js';
import { appUser, project, task, workspace, workstation } from './schema.js';
import { eq } from 'drizzle-orm';
import { createDb, migrateDb } from './client.js';

const now = () => new Date().toISOString();

// 幂等：全部使用固定 id，重复执行不产生重复数据。
export async function seed(db: DB) {
  const w = await db.select().from(workspace).where(eq(workspace.id, 'default'));
  if (w.length === 0) {
    await db.insert(workspace).values({ id: 'default', name: '默认工作区', createdAt: now() });
  }

  const u = await db.select().from(appUser).where(eq(appUser.id, 'local'));
  if (u.length === 0) {
    await db
      .insert(appUser)
      .values({ id: 'local', workspaceId: 'default', name: '本地用户', createdAt: now() });
  }

  const p = await db.select().from(project).where(eq(project.id, 'proj-aw'));
  if (p.length === 0) {
    await db.insert(project).values({
      id: 'proj-aw',
      workspaceId: 'default',
      name: 'Agent Workstation',
      goal: '用工作台开发工作台本身',
      status: 'active',
      createdAt: now(),
    });
  }

  const root = await db.select().from(workstation).where(eq(workstation.id, 'ws-root'));
  if (root.length === 0) {
    await db.insert(workstation).values({
      id: 'ws-root',
      projectId: 'proj-aw',
      parentId: null,
      pluginId: 'pm',
      pluginVersion: '1.0.0',
      name: '根',
      status: 'active',
      sort: 0,
      createdAt: now(),
    });
  }

  const dev = await db.select().from(workstation).where(eq(workstation.id, 'ws-dev'));
  if (dev.length === 0) {
    await db.insert(workstation).values({
      id: 'ws-dev',
      projectId: 'proj-aw',
      parentId: 'ws-root',
      pluginId: 'dev',
      pluginVersion: '1.0.0',
      name: '开发',
      status: 'active',
      sort: 1,
      createdAt: now(),
    });
  }

  const tasks: Array<{ id: string; title: string; status: string; module: string }> = [
    { id: 'task-1', title: '梳理看板列与状态映射', status: 'draft', module: 'apps/web/src/components/board/' },
    { id: 'task-2', title: '补齐任务转移的错误提示', status: 'dispatched', module: 'apps/web/src/components/board/' },
    { id: 'task-3', title: '实现板块区的加载态', status: 'in_progress', module: 'apps/web/src/components/board/' },
    { id: 'task-4', title: '看板卡片徽标样式统一', status: 'reviewing', module: 'apps/web/src/components/board/' },
    { id: 'task-5', title: '任务详情页占位路由', status: 'done', module: 'apps/web/src/routes/' },
    { id: 'task-6', title: '会话区接通消息流', status: 'blocked', module: 'apps/web/src/components/chat/' },
  ];
  for (const t of tasks) {
    const existing = await db.select().from(task).where(eq(task.id, t.id));
    if (existing.length === 0) {
      await db.insert(task).values({
        id: t.id,
        projectId: 'proj-aw',
        workstationId: 'ws-dev',
        typeId: 'dev.issue',
        title: t.title,
        status: t.status,
        inputJson: JSON.stringify({ module: t.module }),
        createdAt: now(),
      });
    }
  }
}

// 直接执行（pnpm db:seed）：先建表再播种
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/').split('/').pop() ?? '')) {
  const { db, sqlite } = createDb();
  migrateDb(sqlite);
  await seed(db);
  console.log('seed 完成');
}

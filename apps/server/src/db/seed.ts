import type { DB } from './client.js';
import { appUser, pluginInstall, project, workspace } from './schema.js';
import { eq } from 'drizzle-orm';
import { createDb, migrateDb } from './client.js';
import { execSync } from 'node:child_process';
import { loadPlugins, pluginRegistry } from '../plugins.js';
import { addAgentInstance, mountWorkstation } from '../usecases/index.js';
import type { Actor } from '@aw/domain';

const now = () => new Date().toISOString();
const HUMAN: Actor = { type: 'human', id: 'local' };

export async function seed(db: DB) {
  const w = await db.select().from(workspace).where(eq(workspace.id, 'default'));
  if (w.length > 0) return; // 已播种，幂等退出

  await db.insert(workspace).values({ id: 'default', name: '默认工作区', createdAt: now() });
  await db.insert(appUser).values({ id: 'local', workspaceId: 'default', name: '本地用户', createdAt: now() });
  await db.insert(project).values({
    id: 'proj-aw',
    workspaceId: 'default',
    name: 'Agent Workstation',
    goal: '用工作台开发工作台本身',
    status: 'active',
    createdAt: now(),
  });

  // builtin 插件登记
  for (const m of pluginRegistry.values()) {
    await db.insert(pluginInstall).values({
      id: crypto.randomUUID(),
      workspaceId: 'default',
      pluginId: m.id,
      version: m.version,
      source: 'builtin',
      enabled: 1,
      createdAt: now(),
    });
  }

  const root = await mountWorkstation(HUMAN, db, {
    projectId: 'proj-aw',
    parentId: null,
    pluginId: 'pm',
    name: '根',
  });
  if (root.kind !== 'ok') throw new Error('mount pm 失败');

  let repoPath = '.';
  try {
    repoPath = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
  } catch {
    /* 非 git 环境用占位 */
  }
  const dev = await mountWorkstation(HUMAN, db, {
    projectId: 'proj-aw',
    parentId: root.id,
    pluginId: 'dev',
    name: '开发',
    settings: {
      repoPath,
      targetBranch: 'develop',
      commands: { build: 'pnpm build', test: 'pnpm test', lint: 'pnpm lint' },
    },
  });
  if (dev.kind !== 'ok') throw new Error('mount dev 失败');
  // 剧本 A：第二个 frontend-dev 实例
  await addAgentInstance(HUMAN, db, dev.id, 'frontend-dev');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/').split('/').pop() ?? '')) {
  loadPlugins();
  const { db, sqlite } = createDb();
  migrateDb(sqlite);
  await seed(db);
  console.log('seed 完成');
}

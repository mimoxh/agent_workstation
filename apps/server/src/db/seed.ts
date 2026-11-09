import type { DB } from './client.js';
import { appUser, pluginInstall, project, workspace } from './schema.js';
import { eq } from 'drizzle-orm';
import { createDb, migrateDb } from './client.js';
import { execSync } from 'node:child_process';
import { loadPlugins, pluginRegistry } from '../plugins.js';
import { addAgentInstance, mountWorkstation } from '../usecases/workstations.js';
import type { Actor } from '@aw/domain';

const now = () => new Date().toISOString();
const HUMAN: Actor = { type: 'human', id: 'local' };

// 老库也要补登记：后来新增的内置插件没有这一行，启停开关会更新不到
async function registerPlugins(db: DB) {
  const known = new Set((await db.select({ pluginId: pluginInstall.pluginId }).from(pluginInstall)).map((p) => p.pluginId));
  for (const m of pluginRegistry.values()) {
    if (known.has(m.id)) continue;
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
}

export async function seed(db: DB) {
  const w = await db.select().from(workspace).where(eq(workspace.id, 'default'));
  if (w.length > 0) {
    await registerPlugins(db);
    return; // 已播种，幂等退出
  }

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

  await registerPlugins(db);

  const root = await mountWorkstation(HUMAN, db, {
    projectId: 'proj-aw',
    parentId: null,
    pluginId: 'pm',
    name: '根',
  });
  if (root.kind !== 'ok') throw new Error('mount pm 失败');

  let repoPath = '.';
  try {
    repoPath = process.env.AW_SEED_REPO_PATH ?? execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
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
      commands: repoPath === process.env.AW_SEED_REPO_PATH ? { build: 'pnpm build', test: 'pnpm test', lint: 'pnpm lint' } : { build: 'pnpm build', test: 'pnpm test', lint: 'pnpm lint', setup: 'pnpm install --frozen-lockfile --prefer-offline' },
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

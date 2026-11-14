import { and, eq, ne } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { workstation } from '../db/schema.js';
import { devSettings } from '../runtime/git.js';
import { qaSourceOf, type QaSource } from './qa.js';

// 只读访问本项目的开发台仓库。repo 指定时必须指向同项目里绑了仓库的开发台；
// 缺省时开发台用自己的仓库，其他台用 settings.sourceWorkstationId 或第一个开发台
export async function repoSourceOf(db: DB, wsId: string, repo?: string): Promise<QaSource> {
  if (repo === undefined) return qaSourceOf(db, wsId);
  const ws = (await db.select().from(workstation).where(eq(workstation.id, wsId)))[0];
  if (!ws) return { ok: false, error: '工作台不存在' };
  const target = (await db.select().from(workstation).where(eq(workstation.id, repo)))[0];
  if (!target || target.projectId !== ws.projectId || target.pluginId !== 'dev' || target.status === 'archived') return { ok: false, error: '目标仓库不是同项目的开发工作台' };
  const settings = devSettings(target.settingsJson);
  if (!settings.repoPath || settings.repoPath === '.') return { ok: false, error: `开发台「${target.name}」还没有绑定仓库` };
  return { ok: true, workstationId: target.id, name: target.name, settings };
}

// 本项目全部开发台的仓库绑定情况：list_repos 工具和目标仓库下拉共用
export async function listRepoSources(db: DB, wsId: string) {
  const ws = (await db.select().from(workstation).where(eq(workstation.id, wsId)))[0];
  if (!ws) return [];
  const devs = await db.select().from(workstation).where(and(eq(workstation.projectId, ws.projectId), eq(workstation.pluginId, 'dev'), ne(workstation.status, 'archived')));
  return devs.map((d) => {
    const s = devSettings(d.settingsJson);
    const bound = !!s.repoPath && s.repoPath !== '.';
    return { repo: d.id, name: d.name, targetBranch: bound ? s.targetBranch : null, bound };
  });
}

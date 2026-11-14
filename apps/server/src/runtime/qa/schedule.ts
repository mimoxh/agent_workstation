import { scheduleDue } from '@aw/domain';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import type { DB } from '../../db/client.js';
import { project, qaRun, workstation } from '../../db/schema.js';
import { entitiesOf, startRun, type SuiteData } from '../../usecases/qa.js';

const PLATFORM = { type: 'human', id: 'local' } as const;
const INTERVAL_MS = 60_000;

// 定时套件巡检：套件已有排队/运行中的就跳过；出错只记警告，下次 tick 再试
export async function tickQaSchedule(db: DB, now = new Date()) {
  const archived = new Set((await db.select({ id: project.id }).from(project).where(eq(project.status, 'archived'))).map((p) => p.id));
  for (const ws of await db.select().from(workstation).where(and(eq(workstation.pluginId, 'dev'), ne(workstation.status, 'archived')))) {
    if (archived.has(ws.projectId)) continue;
    const suites = (await entitiesOf<SuiteData>(db, ws.id, 'TestSuite')).filter((s) => s.data.schedule && s.data.schedule !== 'off');
    for (const s of suites) {
      const busy = await db.select({ id: qaRun.id }).from(qaRun).where(and(eq(qaRun.workstationId, ws.id), eq(qaRun.suiteId, s.row.id), inArray(qaRun.status, ['queued', 'running']))).limit(1);
      if (busy.length) continue;
      const last = (await db.select({ createdAt: qaRun.createdAt }).from(qaRun).where(and(eq(qaRun.workstationId, ws.id), eq(qaRun.suiteId, s.row.id), eq(qaRun.trigger, 'schedule'))).orderBy(desc(qaRun.createdAt)).limit(1))[0];
      if (!scheduleDue(s.data.schedule, s.data.schedule_at, last?.createdAt ?? null, now)) continue;
      try {
        const r = await startRun(PLATFORM, db, ws.id, { suiteId: s.row.id, trigger: 'schedule' });
        if (r.kind !== 'ok') console.warn('[qa-schedule]', ws.id, s.data.name, r.error);
      } catch (e) {
        console.warn('[qa-schedule]', ws.id, s.data.name, String(e));
      }
    }
  }
}

export function startQaSchedule(db: DB) {
  const t = setInterval(() => void tickQaSchedule(db).catch((e: unknown) => console.warn('[qa-schedule]', String(e))), INTERVAL_MS);
  t.unref?.();
  return t;
}

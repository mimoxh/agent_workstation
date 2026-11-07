import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { createDb, migrateDb, type DB } from '../src/db/client.js';
import { seed } from '../src/db/seed.js';
import { agent, run, task, workstation } from '../src/db/schema.js';
import { events } from '../src/events.js';
import { loadPlugins } from '../src/plugins.js';
import { sendBack } from '../src/runtime/dev_workflow.js';
import { zodToJson } from '../src/runtime/loop.js';
import { loadModels } from '../src/runtime/models.js';
import { scheduler, startScheduler } from '../src/runtime/scheduler.js';
import { allTools } from '../src/runtime/tools/index.js';

const HUMAN = { type: 'human', id: 'local' } as const;
const now = () => new Date().toISOString();

describe('工具 schema', () => {
  it('每个工具都把参数定义完整交给模型', () => {
    for (const [name, def] of Object.entries(allTools())) {
      const json = zodToJson(def.parameters) as { type?: string; properties?: Record<string, unknown> };
      const shape = (def.parameters as z.ZodObject).shape;
      expect(json.type, name).toBe('object');
      expect(Object.keys(json.properties ?? {}).sort(), name).toEqual(Object.keys(shape).sort());
    }
  });

  it('可选参数不进 required，必填参数进 required', () => {
    const json = zodToJson(allTools().create_task!.parameters) as { required?: string[] };
    expect(json.required).toContain('title');
    expect(json.required).not.toContain('intent');
  });
});

describe('阶段激活', () => {
  let db: DB;
  let dev: typeof workstation.$inferSelect;

  beforeEach(async () => {
    loadPlugins();
    const r = createDb(':memory:');
    db = r.db;
    migrateDb(r.sqlite);
    await seed(db);
    dev = (await db.select().from(workstation).where(eq(workstation.pluginId, 'dev')))[0]!;
    await loadModels();
  });

  it('退回到实现阶段只由 assignee 继续，不牵动其他实现者', async () => {
    const off = startScheduler(db);
    const fe = (await db.select().from(agent).where(and(eq(agent.workstationId, dev.id), eq(agent.templateId, 'frontend-dev'))))[0]!;
    const be = (await db.select().from(agent).where(and(eq(agent.workstationId, dev.id), eq(agent.templateId, 'backend-dev'))))[0]!;
    const id = crypto.randomUUID();
    await db.insert(task).values({ id, projectId: 'proj-aw', workstationId: dev.id, title: 'T', inputJson: '{}', status: 'reviewing', stage: 'review', assigneeType: 'agent', assigneeId: fe.id, createdAt: now() });

    await sendBack(db, { actor: HUMAN }, id, '要求修改');
    await new Promise((r) => setTimeout(r, 50));
    await scheduler.idle();
    off();

    const runs = await db.select().from(run).where(eq(run.taskId, id));
    expect(runs.filter((r) => r.agentId === be.id)).toHaveLength(0);
    expect(runs.filter((r) => r.agentId === fe.id)).toHaveLength(1);
  });

  it('阶段变更只广播一次', async () => {
    const id = crypto.randomUUID();
    await db.insert(task).values({ id, projectId: 'proj-aw', workstationId: dev.id, title: 'T', inputJson: '{}', status: 'reviewing', stage: 'review', createdAt: now() });
    let seen = 0;
    const off = events.on('task_stage_changed', (p) => { if (p.targetId === id) seen += 1; });
    await sendBack(db, { actor: HUMAN }, id, '要求修改');
    off();
    expect(seen).toBe(1);
  });
});

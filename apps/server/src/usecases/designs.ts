import { applyTextEdits, composeDesignDoc, lintDesign, type DesignToken, type DesignTweak } from '@aw/domain';
import type { Actor } from '@aw/domain';
import { and, eq, inArray } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { agent, artifact, entity, entityVersion, task, workstation } from '../db/schema.js';
import { logEvent } from './core.js';
import { createEntity, updateEntity } from './entities.js';
import { createTaskUc } from './tasks.js';
import { postThreadMessage, wsThreadOf } from './threads.js';

const now = () => new Date().toISOString();

export interface DesignData {
  title: string;
  html: string;
  brief?: string | undefined;
  group?: string | undefined;
  direction?: string | undefined;
  tweaks?: DesignTweak[] | undefined;
  status?: 'draft' | 'approved' | 'handed_off' | undefined;
  handoff?: { taskId: string; artifactId: string; version: number; workstationId: string } | undefined;
  // 设计系统下线时冻结进稿子的 :root 令牌；新稿子没有这个键
  legacyTokens?: DesignToken[] | undefined;
}

export interface CommentData { design: string; version?: number | undefined; selector?: string | undefined; anchor?: string | undefined; body: string; status?: 'open' | 'resolved' | undefined; note?: string | undefined }

type EntityRow = typeof entity.$inferSelect;

const dataOf = <T,>(e: EntityRow) => JSON.parse(e.dataJson ?? '{}') as T;

const ofType = (db: DB, wsId: string, type: string) => db.select().from(entity).where(and(eq(entity.workstationId, wsId), eq(entity.entityType, type)));

export const designRow = async (db: DB, id: string) => {
  const e = (await db.select().from(entity).where(eq(entity.id, id)))[0];
  return e?.entityType === 'Design' ? e : undefined;
};

export async function listDesignComments(db: DB, wsId: string, designId?: string) {
  const rows = await ofType(db, wsId, 'DesignComment');
  return rows.map((e) => ({ id: e.id, ...dataOf<CommentData>(e), createdAt: e.createdAt })).filter((c) => !designId || c.design === designId);
}

export async function listDesigns(db: DB, wsId: string) {
  const [rows, comments] = await Promise.all([ofType(db, wsId, 'Design'), listDesignComments(db, wsId)]);
  return rows.map((e) => {
    const d = dataOf<DesignData>(e);
    return { id: e.id, title: d.title, version: e.version, group: d.group ?? null, direction: d.direction ?? null, status: d.status ?? 'draft', size: d.html.length, openComments: comments.filter((c) => c.design === e.id && c.status !== 'resolved').length };
  });
}

// 拼给 Agent 的上下文：只有清单，正文要用时再读
export async function designContextOf(db: DB, wsId: string) {
  const list = await listDesigns(db, wsId);
  if (list.length === 0) return '本台还没有设计稿';
  return list.map((d) => `- ${d.title}（id: ${d.id}）v${d.version}${d.group ? ` 方案组 ${d.group}` : ''}${d.direction ? ` · ${d.direction}` : ''}${d.openComments ? ` · ${d.openComments} 条未解决评论` : ''}`).join('\n');
}

export async function saveDesign(actor: Actor, db: DB, wsId: string, input: Partial<DesignData> & { id?: string | undefined; reason?: string | undefined }) {
  const warningsFor = (d: DesignData) => lintDesign(d.html, { tokens: d.legacyTokens ?? [], tweaks: d.tweaks ?? [] });
  const { id, reason, ...patch } = input;
  const fields = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<DesignData>;
  if (!id) {
    const data: DesignData = { title: '', html: '', status: 'draft', ...fields };
    const r = await createEntity(actor, db, wsId, { entityType: 'Design', data: data as unknown as Record<string, unknown>, reason: reason ?? '初稿' });
    return r.kind === 'ok' ? { kind: 'ok' as const, id: r.id, version: 1, warnings: warningsFor(data) } : r;
  }
  const row = await designRow(db, id);
  if (!row || row.workstationId !== wsId) return { kind: 'not_found' as const, status: 404 as const, error: '设计稿不存在' };
  const data: DesignData = { ...dataOf<DesignData>(row), ...fields };
  // 定稿之后再改，稿子就回到草稿，交接记录仍然保留
  if (fields.html !== undefined && fields.status === undefined) data.status = 'draft';
  const r = await updateEntity(actor, db, id, { data: data as unknown as Record<string, unknown>, baseVersion: row.version, reason });
  return r.kind === 'ok' ? { kind: 'ok' as const, id, version: r.version, warnings: warningsFor(data) } : r;
}

export async function editDesign(actor: Actor, db: DB, wsId: string, id: string, input: { edits: { oldText: string; newText: string }[]; tweaks?: DesignTweak[] | undefined; reason?: string | undefined }) {
  const row = await designRow(db, id);
  if (!row || row.workstationId !== wsId) return { kind: 'not_found' as const, status: 404 as const, error: '设计稿不存在' };
  const r = applyTextEdits(dataOf<DesignData>(row).html, input.edits);
  if (!r.ok) return { kind: 'error' as const, status: 400 as const, error: r.error };
  return saveDesign(actor, db, wsId, { id, html: r.html, tweaks: input.tweaks, reason: input.reason });
}

export async function resolveDesignComments(actor: Actor, db: DB, wsId: string, ids: string[], note?: string) {
  let resolved = 0;
  for (const id of ids) {
    const row = (await db.select().from(entity).where(eq(entity.id, id)))[0];
    if (row?.entityType !== 'DesignComment' || row.workstationId !== wsId) continue;
    const r = await updateEntity(actor, db, id, { data: { ...dataOf<CommentData>(row), status: 'resolved', ...(note ? { note } : {}) }, baseVersion: row.version, reason: note });
    if (r.kind === 'ok') resolved += 1;
  }
  return resolved;
}

// 交接件是冻结快照，删稿不影响已起草的开发任务；评论和历史版本跟着稿子一起删
export async function deleteDesign(actor: Actor, db: DB, id: string) {
  const row = await designRow(db, id);
  if (!row) return { kind: 'not_found' as const, status: 404 as const, error: '设计稿不存在' };
  const ids = [id, ...(await listDesignComments(db, row.workstationId, id)).map((c) => c.id)];
  await db.delete(entityVersion).where(inArray(entityVersion.entityId, ids));
  await db.delete(entity).where(inArray(entity.id, ids));
  await logEvent(db, actor, 'entity_deleted', 'entity', id, { entityType: 'Design', title: dataOf<DesignData>(row).title });
  return { kind: 'ok' as const };
}

// 渲染用的成品文档：旧版令牌和旋钮的合成方式与交接快照一致；version 指定时读历史版本
export async function renderableDesign(db: DB, designId: string, version?: number) {
  const row = await designRow(db, designId);
  if (!row) return null;
  let dataJson = row.dataJson;
  if (version !== undefined && version !== row.version) {
    const old = (await db.select().from(entityVersion).where(and(eq(entityVersion.entityId, row.id), eq(entityVersion.version, version))))[0];
    if (!old) return null;
    dataJson = old.dataJson;
  }
  const d = dataOf<DesignData>({ ...row, dataJson });
  return { title: d.title, version: version ?? row.version, workstationId: row.workstationId, html: composeDesignDoc(d.html, { tokens: d.legacyTokens ?? [], tweaks: d.tweaks ?? [] }) };
}

// 页面地址只允许本机：验收时平台拿它起/连 serve 截图，外部地址没意义也不安全
function checkPageUrl(raw: string) {
  const s = raw.replace(/\{port\}/g, '8080');
  try {
    const u = new URL(s);
    if (!['http:', 'https:'].includes(u.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

// 跨台不共享实体：交接时把当时的成品冻结成 Artifact，开发台只能读到这一份只读快照
export async function handoffDesign(actor: Actor, db: DB, id: string, input: { targetWorkstationId: string; module: string; priority: 'p0' | 'p1' | 'p2'; note?: string | undefined; qaCases?: boolean | undefined; pageUrl?: string | undefined }) {
  const row = await designRow(db, id);
  if (!row) return { kind: 'not_found' as const, status: 404 as const, error: '设计稿不存在' };
  const here = (await db.select().from(workstation).where(eq(workstation.id, row.workstationId)))[0];
  const target = (await db.select().from(workstation).where(eq(workstation.id, input.targetWorkstationId)))[0];
  if (!here || !target || target.projectId !== here.projectId || target.pluginId !== 'dev' || target.status === 'archived') return { kind: 'error' as const, status: 400 as const, error: '只能交接给同一项目的开发工作台' };
  if (input.pageUrl && !checkPageUrl(input.pageUrl)) return { kind: 'error' as const, status: 400 as const, error: '页面地址只能是本机 http(s) 地址' };
  const d = dataOf<DesignData>(row);
  const standalone = composeDesignDoc(d.html, { tokens: d.legacyTokens ?? [], tweaks: d.tweaks ?? [] });
  const artifactId = crypto.randomUUID();
  await db.insert(artifact).values({
    id: artifactId, workstationId: row.workstationId, type: 'design_handoff', name: d.title, ref: standalone,
    metaJson: JSON.stringify({ designId: id, version: row.version, brief: d.brief ?? null, note: input.note ?? null, tokens: d.legacyTokens ?? [] }),
    createdAt: now(),
  });
  const r = await createTaskUc(actor, db, target.id, {
    title: `实现设计稿：${d.title}`,
    intent: [`${here.id === target.id ? `按设计稿 ${d.title} v${row.version} 实现。` : `按「${here.name}」交接的设计稿 ${d.title} v${row.version} 实现。`}用 read_design_handoff 读取稿子。`, d.brief ? `需求：${d.brief}` : '', input.note ? `备注：${input.note}` : ''].filter(Boolean).join('\n'),
    typeId: 'dev.issue',
    input: { kind: 'feature', priority: input.priority, module: input.module, design_artifact: artifactId },
    acceptance: [{ kind: 'manual', text: `页面的版式、层级和交互与设计稿 ${d.title} v${row.version} 一致` }, ...(input.pageUrl ? [{ kind: 'design_match', url: input.pageUrl, artifact: artifactId }] : [])],
  });
  if (r.kind !== 'ok') return r;
  const taskId = r.task!.id;
  if (input.qaCases) await askQaForCases(db, target.id, { title: d.title, taskTitle: r.task!.title, artifactId });
  await updateEntity(actor, db, id, { data: { ...d, status: 'handed_off', handoff: { taskId, artifactId, version: row.version, workstationId: target.id } } as unknown as Record<string, unknown>, baseVersion: row.version, reason: `交给${target.name}` });
  await logEvent(db, actor, 'entity_handoff', 'entity', id, { taskId, artifactId });
  return { kind: 'ok' as const, taskId, artifactId };
}

// 交接时点名目标开发台的用例设计起草验收用例；以人的身份发言，会话路由才会唤醒被 @ 的 Agent
async function askQaForCases(db: DB, devWsId: string, info: { title: string; taskTitle: string; artifactId: string }) {
  const designer = (await db.select({ name: agent.name }).from(agent).where(and(eq(agent.workstationId, devWsId), eq(agent.templateId, 'case-designer'), eq(agent.status, 'active'))))[0];
  if (!designer) return;
  const th = await wsThreadOf(db, devWsId);
  await postThreadMessage({ type: 'human', id: 'local' }, db, th.id, `@${designer.name} 设计稿「${info.title}」已在本台起草实现任务「${info.taskTitle}」，请据设计交接快照 ${info.artifactId} 起草验收用例草稿，requirement 写「设计交接：${info.title}」。`);
}

// 只有任务（或它的祖先）声明过的交接件才读得到
export async function readHandoffFor(db: DB, taskRow: typeof task.$inferSelect) {
  let cur: typeof task.$inferSelect | undefined = taskRow;
  for (let depth = 0; cur && depth < 8; depth++) {
    const artifactId = (JSON.parse(cur.inputJson ?? '{}') as { design_artifact?: string }).design_artifact;
    if (artifactId) {
      const a = (await db.select().from(artifact).where(eq(artifact.id, artifactId)))[0];
      if (a?.type !== 'design_handoff') return null;
      const meta = JSON.parse(a.metaJson ?? '{}') as { version?: number; brief?: string | null; tokens?: DesignToken[] };
      return { title: a.name, version: meta.version, brief: meta.brief ?? null, tokens: meta.tokens ?? [], html: a.ref ?? '' };
    }
    cur = cur.parentId ? (await db.select().from(task).where(eq(task.id, cur.parentId)))[0] : undefined;
  }
  return null;
}

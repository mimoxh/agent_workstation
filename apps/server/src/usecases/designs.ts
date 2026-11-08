import { applyTextEdits, composeDesignDoc, lintDesign, parseCssTokens, type DesignToken, type DesignTweak } from '@aw/domain';
import type { Actor } from '@aw/domain';
import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { artifact, entity, task, workstation } from '../db/schema.js';
import { logEvent } from './core.js';
import { createEntity, updateEntity } from './entities.js';
import { readRepoFile } from './repo.js';
import { createTaskUc } from './tasks.js';

const now = () => new Date().toISOString();

export const DEFAULT_TOKENS: DesignToken[] = [
  { name: '--color-bg', value: '#faf9f6', description: '页面背景' },
  { name: '--color-surface', value: '#ffffff', description: '卡片、面板' },
  { name: '--color-text', value: '#1c1b19', description: '正文' },
  { name: '--color-muted', value: '#6f6c66', description: '次要文字' },
  { name: '--color-border', value: '#e4e2dc', description: '分隔线' },
  { name: '--color-primary', value: '#1f4d3f', description: '主操作' },
  { name: '--color-on-primary', value: '#ffffff', description: '主操作上的文字' },
  { name: '--color-accent', value: '#d9622b', description: '强调' },
  { name: '--font-sans', value: 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif', description: '正文字体' },
  { name: '--font-display', value: 'Georgia, "Songti SC", "SimSun", serif', description: '标题字体' },
  { name: '--radius-sm', value: '4px' },
  { name: '--radius-md', value: '8px' },
  { name: '--radius-lg', value: '16px' },
  { name: '--space-1', value: '4px' },
  { name: '--space-2', value: '8px' },
  { name: '--space-3', value: '16px' },
  { name: '--space-4', value: '24px' },
  { name: '--space-5', value: '40px' },
  { name: '--space-6', value: '64px' },
  { name: '--shadow-card', value: '0 1px 2px rgb(0 0 0 / 0.06), 0 8px 24px rgb(0 0 0 / 0.06)' },
];

export interface DesignData {
  title: string;
  html: string;
  brief?: string | undefined;
  group?: string | undefined;
  direction?: string | undefined;
  tweaks?: DesignTweak[] | undefined;
  status?: 'draft' | 'approved' | 'handed_off' | undefined;
  handoff?: { taskId: string; artifactId: string; version: number; workstationId: string } | undefined;
}

export interface CommentData { design: string; version?: number | undefined; selector?: string | undefined; anchor?: string | undefined; body: string; status?: 'open' | 'resolved' | undefined; note?: string | undefined }

type EntityRow = typeof entity.$inferSelect;

const dataOf = <T,>(e: EntityRow) => JSON.parse(e.dataJson ?? '{}') as T;

const ofType = (db: DB, wsId: string, type: string) => db.select().from(entity).where(and(eq(entity.workstationId, wsId), eq(entity.entityType, type)));

export const designRow = async (db: DB, id: string) => {
  const e = (await db.select().from(entity).where(eq(entity.id, id)))[0];
  return e?.entityType === 'Design' ? e : undefined;
};

// 还没保存过时用默认令牌，第一次改动才落库
export async function designSystemOf(db: DB, wsId: string) {
  const row = (await ofType(db, wsId, 'DesignSystem'))[0];
  if (!row) return { id: null, version: 0, name: '默认设计系统', tokens: DEFAULT_TOKENS, guidelines: '' };
  const d = dataOf<{ name: string; tokens?: DesignToken[]; guidelines?: string }>(row);
  return { id: row.id, version: row.version, name: d.name, tokens: d.tokens ?? [], guidelines: d.guidelines ?? '' };
}

export async function saveDesignSystem(actor: Actor, db: DB, wsId: string, input: { name?: string | undefined; tokens?: DesignToken[] | undefined; guidelines?: string | undefined; reason?: string | undefined; baseVersion?: number | undefined }) {
  const cur = await designSystemOf(db, wsId);
  const data = { name: input.name ?? cur.name, tokens: input.tokens ?? cur.tokens, guidelines: input.guidelines ?? cur.guidelines };
  if (!cur.id) return createEntity(actor, db, wsId, { entityType: 'DesignSystem', data, reason: input.reason });
  return updateEntity(actor, db, cur.id, { data, baseVersion: input.baseVersion ?? cur.version, reason: input.reason });
}

export async function importDesignTokens(actor: Actor, db: DB, wsId: string, input: { css?: string | undefined; sourceWorkstationId?: string | undefined; path?: string | undefined }) {
  let css = input.css ?? '';
  let origin = '粘贴的 CSS';
  if (!css && input.sourceWorkstationId && input.path) {
    const here = (await db.select().from(workstation).where(eq(workstation.id, wsId)))[0];
    const source = (await db.select().from(workstation).where(eq(workstation.id, input.sourceWorkstationId)))[0];
    if (!here || source?.projectId !== here.projectId) return { kind: 'error' as const, status: 400 as const, error: '只能从同一项目的工作台导入' };
    const file = await readRepoFile(db, source.id, input.path);
    if (file.kind !== 'ok') return file;
    if (file.binary) return { kind: 'error' as const, status: 400 as const, error: '这不是文本文件' };
    css = file.content;
    origin = input.path;
  }
  const tokens = parseCssTokens(css);
  if (tokens.length === 0) return { kind: 'error' as const, status: 400 as const, error: '没有找到 CSS 变量（形如 --color-primary: #000;）' };
  const cur = await designSystemOf(db, wsId);
  const imported = new Map(tokens.map((t) => [t.name, t]));
  // 同名以导入的为准，保留原有的说明；默认令牌整组让位，否则混着两套命名
  const kept = cur.id ? cur.tokens.filter((t) => !imported.has(t.name)) : [];
  const merged = [...kept, ...tokens.map((t) => ({ ...t, ...(cur.tokens.find((x) => x.name === t.name)?.description ? { description: cur.tokens.find((x) => x.name === t.name)!.description } : {}) }))];
  const r = await saveDesignSystem(actor, db, wsId, { tokens: merged, reason: `从 ${origin} 导入 ${tokens.length} 个令牌` });
  return r.kind === 'ok' ? { kind: 'ok' as const, count: tokens.length } : r;
}

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
  const system = await designSystemOf(db, wsId);
  const warningsFor = (d: DesignData) => lintDesign(d.html, { tokens: system.tokens, tweaks: d.tweaks ?? [] });
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

// 跨台不共享实体：交接时把当时的成品冻结成 Artifact，开发台只能读到这一份只读快照
export async function handoffDesign(actor: Actor, db: DB, id: string, input: { targetWorkstationId: string; module: string; priority: 'p0' | 'p1' | 'p2'; note?: string | undefined }) {
  const row = await designRow(db, id);
  if (!row) return { kind: 'not_found' as const, status: 404 as const, error: '设计稿不存在' };
  const here = (await db.select().from(workstation).where(eq(workstation.id, row.workstationId)))[0];
  const target = (await db.select().from(workstation).where(eq(workstation.id, input.targetWorkstationId)))[0];
  if (!here || !target || target.projectId !== here.projectId || target.pluginId !== 'dev') return { kind: 'error' as const, status: 400 as const, error: '只能交接给同一项目的开发工作台' };
  const d = dataOf<DesignData>(row);
  const system = await designSystemOf(db, row.workstationId);
  const standalone = composeDesignDoc(d.html, { tokens: system.tokens, tweaks: d.tweaks ?? [] });
  const artifactId = crypto.randomUUID();
  await db.insert(artifact).values({
    id: artifactId, workstationId: row.workstationId, type: 'design_handoff', name: d.title, ref: standalone,
    metaJson: JSON.stringify({ designId: id, version: row.version, brief: d.brief ?? null, tokens: system.tokens, guidelines: system.guidelines }),
    createdAt: now(),
  });
  const r = await createTaskUc(actor, db, target.id, {
    title: `实现设计稿：${d.title}`,
    intent: [`按「${here.name}」交接的设计稿 ${d.title} v${row.version} 实现。用 read_design_handoff 读取稿子和设计令牌。`, d.brief ? `需求：${d.brief}` : '', input.note ? `备注：${input.note}` : ''].filter(Boolean).join('\n'),
    typeId: 'dev.issue',
    input: { kind: 'feature', priority: input.priority, module: input.module, design_artifact: artifactId },
    acceptance: [{ kind: 'manual', text: `页面的版式、层级和交互与设计稿 ${d.title} v${row.version} 一致` }],
  });
  if (r.kind !== 'ok') return r;
  const taskId = r.task!.id;
  await updateEntity(actor, db, id, { data: { ...d, status: 'handed_off', handoff: { taskId, artifactId, version: row.version, workstationId: target.id } } as unknown as Record<string, unknown>, baseVersion: row.version, reason: `交给${target.name}` });
  await logEvent(db, actor, 'entity_handoff', 'entity', id, { taskId, artifactId });
  return { kind: 'ok' as const, taskId, artifactId };
}

// 只有任务（或它的祖先）声明过的交接件才读得到
export async function readHandoffFor(db: DB, taskRow: typeof task.$inferSelect) {
  let cur: typeof task.$inferSelect | undefined = taskRow;
  for (let depth = 0; cur && depth < 8; depth++) {
    const artifactId = (JSON.parse(cur.inputJson ?? '{}') as { design_artifact?: string }).design_artifact;
    if (artifactId) {
      const a = (await db.select().from(artifact).where(eq(artifact.id, artifactId)))[0];
      if (a?.type !== 'design_handoff') return null;
      const meta = JSON.parse(a.metaJson ?? '{}') as { version?: number; brief?: string | null; tokens?: DesignToken[]; guidelines?: string };
      return { title: a.name, version: meta.version, brief: meta.brief ?? null, guidelines: meta.guidelines ?? '', tokens: meta.tokens ?? [], html: a.ref ?? '' };
    }
    cur = cur.parentId ? (await db.select().from(task).where(eq(task.id, cur.parentId)))[0] : undefined;
  }
  return null;
}

import { createHash } from 'node:crypto';
import type { Actor } from '@aw/domain';
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { knowledgeChunk, knowledgeSource, workstation } from '../db/schema.js';
import { logEvent } from './core.js';

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

// DECISIONS Q3：512–1024 tokens，重叠 10–15%；中文约 1 字 1 token，取中间值
const CHUNK_CHARS = 800;
const OVERLAP_CHARS = 100;
const TRIGRAM_MIN = 3;

export interface Anchor { headingPath: string[]; offset: number }
interface Chunk { text: string; anchor: Anchor }

function splitLong(text: string, base: Anchor): Chunk[] {
  if (text.length <= CHUNK_CHARS) return [{ text, anchor: base }];
  const out: Chunk[] = [];
  for (let start = 0; start < text.length; start += CHUNK_CHARS - OVERLAP_CHARS) {
    out.push({ text: text.slice(start, start + CHUNK_CHARS), anchor: { ...base, offset: base.offset + start } });
    if (start + CHUNK_CHARS >= text.length) break;
  }
  return out;
}

// 优先按标题层级切，段内再按长度切，每块保留可回到原文的锚点
export function chunkText(content: string): Chunk[] {
  const path: string[] = [];
  const out: Chunk[] = [];
  let section: string[] = [];
  let sectionStart = 0;
  let offset = 0;
  const flush = () => {
    const text = section.join('\n').trim();
    if (text) out.push(...splitLong(text, { headingPath: [...path], offset: sectionStart }));
    section = [];
  };
  for (const line of content.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      path.length = heading[1]!.length - 1;
      path[heading[1]!.length - 1] = heading[2]!.trim();
      sectionStart = offset;
    } else {
      if (section.length === 0) sectionStart = offset;
      section.push(line);
    }
    offset += line.length + 1;
  }
  flush();
  return out;
}

export async function importSource(actor: Actor, db: DB, input: { projectId: string; workstationId?: string | undefined; name: string; content: string; kind: 'md' | 'txt' | 'note' }) {
  const content = input.content.trim();
  if (!content) return { kind: 'error' as const, status: 400 as const, error: '内容为空' };
  const p = await db.select().from(workstation).where(eq(workstation.projectId, input.projectId));
  if (p.length === 0) return { kind: 'not_found' as const, status: 404 as const, error: '项目不存在' };
  const id = uid();
  const sha256 = createHash('sha256').update(content).digest('hex');
  await db.insert(knowledgeSource).values({
    id, workspaceId: 'default', scopeType: input.workstationId ? 'workstation' : 'project', scopeId: input.workstationId ?? input.projectId,
    name: input.name, kind: input.kind, sha256, size: content.length, status: 'ready', createdAt: now(),
  });
  const fts = db.$client.prepare('INSERT INTO knowledge_fts (text, chunk_id) VALUES (?, ?)');
  for (const [ordinal, c] of chunkText(content).entries()) {
    const chunkId = uid();
    await db.insert(knowledgeChunk).values({ id: chunkId, sourceId: id, ordinal, text: c.text, tokenCount: c.text.length, anchorJson: JSON.stringify(c.anchor), createdAt: now() });
    fts.run(c.text, chunkId);
  }
  await logEvent(db, actor, 'entity_created', 'knowledge_source', id, { name: input.name });
  return { kind: 'ok' as const, id };
}

const scopeFilter = (projectId: string, wsId?: string) =>
  or(
    and(eq(knowledgeSource.scopeType, 'project'), eq(knowledgeSource.scopeId, projectId)),
    ...(wsId ? [and(eq(knowledgeSource.scopeType, 'workstation'), eq(knowledgeSource.scopeId, wsId))] : []),
  );

export async function listSources(db: DB, projectId: string, wsId?: string) {
  return db.select().from(knowledgeSource).where(scopeFilter(projectId, wsId)).orderBy(desc(knowledgeSource.createdAt));
}

export async function deleteSource(actor: Actor, db: DB, id: string) {
  const chunks = await db.select({ id: knowledgeChunk.id }).from(knowledgeChunk).where(eq(knowledgeChunk.sourceId, id));
  const del = db.$client.prepare('DELETE FROM knowledge_fts WHERE chunk_id = ?');
  for (const c of chunks) del.run(c.id);
  await db.delete(knowledgeChunk).where(eq(knowledgeChunk.sourceId, id));
  const r = await db.delete(knowledgeSource).where(eq(knowledgeSource.id, id));
  if (r.changes === 0) return { kind: 'not_found' as const, status: 404 as const, error: '来源不存在' };
  await logEvent(db, actor, 'entity_deleted', 'knowledge_source', id, {});
  return { kind: 'ok' as const };
}

export interface Hit { chunkId: string; sourceId: string; sourceName: string; text: string; anchor: Anchor; citation: string }

// trigram 匹配不了不足 3 字的词（中文常见），这类查询退回子串扫描
function matchIds(db: DB, query: string, limit: number): string[] {
  const q = query.trim();
  if (q.length >= TRIGRAM_MIN) {
    const phrase = `"${q.replaceAll('"', '""')}"`;
    const rows = db.$client.prepare('SELECT chunk_id AS id FROM knowledge_fts WHERE knowledge_fts MATCH ? ORDER BY bm25(knowledge_fts) LIMIT ?').all(phrase, limit) as { id: string }[];
    return rows.map((r) => r.id);
  }
  const rows = db.$client.prepare('SELECT id FROM knowledge_chunk WHERE instr(text, ?) > 0 LIMIT ?').all(q, limit) as { id: string }[];
  return rows.map((r) => r.id);
}

export async function searchKnowledge(db: DB, scope: { projectId: string; workstationId?: string | undefined }, query: string, topK = 5): Promise<Hit[]> {
  const ids = matchIds(db, query, topK * 4);
  if (ids.length === 0) return [];
  const chunks = await db.select().from(knowledgeChunk).where(inArray(knowledgeChunk.id, ids));
  const sources = await db.select().from(knowledgeSource).where(and(inArray(knowledgeSource.id, chunks.map((c) => c.sourceId)), scopeFilter(scope.projectId, scope.workstationId)));
  const hits: Hit[] = [];
  for (const id of ids) {
    const c = chunks.find((x) => x.id === id);
    const s = c && sources.find((x) => x.id === c.sourceId);
    if (!c || !s) continue;
    const anchor = JSON.parse(c.anchorJson ?? '{}') as Anchor;
    hits.push({ chunkId: c.id, sourceId: s.id, sourceName: s.name, text: c.text, anchor, citation: `[[kb:${c.id}]]` });
  }
  return hits.slice(0, topK);
}

export async function getChunk(db: DB, id: string) {
  const c = (await db.select().from(knowledgeChunk).where(eq(knowledgeChunk.id, id)))[0];
  if (!c) return null;
  const s = (await db.select().from(knowledgeSource).where(eq(knowledgeSource.id, c.sourceId)))[0];
  return { id: c.id, text: c.text, anchor: JSON.parse(c.anchorJson ?? '{}') as Anchor, sourceName: s?.name ?? '', sourceId: c.sourceId };
}

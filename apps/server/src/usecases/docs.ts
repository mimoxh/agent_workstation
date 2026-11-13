import { applyTextEdits, canHandoff, citationRefs, classifyCitationDrift, lintDoc, normalizeSnippet, renderForRepo, type DocLintConfig, type DocStatus, type StyleTerm } from '@aw/domain';
import type { Actor } from '@aw/domain';
import { and, eq, inArray } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { DB } from '../db/client.js';
import { artifact, entity, entityVersion, eventLog, knowledgeChunk, knowledgeSource, proposal, task, workstation } from '../db/schema.js';
import { devSettings, git } from '../runtime/git.js';
import { logEvent } from './core.js';
import { createEntity, updateEntity } from './entities.js';
import { pushInbox } from './inbox.js';
import { listRepoSources, repoSourceOf } from './repo_source.js';
import { createTaskUc } from './tasks.js';
import { PLATFORM, postMessage, postThreadMessage, wsThreadOf } from './threads.js';

const now = () => new Date().toISOString();
const err = (error: string, status: 400 | 404 | 409 = 400) => ({ kind: 'error' as const, status, error });

export interface RepoCitationInput { id: string; kind: 'repo'; repo?: string | undefined; path: string; ref?: string | undefined; lines: [number, number] }
export interface KnowledgeCitationInput { id: string; kind: 'knowledge'; sourceId: string; quote: string }
export type CitationInput = RepoCitationInput | KnowledgeCitationInput;

export interface RepoCitation { id: string; kind: 'repo'; repo: string; path: string; ref: string; commit: string; blob: string; lines: [number, number]; snippetHash: string; excerpt: string }
export interface KnowledgeCitation { id: string; kind: 'knowledge'; sourceId: string; chunkId: string; headingPath: string[]; excerpt: string }
export type DocCitation = RepoCitation | KnowledgeCitation;

export interface ReviewFinding { claim: string; citation?: string | undefined; status: 'supported' | 'unsupported' | 'outdated' | 'unverifiable'; evidence: string }
export interface DocReview { contentHash: string; verdict: 'pass' | 'fail'; summary: string; findings: ReviewFinding[]; by: string; at: string }

export interface DocHandoff {
  artifactId: string;
  taskId: string;
  version: number;
  contentHash: string;
  repo: string;
  path: string;
  baseBlob: string | null;
  at: string;
  by: string;
  override: string | null;
  publishedCommit?: string | undefined;
  publishedBlob?: string | null | undefined;
  publishedAt?: string | undefined;
  cancelled?: boolean | undefined;
}

export interface DocData {
  title: string;
  kind?: 'readme' | 'api' | 'guide' | 'architecture' | 'adr' | 'release_notes' | 'general' | undefined;
  brief?: string | undefined;
  target_repo?: string | null | undefined;
  target_path?: string | null | undefined;
  content: string;
  citations?: DocCitation[] | undefined;
  status?: DocStatus | undefined;
  review?: DocReview | null | undefined;
  drift?: DocDrift | undefined;
  handoff?: DocHandoff | undefined;
}

export interface CommentData { doc: string; version?: number | undefined; heading?: string | undefined; quote?: string | undefined; body: string; severity?: 'block' | 'note' | undefined; status?: 'open' | 'resolved' | undefined; note?: string | undefined }

export interface StyleGuideData { name: string; terms?: StyleTerm[] | undefined; rules?: string | undefined; lint?: DocLintConfig | undefined }

type EntityRow = typeof entity.$inferSelect;

const dataOf = <T,>(e: EntityRow) => JSON.parse(e.dataJson ?? '{}') as T;

const ofType = (db: DB, wsId: string, type: string) => db.select().from(entity).where(and(eq(entity.workstationId, wsId), eq(entity.entityType, type)));

export const docRow = async (db: DB, id: string) => {
  const e = (await db.select().from(entity).where(eq(entity.id, id)))[0];
  return e?.entityType === 'Doc' ? e : undefined;
};

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

// 核对结论绑定内容哈希而不是实体版本：改 review / status 也升版本，但不该让核对失效。
// 引用只取身份字段（commit/blob/行号/ref 不算），片段挪位后重指行号也不让核对作废
export function contentHashOf(d: { content?: string | undefined; citations?: DocCitation[] | undefined }) {
  const cits = (d.citations ?? [])
    .map((c) => (c.kind === 'repo'
      ? { id: c.id, kind: 'repo', repo: c.repo, path: c.path, snippetHash: c.snippetHash }
      : { id: c.id, kind: 'knowledge', sourceId: c.sourceId, excerpt: c.excerpt }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return sha256(`${d.content ?? ''}\n${JSON.stringify(cits)}`);
}

const strip = (s: string) => s.replace(/\s+/g, '');

const REF = /^[\w][\w./@-]*$/;
const SAFE_PATH = /^[^-\0][^\0]*$/;

// 引用一律在写入时解析成不可变快照（commit + blob + 片段哈希），任何一条解析失败整次写入都失败
async function resolveRepoCitation(db: DB, wsId: string, c: RepoCitationInput): Promise<{ ok: true; citation: RepoCitation } | { ok: false; error: string }> {
  const source = await repoSourceOf(db, wsId, c.repo);
  if (!source.ok) return { ok: false, error: `${c.id}：${source.error}` };
  const ref = c.ref ?? source.settings.targetBranch;
  const file = c.path.replace(/\\/g, '/').replace(/^\.?\/+/, '');
  if (!REF.test(ref) || !SAFE_PATH.test(file) || file.split('/').includes('..')) return { ok: false, error: `${c.id}：路径或版本不合法` };
  const commit = await git(source.settings.repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (commit.code !== 0) return { ok: false, error: `${c.id}：找不到分支或提交 ${ref}` };
  const sha = commit.stdout.trim();
  const blob = await git(source.settings.repoPath, ['rev-parse', '--verify', '--quiet', `${sha}:${file}`]);
  if (blob.code !== 0) return { ok: false, error: `${c.id}：${sha.slice(0, 8)} 上没有文件 ${file}` };
  const show = await git(source.settings.repoPath, ['show', `${sha}:${file}`]);
  if (show.code !== 0) return { ok: false, error: `${c.id}：读取 ${file} 失败` };
  const lines = show.stdout.split('\n');
  const [start, end] = c.lines;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines.length) return { ok: false, error: `${c.id}：行号 ${start}-${end} 越界（共 ${lines.length} 行）` };
  if (end - start + 1 > 200) return { ok: false, error: `${c.id}：一次引用最多 200 行` };
  const snippet = lines.slice(start - 1, end).join('\n');
  return {
    ok: true,
    citation: { id: c.id, kind: 'repo', repo: source.workstationId, path: file, ref, commit: sha, blob: blob.stdout.trim(), lines: [start, end], snippetHash: sha256(normalizeSnippet(snippet)), excerpt: snippet.slice(0, 400) },
  };
}

// 知识库引用：来源要对本项目可见（与 search_knowledge 同一条范围规则），引文逐字落在某个片段里
async function resolveKnowledgeCitation(db: DB, wsId: string, c: KnowledgeCitationInput): Promise<{ ok: true; citation: KnowledgeCitation } | { ok: false; error: string }> {
  const ws = (await db.select().from(workstation).where(eq(workstation.id, wsId)))[0];
  if (!ws) return { ok: false, error: `${c.id}：工作台不存在` };
  const source = (await db.select().from(knowledgeSource).where(eq(knowledgeSource.id, c.sourceId)))[0];
  const visible = source && ((source.scopeType === 'project' && source.scopeId === ws.projectId) || (source.scopeType === 'workstation' && source.scopeId === wsId));
  if (!visible) return { ok: false, error: `${c.id}：知识库来源不存在或不可见` };
  const chunks = await db.select().from(knowledgeChunk).where(eq(knowledgeChunk.sourceId, source!.id));
  const want = strip(normalizeSnippet(c.quote));
  const hit = want ? chunks.find((ch) => strip(normalizeSnippet(ch.text)).includes(want)) : undefined;
  if (!hit) return { ok: false, error: `${c.id}：原文里找不到这段引文` };
  const anchor = JSON.parse(hit.anchorJson ?? '{}') as { headingPath?: string[] };
  return { ok: true, citation: { id: c.id, kind: 'knowledge', sourceId: source!.id, chunkId: hit.id, headingPath: anchor.headingPath ?? [], excerpt: c.quote } };
}

const isInput = (c: DocCitation | CitationInput): c is CitationInput =>
  c.kind === 'repo' ? !(c as RepoCitation).commit : !(c as KnowledgeCitation).chunkId;

// 人保存时把已解析的引用原样传回：与库里一致就不再重新解析；变了形状的按输入重新解析
async function resolveCitations(db: DB, wsId: string, input: (DocCitation | CitationInput)[], stored: DocCitation[]) {
  const out: DocCitation[] = [];
  const seen = new Set<string>();
  for (const c of input) {
    if (!c.id || seen.has(c.id)) return { ok: false as const, error: `引用 id ${c.id || '(空)'} 重复或为空` };
    seen.add(c.id);
    const kept = stored.find((s) => s.id === c.id);
    if (kept && !isInput(c) && JSON.stringify(kept) === JSON.stringify(c)) {
      out.push(kept);
      continue;
    }
    const r = c.kind === 'repo'
      ? await resolveRepoCitation(db, wsId, c as RepoCitationInput)
      : await resolveKnowledgeCitation(db, wsId, c as KnowledgeCitationInput);
    if (!r.ok) return { ok: false as const, error: r.error };
    out.push(r.citation);
  }
  return { ok: true as const, citations: out };
}

// 还没保存过时给空指南，第一次改动才落库
export async function styleGuideOf(db: DB, wsId: string) {
  const row = (await ofType(db, wsId, 'StyleGuide'))[0];
  if (!row) return { id: null, version: 0, name: '风格指南', terms: [] as StyleTerm[], rules: '', lint: {} as DocLintConfig };
  const d = dataOf<StyleGuideData>(row);
  return { id: row.id, version: row.version, name: d.name, terms: d.terms ?? [], rules: d.rules ?? '', lint: d.lint ?? {} };
}

export async function saveStyleGuide(actor: Actor, db: DB, wsId: string, input: { name?: string | undefined; terms?: StyleTerm[] | undefined; rules?: string | undefined; lint?: DocLintConfig | undefined; reason?: string | undefined; baseVersion?: number | undefined }) {
  const cur = await styleGuideOf(db, wsId);
  const data = { name: input.name ?? cur.name, terms: input.terms ?? cur.terms, rules: input.rules ?? cur.rules, lint: input.lint ?? cur.lint };
  if (!cur.id) return createEntity(actor, db, wsId, { entityType: 'StyleGuide', data, reason: input.reason });
  return updateEntity(actor, db, cur.id, { data, baseVersion: input.baseVersion ?? cur.version, reason: input.reason });
}

export async function listDocComments(db: DB, wsId: string, docId?: string) {
  const rows = await ofType(db, wsId, 'DocComment');
  return rows.map((e) => ({ id: e.id, ...dataOf<CommentData>(e), createdAt: e.createdAt })).filter((c) => !docId || c.doc === docId);
}

export async function listDocs(db: DB, wsId: string) {
  const [rows, comments] = await Promise.all([ofType(db, wsId, 'Doc'), listDocComments(db, wsId)]);
  const names = new Map((await listRepoSources(db, wsId)).map((r) => [r.repo, r.name]));
  return rows.map((e) => {
    const d = dataOf<DocData>(e);
    return {
      id: e.id, title: d.title, kind: d.kind ?? 'general', version: e.version, status: d.status ?? 'draft',
      target: d.target_repo ? { repo: d.target_repo, name: names.get(d.target_repo) ?? null, path: d.target_path ?? null } : null,
      updatedAt: e.updatedAt, openComments: comments.filter((c) => c.doc === e.id && c.status !== 'resolved').length,
      drift: d.drift && (d.drift.items.length > 0 || d.drift.reverse) ? { bad: d.drift.items.filter((i) => i.status !== 'moved').length, moved: d.drift.items.filter((i) => i.status === 'moved').length, reverse: !!d.drift.reverse } : null,
    };
  });
}

const docLint = async (db: DB, wsId: string, d: DocData) => {
  const guide = await styleGuideOf(db, wsId);
  return lintDoc(d.content ?? '', { terms: guide.terms, lint: guide.lint }, (d.citations ?? []).map((c) => c.id));
};

// 目标路径：仓库内相对路径。反斜杠先归一，再逐项拦掉绝对/上级/.git/盘符/NUL/前导 -
const DRIVE = /^[A-Za-z]:/;
function targetPathError(p: string): string | null {
  const f = p.replace(/\\/g, '/');
  if (!f.trim() || f.length > 300) return '目标路径要填写 300 字以内';
  if (f.includes('\0')) return '目标路径不能包含 NUL 字符';
  if (f.startsWith('/')) return '目标路径不能是绝对路径';
  if (DRIVE.test(f)) return '目标路径不能带盘符';
  if (f.split('/').includes('..')) return '目标路径不能包含 ..';
  if (f.split('/')[0] === '.git') return '目标路径不能落在 .git 里';
  if (f.startsWith('-')) return '目标路径不能以 - 开头';
  return null;
}

// 目标仓库只要指向同项目的开发台（不要求已绑定仓库）；交接时才要求仓库真的可用
async function checkTargetRepo(db: DB, wsId: string, repo: string): Promise<string | null> {
  const ws = (await db.select().from(workstation).where(eq(workstation.id, wsId)))[0];
  if (!ws) return '工作台不存在';
  const target = (await db.select().from(workstation).where(eq(workstation.id, repo)))[0];
  if (!target || target.projectId !== ws.projectId || target.pluginId !== 'dev') return '目标仓库不是同项目的开发工作台';
  return null;
}

async function writeDoc(actor: Actor, db: DB, wsId: string, input: Omit<Partial<DocData>, 'citations'> & { id?: string | undefined; citations?: (DocCitation | CitationInput)[] | undefined; reason?: string | undefined; baseVersion?: number | undefined }) {
  const { id, reason, baseVersion, ...patch } = input;
  const fields = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<DocData>;
  if (fields.target_repo != null) {
    const bad = await checkTargetRepo(db, wsId, fields.target_repo);
    if (bad) return err(bad);
  }
  if (fields.target_path != null) {
    const bad = targetPathError(fields.target_path);
    if (bad) return err(bad);
    fields.target_path = fields.target_path.replace(/\\/g, '/');
  }
  if (!id) {
    if (fields.content === undefined) return err('内容不能为空');
    const resolved = await resolveCitations(db, wsId, input.citations ?? [], []);
    if (!resolved.ok) return err(resolved.error);
    const data: DocData = { title: '', kind: 'general', status: 'draft', ...fields, content: fields.content ?? '', citations: resolved.citations };
    const r = await createEntity(actor, db, wsId, { entityType: 'Doc', data: data as unknown as Record<string, unknown>, reason: reason ?? '初稿' });
    return r.kind === 'ok' ? { kind: 'ok' as const, id: r.id, version: 1, status: data.status ?? 'draft', lint: await docLint(db, wsId, data), citations: resolved.citations } : r;
  }
  const row = await docRow(db, id);
  if (!row || row.workstationId !== wsId) return { kind: 'not_found' as const, status: 404 as const, error: '文档不存在' };
  const prev = dataOf<DocData>(row);
  const resolved = await resolveCitations(db, wsId, input.citations ?? prev.citations ?? [], prev.citations ?? []);
  if (!resolved.ok) return err(resolved.error);
  const data: DocData = { ...prev, ...fields, citations: resolved.citations };
  // 内容或引用变了（哈希变）就回到草稿；状态只能平台拨，内部走 updateEntity
  if (contentHashOf(data) !== contentHashOf(prev)) data.status = 'draft';
  const r = await updateEntity(actor, db, id, { data: data as unknown as Record<string, unknown>, baseVersion: baseVersion ?? row.version, reason });
  return r.kind === 'ok' ? { kind: 'ok' as const, id, version: r.version, status: data.status ?? 'draft', lint: await docLint(db, wsId, data), citations: resolved.citations } : r;
}

export const saveDoc = writeDoc;

export async function editDoc(actor: Actor, db: DB, wsId: string, id: string, input: { edits: { oldText: string; newText: string }[]; citations?: (DocCitation | CitationInput)[] | undefined; removeCitations?: string[] | undefined; reason?: string | undefined }) {
  const row = await docRow(db, id);
  if (!row || row.workstationId !== wsId) return { kind: 'not_found' as const, status: 404 as const, error: '文档不存在' };
  const prev = dataOf<DocData>(row);
  const r = applyTextEdits(prev.content ?? '', input.edits);
  if (!r.ok) return err(r.error);
  const removed = new Set(input.removeCitations ?? []);
  const citations: (DocCitation | CitationInput)[] = [...(prev.citations ?? []).filter((c) => !removed.has(c.id) && !input.citations?.some((x) => x.id === c.id)), ...(input.citations ?? [])];
  return writeDoc(actor, db, wsId, { id, content: r.html, citations, reason: input.reason });
}

export async function addDocComment(actor: Actor, db: DB, wsId: string, input: { doc: string; quote?: string | undefined; heading?: string | undefined; body: string; severity?: 'block' | 'note' | undefined }) {
  const row = await docRow(db, input.doc);
  if (!row || row.workstationId !== wsId) return { kind: 'not_found' as const, status: 404 as const, error: '文档不存在' };
  const content = dataOf<DocData>(row).content ?? '';
  if (input.quote && !content.includes(input.quote)) return err('引用的原文在当前版本里找不到');
  return createEntity(actor, db, wsId, {
    entityType: 'DocComment',
    data: { doc: row.id, version: row.version, heading: input.heading ?? '', quote: input.quote ?? '', body: input.body, severity: input.severity ?? 'note', status: 'open' },
  });
}

export async function resolveDocComments(actor: Actor, db: DB, wsId: string, ids: string[], note?: string) {
  let resolved = 0;
  for (const id of ids) {
    const row = (await db.select().from(entity).where(eq(entity.id, id)))[0];
    if (row?.entityType !== 'DocComment' || row.workstationId !== wsId) continue;
    const r = await updateEntity(actor, db, id, { data: { ...dataOf<CommentData>(row), status: 'resolved', ...(note ? { note } : {}) }, baseVersion: row.version, reason: note });
    if (r.kind === 'ok') resolved += 1;
  }
  return resolved;
}

// 以人的身份在文档台大群 @ 对应 Agent，会话路由才会唤醒它
export async function requestReview(actor: Actor, db: DB, docId: string, who: 'fact-checker' | 'doc-editor') {
  const row = await docRow(db, docId);
  if (!row) return { kind: 'not_found' as const, status: 404 as const, error: '文档不存在' };
  const d = dataOf<DocData>(row);
  const name = who === 'fact-checker' ? '事实核对' : '文字编辑';
  if (who === 'fact-checker' && d.status !== 'reviewing') {
    const r = await updateEntity(actor, db, docId, { data: { ...d, status: 'reviewing' } as unknown as Record<string, unknown>, baseVersion: row.version, reason: '请求事实核对' });
    if (r.kind !== 'ok') return r;
  }
  const th = await wsThreadOf(db, row.workstationId);
  const text = who === 'fact-checker' ? `@${name} 请核对文档「${d.title}」（id: ${docId}）` : `@${name} 请看看文档「${d.title}」（id: ${docId}）的结构和文风`;
  await postThreadMessage(actor, db, th.id, text);
  return { kind: 'ok' as const };
}

// 核对结论钉在读取时的内容哈希上：文档中途被改过就不收，让 Agent 重读再核
export async function saveDocReview(actor: Actor, db: DB, wsId: string, input: { id: string; contentHash: string; verdict: 'pass' | 'fail'; summary: string; findings: ReviewFinding[] }) {
  const row = await docRow(db, input.id);
  if (!row || row.workstationId !== wsId) return { kind: 'not_found' as const, status: 404 as const, error: '文档不存在' };
  const d = dataOf<DocData>(row);
  const hash = contentHashOf(d);
  if (input.contentHash !== hash) return { kind: 'conflict' as const, status: 409 as const, error: '文档在读取后已变更，请重新读取再保存核对结论' };
  const review: DocReview = { contentHash: hash, verdict: input.verdict, summary: input.summary, findings: input.findings, by: actor.id, at: now() };
  const status: DocStatus = input.verdict === 'pass' ? 'approved' : 'draft';
  const r = await updateEntity(actor, db, row.id, { data: { ...d, review, status } as unknown as Record<string, unknown>, baseVersion: row.version, reason: `事实核对：${input.verdict === 'pass' ? '通过' : '未通过'}` });
  return r.kind === 'ok' ? { kind: 'ok' as const, verdict: input.verdict, status } : r;
}

export async function docGate(db: DB, docId: string) {
  const row = await docRow(db, docId);
  if (!row) return null;
  const d = dataOf<DocData>(row);
  const comments = await listDocComments(db, row.workstationId, docId);
  return canHandoff({
    reviewOk: !!d.review && d.review.contentHash === contentHashOf(d),
    reviewVerdict: d.review?.verdict ?? null,
    lint: await docLint(db, row.workstationId, d),
    openBlockingComments: comments.filter((c) => c.status !== 'resolved' && c.severity === 'block').length,
    targetRepo: d.target_repo ?? null,
    targetPath: d.target_path ?? null,
  });
}

export async function readDoc(db: DB, wsId: string, docId: string, version?: number) {
  const row = await docRow(db, docId);
  if (!row || row.workstationId !== wsId) return null;
  let dataJson = row.dataJson;
  if (version !== undefined && version !== row.version) {
    const old = (await db.select().from(entityVersion).where(and(eq(entityVersion.entityId, row.id), eq(entityVersion.version, version))))[0];
    if (!old) return null;
    dataJson = old.dataJson;
  }
  const d = dataOf<DocData>({ ...row, dataJson });
  const comments = (await listDocComments(db, wsId, row.id)).filter((c) => c.status !== 'resolved');
  return {
    id: row.id, latestVersion: row.version, version: version ?? row.version, ...d,
    contentHash: contentHashOf(d), openComments: comments,
    lint: await docLint(db, wsId, d), gate: await docGate(db, row.id), updatedAt: row.updatedAt,
  };
}

// 导出 / 交接用的脚注标签：仓库引用给路径行号，跨仓库时带仓库名；知识库引用来源名加引文
export async function citationLabelsOf(db: DB, wsId: string, d: Pick<DocData, 'citations' | 'target_repo'>) {
  const names = new Map((await listRepoSources(db, wsId)).map((r) => [r.repo, r.name]));
  const labels: { id: string; label: string }[] = [];
  for (const c of d.citations ?? []) {
    if (c.kind === 'repo') {
      const prefix = c.repo !== d.target_repo ? `${names.get(c.repo) ?? c.repo} · ` : '';
      labels.push({ id: c.id, label: `${prefix}\`${c.path}\` 第 ${c.lines[0]}–${c.lines[1]} 行` });
    } else {
      const src = (await db.select().from(knowledgeSource).where(eq(knowledgeSource.id, c.sourceId)))[0];
      labels.push({ id: c.id, label: `《${src?.name ?? c.sourceId}》：${c.excerpt.slice(0, 80)}` });
    }
  }
  return labels;
}

// 交接开发台：成品冻结成 doc_handoff 工件，开发台用 read_doc_handoff 取回。
// 缺目标仓库/路径不可放行，其它门禁原因可以凭人工理由强行走
export async function handoffDoc(actor: Actor, db: DB, docId: string, input: { module: string; priority: 'p0' | 'p1' | 'p2'; note?: string | undefined; citations: 'strip' | 'footnotes'; overrideReason?: string | undefined }) {
  const row = await docRow(db, docId);
  if (!row) return { kind: 'not_found' as const, status: 404 as const, error: '文档不存在' };
  const d = dataOf<DocData>(row);
  const gate = await docGate(db, docId);
  const override = input.overrideReason?.trim() ?? '';
  if (gate && !gate.ok) {
    if (!d.target_repo || !d.target_path) return err(`交接条件未满足：${gate.reasons.join('；')}`);
    if (!override) return err(`交接条件未满足：${gate.reasons.join('；')}。人工放行要填写理由`);
  }
  const source = await repoSourceOf(db, row.workstationId, d.target_repo ?? undefined);
  if (!source.ok) return err(`目标仓库不可用：${source.error}`);
  const commit = await git(source.settings.repoPath, ['rev-parse', '--verify', '--quiet', `${source.settings.targetBranch}^{commit}`]);
  if (commit.code !== 0) return err(`目标仓库还没有 ${source.settings.targetBranch} 分支`);
  const baseCommit = commit.stdout.trim();
  const blob = await git(source.settings.repoPath, ['rev-parse', '--verify', '--quiet', `${baseCommit}:${d.target_path}`]);
  const baseBlob = blob.code === 0 ? blob.stdout.trim() : null;
  const labels = await citationLabelsOf(db, row.workstationId, d);
  const rendered = renderForRepo(d.content ?? '', labels, input.citations);
  const hash = contentHashOf(d);
  const artifactId = crypto.randomUUID();
  await db.insert(artifact).values({
    id: artifactId, workstationId: row.workstationId, type: 'doc_handoff', name: d.title, ref: rendered,
    metaJson: JSON.stringify({ docId, version: row.version, contentHash: hash, path: d.target_path, repo: source.workstationId, baseCommit, baseBlob, citations: input.citations, note: input.note ?? null, override: override || null }),
    createdAt: now(),
  });
  const here = (await db.select().from(workstation).where(eq(workstation.id, row.workstationId)))[0]!;
  const r = await createTaskUc(actor, db, source.workstationId, {
    title: `写入文档：${d.title}`,
    intent: [`按「${here.name}」交接的文档《${d.title}》v${row.version} 写入 ${d.target_path}。用 read_doc_handoff 读取成品；成品是最终文本，不要改写措辞。`, input.note ? `备注：${input.note}` : ''].filter(Boolean).join('\n'),
    typeId: 'dev.issue',
    // dev.issue 的 kind 枚举没有 docs，文档写入用 chore
    input: { kind: 'chore', priority: input.priority, module: input.module, doc_artifact: artifactId },
    acceptance: [{ kind: 'manual', text: `${d.target_path} 的内容与交接的文档 v${row.version} 一致` }],
  });
  if (r.kind !== 'ok') return r;
  const taskId = r.task!.id;
  const handoff: DocHandoff = { artifactId, taskId, version: row.version, contentHash: hash, repo: source.workstationId, path: d.target_path!, baseBlob, at: now(), by: actor.id, override: override || null };
  const ur = await updateEntity(actor, db, docId, { data: { ...d, status: 'handed_off', handoff } as unknown as Record<string, unknown>, baseVersion: row.version, reason: '交给开发' });
  if (ur.kind !== 'ok') return ur;
  await logEvent(db, actor, 'doc_handed_off', 'entity', docId, { taskId, artifactId });
  const th = await wsThreadOf(db, row.workstationId);
  await postMessage(db, th.id, PLATFORM, `文档《${d.title}》v${row.version} 已交接给开发台，任务「${r.task!.title}」，落点 ${d.target_path}${override ? `（人工放行：${override}）` : ''}`, 'status');
  return { kind: 'ok' as const, taskId, artifactId };
}

// 只有任务（或它的祖先）声明过的交接件才读得到；同时看目标分支上该文件现在长什么样
export async function readDocHandoffFor(db: DB, taskRow: typeof task.$inferSelect) {
  let cur: typeof task.$inferSelect | undefined = taskRow;
  for (let depth = 0; cur && depth < 8; depth++) {
    const artifactId = (JSON.parse(cur.inputJson ?? '{}') as { doc_artifact?: string }).doc_artifact;
    if (artifactId) {
      const a = (await db.select().from(artifact).where(eq(artifact.id, artifactId)))[0];
      if (a?.type !== 'doc_handoff') return null;
      const meta = JSON.parse(a.metaJson ?? '{}') as { version?: number; path?: string; repo?: string; baseBlob?: string | null };
      let currentBlob: string | null = null;
      let currentContent: string | undefined;
      const dev = meta.repo ? (await db.select().from(workstation).where(eq(workstation.id, meta.repo)))[0] : undefined;
      const s = dev ? devSettings(dev.settingsJson) : null;
      if (s?.repoPath && s.repoPath !== '.' && meta.path) {
        const b = await git(s.repoPath, ['rev-parse', '--verify', '--quiet', `${s.targetBranch}:${meta.path}`]);
        if (b.code === 0) {
          currentBlob = b.stdout.trim();
          const show = await git(s.repoPath, ['show', `${s.targetBranch}:${meta.path}`]);
          if (show.code === 0) currentContent = show.stdout.slice(0, 60 * 1024);
        }
      }
      const baseBlob = meta.baseBlob ?? null;
      const changed = currentBlob !== baseBlob;
      return {
        title: a.name,
        version: meta.version,
        path: meta.path ?? '',
        content: a.ref ?? '',
        baseBlob,
        currentBlob,
        changedSinceHandoff: changed,
        ...(changed && currentContent !== undefined ? { currentContent } : {}),
        instructions: changed
          ? `目标分支上的 ${meta.path} 在交接后有改动：把现有内容（currentContent）里的修改合并进交接文本（content）再写入，不要直接覆盖`
          : `把 content 逐字写入 ${meta.path}`,
      };
    }
    cur = cur.parentId ? (await db.select().from(task).where(eq(task.id, cur.parentId)))[0] : undefined;
  }
  return null;
}

const PLATFORM_ACTOR: Actor = { type: 'human', id: 'local' };

// 交接对账：任务合并 → 已入库并记下发布提交；任务终止未合并 → 退回。幂等，合并路径和仓库巡检都会调
export async function reconcileDocHandoffs(db: DB) {
  const rows = await db.select().from(entity).where(eq(entity.entityType, 'Doc'));
  for (const row of rows) {
    const d = dataOf<DocData>(row);
    const h = d.handoff;
    if (d.status !== 'handed_off' || !h?.taskId || h.cancelled || h.publishedCommit) continue;
    const t = (await db.select().from(task).where(eq(task.id, h.taskId)))[0];
    if (!t) continue;
    const ref = t.codeRefJson ? (JSON.parse(t.codeRefJson) as { merge_sha?: string }) : null;
    const th = await wsThreadOf(db, row.workstationId);
    if (ref?.merge_sha) {
      let publishedBlob: string | null = null;
      const dev = (await db.select().from(workstation).where(eq(workstation.id, h.repo)))[0];
      const s = dev ? devSettings(dev.settingsJson) : null;
      if (s?.repoPath && s.repoPath !== '.') {
        const b = await git(s.repoPath, ['rev-parse', '--verify', '--quiet', `${ref.merge_sha}:${h.path}`]);
        if (b.code === 0) publishedBlob = b.stdout.trim();
      }
      await updateEntity(PLATFORM_ACTOR, db, row.id, {
        data: { ...d, status: 'published', handoff: { ...h, publishedCommit: ref.merge_sha, publishedBlob, publishedAt: now() } } as unknown as Record<string, unknown>,
        baseVersion: row.version,
        reason: '交接任务已合并',
      });
      await postMessage(db, th.id, PLATFORM, `文档《${d.title}》已随交接任务合并进 ${h.path}（${ref.merge_sha.slice(0, 8)}），状态拨为已入库`, 'status');
    } else if (t.status === 'cancelled' || t.status === 'done') {
      const back: DocStatus = d.review && d.review.contentHash === contentHashOf(d) ? 'approved' : 'draft';
      await updateEntity(PLATFORM_ACTOR, db, row.id, {
        data: { ...d, status: back, handoff: { ...h, cancelled: true } } as unknown as Record<string, unknown>,
        baseVersion: row.version,
        reason: '交接任务已终止',
      });
      await postMessage(db, th.id, PLATFORM, `文档《${d.title}》的交接任务已终止且未合并，退回「${back === 'approved' ? '已核准' : '草稿'}」`, 'status');
    }
  }
}

// ===== P4：引用漂移、反向漂移、合并影响、自动起草、发布说明 =====

export interface DriftItem { id: string; status: 'moved' | 'changed' | 'deleted'; newLines?: [number, number] | undefined; commit?: string | undefined }
export interface ReverseDrift { status: 'diverged' | 'deleted'; currentBlob: string | null; commit: string; notifiedBlob?: string | null | undefined }
export interface DocDrift {
  checkedAt: string;
  items: DriftItem[];
  reverse?: ReverseDrift | undefined;
  acknowledgedBlob?: string | null | undefined;
  // 已通知过的 changed/deleted 引用 id，集合扩张才再发收件箱
  notified?: string[] | undefined;
}

// 跳检缓存：docId:contentHash → 各引用仓库 head JSON。head 没变仓库引用不会有新漂移，
// 知识库引用没有可锚的版本，每轮都重查（纯库表，便宜）
const driftCache = new Map<string, string>();

export async function checkDocDrift(db: DB) {
  const rows = await db.select().from(entity).where(eq(entity.entityType, 'Doc'));
  for (const row of rows) {
    try {
      await checkDocDriftOne(db, row);
    } catch (e) {
      console.error('[doc-drift]', row.id, String(e));
    }
  }
}

const driftCmp = (x: { items: DriftItem[]; reverse?: ReverseDrift | undefined; acknowledgedBlob?: string | null | undefined; notified?: string[] | undefined } | undefined) =>
  JSON.stringify({ items: x?.items ?? [], reverse: x?.reverse ?? null, ack: x?.acknowledgedBlob ?? null, notified: [...(x?.notified ?? [])].sort() });

async function checkDocDriftOne(db: DB, row: EntityRow) {
  const d = dataOf<DocData>(row);
  const cits = d.citations ?? [];
  const repoCits = cits.filter((c): c is RepoCitation => c.kind === 'repo');
  const knowCits = cits.filter((c): c is KnowledgeCitation => c.kind === 'knowledge');
  const h = d.handoff;
  const watchingReverse = d.status === 'published' && !!h?.path && !!h.repo && h.publishedBlob !== undefined;
  if (repoCits.length === 0 && knowCits.length === 0 && !watchingReverse) return;

  // 相关仓库的目标分支 HEAD：引用仓库 + 已入库文档的交接仓库；绑不上/读不到就跳过（不计条目）
  const repoIds = [...new Set([...repoCits.map((c) => c.repo), ...(watchingReverse ? [h!.repo] : [])])];
  const heads = new Map<string, { commit: string; path: string }>();
  for (const rid of repoIds) {
    const ws = (await db.select().from(workstation).where(eq(workstation.id, rid)))[0];
    const s = ws ? devSettings(ws.settingsJson) : null;
    if (!s?.repoPath || s.repoPath === '.') continue;
    const r = await git(s.repoPath, ['rev-parse', '--verify', '--quiet', `${s.targetBranch}^{commit}`]);
    if (r.code === 0) heads.set(rid, { commit: r.stdout.trim(), path: s.repoPath });
  }

  const prev = d.drift;
  const prevItems = new Map((prev?.items ?? []).map((i) => [i.id, i]));
  const headsKey = JSON.stringify([...heads.entries()].map(([k, v]) => [k, v.commit]).sort());
  const cacheKey = `${row.id}:${contentHashOf(d)}`;
  const headsChanged = driftCache.get(cacheKey) !== headsKey;
  driftCache.set(cacheKey, headsKey);

  const items: DriftItem[] = [];
  for (const c of repoCits) {
    if (!headsChanged) {
      const keep = prevItems.get(c.id);
      if (keep) items.push(keep);
      continue;
    }
    const head = heads.get(c.repo);
    if (!head) continue;
    const blob = await git(head.path, ['rev-parse', '--verify', '--quiet', `${head.commit}:${c.path}`]);
    if (blob.code !== 0) {
      items.push({ id: c.id, status: 'deleted', commit: head.commit });
      continue;
    }
    if (blob.stdout.trim() === c.blob) continue;
    const show = await git(head.path, ['show', `${head.commit}:${c.path}`]);
    const fileLines = show.code === 0 ? show.stdout.split('\n') : null;
    const cls = classifyCitationDrift({ fileLines, lines: c.lines, matches: (s) => sha256(normalizeSnippet(s)) === c.snippetHash });
    if (cls.status === 'unchanged') continue;
    items.push({ id: c.id, status: cls.status, newLines: cls.newLines, commit: head.commit });
  }
  // 知识库引用：来源没了或引文在片段里找不到 → changed
  for (const c of knowCits) {
    const src = (await db.select().from(knowledgeSource).where(eq(knowledgeSource.id, c.sourceId)))[0];
    const want = strip(normalizeSnippet(c.excerpt));
    const chunks = src ? await db.select().from(knowledgeChunk).where(eq(knowledgeChunk.sourceId, src.id)) : [];
    const ok = !!want && chunks.some((ch) => strip(normalizeSnippet(ch.text)).includes(want));
    if (!ok) items.push({ id: c.id, status: 'changed' });
  }

  // 反向漂移：已入库文档的落点文件在目标分支上被绕过平台改过
  let reverse = prev?.reverse;
  const ack = prev?.acknowledgedBlob ?? null;
  if (watchingReverse) {
    const head = heads.get(h!.repo);
    if (head) {
      const blob = await git(head.path, ['rev-parse', '--verify', '--quiet', `${head.commit}:${h!.path}`]);
      const cur = blob.code === 0 ? blob.stdout.trim() : null;
      reverse = cur !== h!.publishedBlob && cur !== ack
        ? { status: cur === null ? 'deleted' : 'diverged', currentBlob: cur, commit: head.commit, notifiedBlob: prev?.reverse?.currentBlob === cur ? prev.reverse.notifiedBlob : undefined }
        : undefined;
    }
  } else {
    reverse = undefined;
  }

  const badIds = items.filter((i) => i.status !== 'moved').map((i) => i.id).sort();
  const prevNotified = new Set(prev?.notified ?? []);
  const newBad = badIds.filter((id) => !prevNotified.has(id));
  const nowStale = (d.status === 'approved' || d.status === 'published') && badIds.length > 0;
  const status: DocStatus = nowStale ? 'stale' : d.status ?? 'draft';
  // notified 只记真正发过通知的 id：草稿/核对中/已交接先攒着不记，转已核过/已入库后再过期才提醒
  const notified = [...prevNotified, ...(status === 'stale' ? newBad : [])].sort();
  const notifyReverse = !!reverse && reverse.currentBlob !== reverse.notifiedBlob;
  if (notifyReverse) reverse!.notifiedBlob = reverse!.currentBlob;

  const drift: DocDrift = { checkedAt: now(), items, ...(reverse ? { reverse } : {}), ...(ack ? { acknowledgedBlob: ack } : {}), ...(notified.length ? { notified } : {}) };
  const changed = status !== d.status || driftCmp(drift) !== driftCmp(prev);
  if (changed) {
    const r = await updateEntity(PLATFORM_ACTOR, db, row.id, { data: { ...d, status, drift } as unknown as Record<string, unknown>, baseVersion: row.version, reason: '引用漂移检查' });
    // 版本撞车就跳过：side effect 也不发，下一轮重算；先扔缓存不然一直拿旧条目
    if (r.kind !== 'ok') {
      driftCache.delete(cacheKey);
      return;
    }
  }

  const ws = (await db.select().from(workstation).where(eq(workstation.id, row.workstationId)))[0];
  const th = await wsThreadOf(db, row.workstationId);
  if (status === 'stale' && newBad.length > 0 && ws) {
    const badItems = items.filter((i) => i.status !== 'moved');
    if (d.status !== 'stale') await logEvent(db, PLATFORM_ACTOR, 'doc_stale', 'entity', row.id, { items: badIds });
    const lines = badItems.map((i) => {
      const c = cits.find((x) => x.id === i.id);
      const where = c?.kind === 'repo' ? `${c.path} 第 ${c.lines[0]}–${c.lines[1]} 行` : '知识库引用';
      return `${i.id}（${where}：${i.status === 'deleted' ? '文件已删除' : '内容已变更'}）`;
    });
    await postMessage(db, th.id, PLATFORM, `文档《${d.title}》引用的出处发生变化，状态拨为过时：${lines.join('；')}`, 'status');
    await pushInbox(db, ws.projectId, { kind: 'docs_drift', refType: 'entity', refId: row.id, payload: { wsId: row.workstationId, docId: row.id, docTitle: d.title, reason: `文档《${d.title}》引用的代码已变` } });
  }
  if (notifyReverse && ws) {
    await pushInbox(db, ws.projectId, { kind: 'docs_drift', refType: 'entity', refId: row.id, payload: { wsId: row.workstationId, docId: row.id, docTitle: d.title, reverse: true, reason: `文档《${d.title}》入库后的文件被直接改过` } });
  }
}

// moved 引用重指：行号/commit/blob 换成 head 上的新位置；身份字段不变 → 核对不作废。
// 不走 writeDoc：不靠内容哈希判断，直接按版本更新，漂移条目一并摘掉
export async function repointDocDrift(actor: Actor, db: DB, docId: string) {
  const row = await docRow(db, docId);
  if (!row) return { kind: 'not_found' as const, status: 404 as const, error: '文档不存在' };
  const d = dataOf<DocData>(row);
  const moved = (d.drift?.items ?? []).filter((i) => i.status === 'moved' && i.newLines && i.commit);
  if (moved.length === 0) return { kind: 'ok' as const, updated: 0 };
  const updates = new Map<string, { lines: [number, number]; commit: string; blob: string }>();
  for (const m of moved) {
    const c = (d.citations ?? []).find((x) => x.id === m.id);
    if (!c || c.kind !== 'repo') continue;
    const ws = (await db.select().from(workstation).where(eq(workstation.id, c.repo)))[0];
    const s = ws ? devSettings(ws.settingsJson) : null;
    if (!s?.repoPath || s.repoPath === '.') continue;
    const b = await git(s.repoPath, ['rev-parse', '--verify', '--quiet', `${m.commit}:${c.path}`]);
    if (b.code !== 0) continue;
    updates.set(c.id, { lines: m.newLines!, commit: m.commit!, blob: b.stdout.trim() });
  }
  if (updates.size === 0) return { kind: 'ok' as const, updated: 0 };
  const citations = (d.citations ?? []).map((c) => (updates.has(c.id) ? { ...c, ...updates.get(c.id)! } : c));
  const drift = d.drift ? { ...d.drift, items: d.drift.items.filter((i) => !updates.has(i.id)), checkedAt: now() } : d.drift;
  const r = await updateEntity(actor, db, docId, { data: { ...d, citations, drift } as unknown as Record<string, unknown>, baseVersion: row.version, reason: '引用行号重指' });
  return r.kind === 'ok' ? { kind: 'ok' as const, updated: updates.size } : r;
}

// 确认入库后被直接改的文件：记下已确认的 blob，摘掉 reverse
export async function ackDocReverse(actor: Actor, db: DB, docId: string) {
  const row = await docRow(db, docId);
  if (!row) return { kind: 'not_found' as const, status: 404 as const, error: '文档不存在' };
  const d = dataOf<DocData>(row);
  const rev = d.drift?.reverse;
  if (!rev) return { kind: 'error' as const, status: 400 as const, error: '没有待确认的入库改动' };
  const drift: DocDrift = { checkedAt: now(), items: d.drift?.items ?? [], acknowledgedBlob: rev.currentBlob, ...(d.drift?.notified?.length ? { notified: d.drift.notified } : {}) };
  const r = await updateEntity(actor, db, docId, { data: { ...d, drift } as unknown as Record<string, unknown>, baseVersion: row.version, reason: '确认入库外改动' });
  return r.kind === 'ok' ? { kind: 'ok' as const } : r;
}

// 把入库后被直接改的内容导回成新版本：正文换成仓库里的现文，正文里已没有 [^id] 的引用摘掉
export async function importDocReverse(actor: Actor, db: DB, docId: string) {
  const row = await docRow(db, docId);
  if (!row) return { kind: 'not_found' as const, status: 404 as const, error: '文档不存在' };
  const d = dataOf<DocData>(row);
  const h = d.handoff;
  if (!h?.path || !h.repo) return { kind: 'error' as const, status: 400 as const, error: '文档没有交接落点' };
  const ws = (await db.select().from(workstation).where(eq(workstation.id, h.repo)))[0];
  const s = ws ? devSettings(ws.settingsJson) : null;
  if (!s?.repoPath || s.repoPath === '.') return { kind: 'error' as const, status: 400 as const, error: '目标仓库不可用' };
  const show = await git(s.repoPath, ['show', `${s.targetBranch}:${h.path}`]);
  if (show.code !== 0) return { kind: 'error' as const, status: 400 as const, error: '目标分支上读不到该文件' };
  const refs = new Set(citationRefs(show.stdout));
  const citations = (d.citations ?? []).filter((c) => refs.has(c.id));
  const r = await writeDoc(actor, db, row.workstationId, { id: docId, content: show.stdout, citations, reason: '从仓库导回' });
  if (r.kind !== 'ok') return r;
  const blob = await git(s.repoPath, ['rev-parse', '--verify', '--quiet', `${s.targetBranch}:${h.path}`]);
  const row2 = await docRow(db, docId);
  const d2 = row2 ? dataOf<DocData>(row2) : d;
  const drift: DocDrift = { checkedAt: now(), items: d2.drift?.items ?? [], acknowledgedBlob: blob.code === 0 ? blob.stdout.trim() : null, ...(d2.drift?.notified?.length ? { notified: d2.drift.notified } : {}) };
  await updateEntity(actor, db, docId, { data: { ...d2, drift } as unknown as Record<string, unknown>, baseVersion: row2!.version, reason: '确认入库外改动' });
  return { kind: 'ok' as const, version: r.version, status: r.status, lint: r.lint };
}

// 合并影响：开发任务合进目标分支后，看它动了哪些文件、哪些文档引用/落点在里边。
// base 取 merge_sha^1（合并提交第一父 = 合并前的目标分支头）
export async function noteMergeImpact(db: DB, taskId: string) {
  const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
  const ref = t?.codeRefJson ? (JSON.parse(t.codeRefJson) as { merge_sha?: string }) : null;
  if (!t || !ref?.merge_sha) return;
  const dev = (await db.select().from(workstation).where(eq(workstation.id, t.workstationId)))[0];
  const s = dev ? devSettings(dev.settingsJson) : null;
  if (!dev || !s?.repoPath || s.repoPath === '.') return;
  const docsWs = (await db.select().from(workstation).where(and(eq(workstation.projectId, dev.projectId), eq(workstation.pluginId, 'docs'))))[0];
  if (!docsWs) return;
  const diff = await git(s.repoPath, ['diff', '--name-only', `${ref.merge_sha}^1`, ref.merge_sha]);
  if (diff.code !== 0) return;
  const files = new Set(diff.stdout.split('\n').filter(Boolean));
  const hitCits = (d: DocData) => (d.citations ?? []).filter((c): c is RepoCitation => c.kind === 'repo' && c.repo === dev.id && files.has(c.path));
  const impacted = (await ofType(db, docsWs.id, 'Doc'))
    .map((row) => ({ row, d: dataOf<DocData>(row) }))
    .filter(({ d }) => d.handoff?.taskId !== taskId && (hitCits(d).length > 0 || (d.target_repo === dev.id && !!d.target_path && files.has(d.target_path))))
    .map(({ row, d }) => ({ id: row.id, title: d.title, citations: hitCits(d).map((c) => c.id) }));
  if (impacted.length === 0) return;
  await logEvent(db, PLATFORM_ACTOR, 'doc_impact', 'workstation', docsWs.id, { taskId, taskTitle: t.title, docs: impacted.slice(0, 10) });
  const settings = JSON.parse(docsWs.settingsJson ?? '{}') as { autoDraft?: 'off' | 'affected' };
  const fmt = impacted.slice(0, 10).map((x) => (x.citations.length ? `《${x.title}》（${x.id}，引用 ${x.citations.join('、')}）` : `《${x.title}》（${x.id}）`)).join('、');
  const th = await wsThreadOf(db, docsWs.id);
  if (settings.autoDraft === 'affected') {
    const fileList = [...files].slice(0, 30).join('、');
    await postThreadMessage(PLATFORM_ACTOR, db, th.id, `@主笔 开发任务「${t.title}」（${taskId}）已合并，改动了这些文件：${fileList}；请检查并更新：${fmt}，每篇用 edit_doc 出新版本草稿，不要交接。`);
  } else {
    await postMessage(db, th.id, PLATFORM, `开发任务「${t.title}」已合并，可能影响：${fmt}`, 'status');
  }
}

export async function docsSettingsOf(db: DB, wsId: string) {
  const ws = (await db.select().from(workstation).where(eq(workstation.id, wsId)))[0];
  if (!ws || ws.pluginId !== 'docs') return null;
  return { autoDraft: (JSON.parse(ws.settingsJson ?? '{}') as { autoDraft?: string }).autoDraft === 'affected' ? ('affected' as const) : ('off' as const) };
}

export async function saveDocsSettings(actor: Actor, db: DB, wsId: string, input: { autoDraft: 'off' | 'affected' }) {
  const ws = (await db.select().from(workstation).where(eq(workstation.id, wsId)))[0];
  if (!ws || ws.pluginId !== 'docs') return { kind: 'not_found' as const, status: 404 as const, error: '文档工作台不存在' };
  const settings = JSON.parse(ws.settingsJson ?? '{}') as Record<string, unknown>;
  settings.autoDraft = input.autoDraft;
  await db.update(workstation).set({ settingsJson: JSON.stringify(settings) }).where(eq(workstation.id, wsId));
  await logEvent(db, actor, 'doc_settings', 'workstation', wsId, { autoDraft: input.autoDraft });
  return { kind: 'ok' as const };
}

// 健康面板数据：漂移条目补上引用原文与当前文件同区间文本，另附最近合并影响事件
export async function docHealth(db: DB, wsId: string) {
  const rows = await ofType(db, wsId, 'Doc');
  const docs = [];
  for (const row of rows) {
    const d = dataOf<DocData>(row);
    const drift = d.drift;
    if (!drift?.items?.length && !drift?.reverse) continue;
    const items = [];
    for (const i of drift.items ?? []) {
      const c = (d.citations ?? []).find((x) => x.id === i.id);
      let current: string | null = null;
      if (c?.kind === 'repo' && i.status !== 'deleted' && i.commit) {
        const ws = (await db.select().from(workstation).where(eq(workstation.id, c.repo)))[0];
        const s = ws ? devSettings(ws.settingsJson) : null;
        if (s?.repoPath && s.repoPath !== '.') {
          const show = await git(s.repoPath, ['show', `${i.commit}:${c.path}`]);
          if (show.code === 0) {
            const ls = show.stdout.split('\n');
            const [a, b] = i.newLines ?? c.lines;
            current = ls.slice(a - 1, Math.min(b, ls.length)).join('\n');
          }
        }
      }
      items.push({ id: i.id, status: i.status, newLines: i.newLines ?? null, path: c?.kind === 'repo' ? c.path : null, lines: c?.kind === 'repo' ? c.lines : null, excerpt: c?.excerpt ?? null, current });
    }
    docs.push({ id: row.id, title: d.title, status: d.status ?? 'draft', items, reverse: drift.reverse ?? null, path: d.handoff?.path ?? null });
  }
  const impacts = (await db.select().from(eventLog).where(and(eq(eventLog.action, 'doc_impact'), eq(eventLog.targetId, wsId))))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 20)
    .map((e) => ({ at: e.createdAt, ...(JSON.parse(e.payloadJson ?? '{}') as { taskId?: string; taskTitle?: string; docs?: { id: string; title: string; citations: string[] }[] }) }));
  return { docs, impacts };
}

// 发布说明草稿：把范围内已合并的开发任务整理给主笔，会话里出稿子
export async function draftReleaseNotes(actor: Actor, db: DB, wsId: string, input: { milestoneId?: string | undefined; since?: string | undefined; until?: string | undefined }) {
  const ws = (await db.select().from(workstation).where(eq(workstation.id, wsId)))[0];
  if (!ws || ws.pluginId !== 'docs') return { kind: 'not_found' as const, status: 404 as const, error: '文档工作台不存在' };
  if ((input.milestoneId ? 1 : 0) + (input.since ? 1 : 0) !== 1) return err('里程碑和时间范围二选一');
  const devs = await db.select().from(workstation).where(and(eq(workstation.projectId, ws.projectId), eq(workstation.pluginId, 'dev')));
  const names = new Map(devs.map((w) => [w.id, w.name]));
  const merged = (await db.select().from(task).where(inArray(task.workstationId, devs.map((w) => w.id))))
    .filter((t) => (JSON.parse(t.codeRefJson ?? '{}') as { merge_sha?: string }).merge_sha);
  let scoped: typeof merged;
  let name: string;
  if (input.milestoneId) {
    scoped = merged.filter((t) => t.milestoneId === input.milestoneId);
    const m = (await db.select().from(entity).where(eq(entity.id, input.milestoneId)))[0];
    name = m ? `里程碑「${(JSON.parse(m.dataJson ?? '{}') as { name?: string }).name ?? input.milestoneId}」` : input.milestoneId;
  } else {
    // 合并时间看 proposal_merged 事件（task 只有创建时间，没有合并时间列）：proposal → task 映射回任务
    const mrows = await db.select().from(eventLog).where(eq(eventLog.action, 'proposal_merged'));
    const pids = mrows.map((e) => e.targetId).filter((x): x is string => !!x);
    const props = pids.length ? await db.select().from(proposal).where(inArray(proposal.id, pids)) : [];
    const taskOf = new Map(props.filter((p) => p.taskId).map((p) => [p.id, p.taskId!]));
    const mergedAt = new Map<string, string>();
    for (const e of mrows) {
      const tid = e.targetId ? taskOf.get(e.targetId) : undefined;
      if (tid && e.createdAt > (mergedAt.get(tid) ?? '')) mergedAt.set(tid, e.createdAt);
    }
    scoped = merged.filter((t) => {
      const at = mergedAt.get(t.id);
      return !!at && at >= input.since! && (!input.until || at <= input.until);
    });
    name = `${input.since!.slice(0, 10)} 以来${input.until ? `至 ${input.until.slice(0, 10)}` : ''}`;
  }
  if (scoped.length === 0) return err('这个范围里没有已合并的任务');
  const lines = scoped.slice(0, 80).map((t) => {
    const inp = JSON.parse(t.inputJson ?? '{}') as { title?: string; kind?: string; module?: string };
    const sha = (JSON.parse(t.codeRefJson ?? '{}') as { merge_sha?: string }).merge_sha!.slice(0, 8);
    const intent = (t.intent ?? '').split('\n')[0]!.slice(0, 120);
    return `${inp.title ?? t.title}（${inp.kind ?? 'chore'} · ${inp.module ?? '-'} · ${names.get(t.workstationId) ?? t.workstationId} · ${sha}）${intent ? `：${intent}` : ''}`;
  });
  const th = await wsThreadOf(db, wsId);
  await postThreadMessage(actor, db, th.id, `@主笔 请起草发布说明《${name}》：kind 用 release_notes，按新增 / 改进 / 修复 / 其他分组，面向使用者写，不要逐条照抄任务标题；下面是这个范围内已合并的任务：\n${lines.map((l) => `- ${l}`).join('\n')}`);
  return { kind: 'ok' as const, count: scoped.length };
}

import type { Actor } from '@aw/domain';
import { assetKindOfName, type AssetKind } from '@aw/domain';
import { and, desc, eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from '../db/client.js';
import { artifact, entity, entityVersion } from '../db/schema.js';
import { ffprobe, runFfmpeg } from '../runtime/media/ffmpeg.js';
import { mediaDir, mimeOf, saveMediaArtifact } from '../runtime/media/storage.js';
import { logEvent } from './core.js';
import { createEntity, updateEntity } from './entities.js';

const err = (error: string, status: 400 | 404 | 409 | 413 | 415 = 400) => ({ kind: 'error' as const, status, error });
const notFound = () => ({ kind: 'not_found' as const, status: 404 as const, error: '素材不存在' });
const dataOf = <T,>(e: { dataJson: string | null }) => JSON.parse(e.dataJson ?? '{}') as T;

export interface AssetData {
  name: string;
  kind: AssetKind;
  source: 'upload' | 'generated';
  artifact: string;
  mime?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
  duration?: number | undefined;
  poster?: string | undefined;
  prompt?: string | undefined;
  provider?: string | undefined;
  license?: string | undefined;
  tags?: string[] | undefined;
  notes?: string | undefined;
}

export const ASSET_IMAGE_MAX = 20 * 1024 * 1024;
export const ASSET_VIDEO_MAX = 200 * 1024 * 1024;
export const ASSET_AUDIO_MAX = 30 * 1024 * 1024;
export const ASSET_VIDEO_MAX_SECONDS = 300;
// 一次生成的片段最长多少秒（厂商普遍限制在 10 秒上下，这里留一点余量）
export const CLIP_MAX_SECONDS = 20;
export const CLIP_MIN_SECONDS = 1;

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp'] as const;
const VIDEO_EXT = ['mp4', 'webm', 'mov'] as const;
const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'ogg'] as const;

const at = (buf: Uint8Array, i: number, s: string) => [...s].every((ch, k) => buf[i + k] === ch.charCodeAt(0));

export function sniffImage(buf: Uint8Array): 'png' | 'jpg' | 'webp' | null {
  if (buf.length < 16) return null;
  if (buf[0] === 0x89 && at(buf, 1, 'PNG')) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (at(buf, 0, 'RIFF') && at(buf, 8, 'WEBP')) return 'webp';
  return null;
}

// 只认容器头：扩展名和内容对不上的一律拒收（model 上传的文件也按不可信处理）
export function sniffVideo(buf: Uint8Array): 'mp4' | 'mov' | 'webm' | null {
  if (buf.length < 16) return null;
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm';
  if (at(buf, 4, 'ftyp')) {
    const brand = String.fromCharCode(...buf.subarray(8, 12));
    return brand === 'qt  ' ? 'mov' : 'mp4';
  }
  return null;
}

export function sniffAudio(buf: Uint8Array): 'mp3' | 'wav' | 'm4a' | 'ogg' | null {
  if (buf.length < 12) return null;
  if (at(buf, 0, 'RIFF') && at(buf, 8, 'WAVE')) return 'wav';
  if (at(buf, 0, 'OggS')) return 'ogg';
  if (at(buf, 4, 'ftyp')) return 'm4a';
  if (at(buf, 0, 'ID3') || (buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0)) return 'mp3';
  return null;
}

const extOf = (name: string) => path.extname(name).slice(1).toLowerCase();
const round3 = (n: number) => Math.round(n * 1000) / 1000;

interface Probed { width?: number | undefined; height?: number | undefined; duration?: number | undefined }

async function probeMedia(file: string): Promise<Probed> {
  const r = await ffprobe(file);
  const v = r.streams.find((s) => s.codec_type === 'video');
  const d = Number(r.format.duration ?? r.streams.find((s) => s.duration)?.duration);
  return { width: v?.width, height: v?.height, duration: Number.isFinite(d) && d > 0 ? round3(d) : undefined };
}

// 视频海报：取 0.5 秒的一帧（太短的片段取第 0 帧）
async function makePoster(db: DB, wsId: string, file: string, name: string, duration: number | undefined) {
  const target = path.join(mediaDir(db, 'assets'), `${crypto.randomUUID()}.png`);
  const seek = duration !== undefined && duration > 0.6 ? '0.5' : '0';
  try {
    await runFfmpeg(['-y', '-ss', seek, '-i', file, '-frames:v', '1', '-vf', 'scale=640:-2', target]);
  } catch {
    return null;
  }
  if (!fs.existsSync(target)) return null;
  return saveMediaArtifact(db, { workstationId: wsId, type: 'image', name: `${name} 封面`, file: target, meta: { kind: 'poster' } });
}

// 上传素材：只收 png / jpeg / webp（≤20MB）、mp4 / webm / mov（≤200MB 且不超过 5 分钟）、mp3 / wav / m4a / ogg（≤30MB）；
// 文件头要跟扩展名对得上，再用 ffprobe 读出尺寸 / 时长
export async function uploadAsset(actor: Actor, db: DB, wsId: string, input: { name: string; bytes: Uint8Array; license?: string | undefined; tags?: string[] | undefined; notes?: string | undefined }) {
  const ext = extOf(input.name);
  const kind = assetKindOfName(input.name);
  if (!kind) return err('只支持 png / jpeg / webp 图片、mp4 / webm / mov 视频和 mp3 / wav / m4a / ogg 音频', 415);
  if (input.bytes.byteLength === 0) return err('文件是空的');
  const max = kind === 'image' ? ASSET_IMAGE_MAX : kind === 'video' ? ASSET_VIDEO_MAX : ASSET_AUDIO_MAX;
  if (input.bytes.byteLength > max) return err(`${kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'}最大 ${Math.round(max / 1024 / 1024)}MB`, 413);
  const sniffed = kind === 'image' ? sniffImage(input.bytes) : kind === 'video' ? sniffVideo(input.bytes) : sniffAudio(input.bytes);
  const allowed: readonly string[] = kind === 'image' ? IMAGE_EXT : kind === 'video' ? VIDEO_EXT : AUDIO_EXT;
  if (!(allowed as readonly string[]).includes(ext)) return err(`${kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'}的扩展名只能是 ${allowed.join(' / ')}`, 415);
  if (!sniffed) return err('文件内容不是可识别的媒体文件', 415);
  if (sniffed !== ext && !(sniffed === 'm4a' && ext === 'm4a')) return err(`文件内容是 ${sniffed}，和扩展名 .${ext} 不一致`, 415);
  const id = crypto.randomUUID();
  const file = path.join(mediaDir(db, 'assets'), `${id}.${ext}`);
  fs.writeFileSync(file, input.bytes);
  let probed: Probed;
  try {
    probed = await probeMedia(file);
  } catch {
    fs.rmSync(file, { force: true });
    return err('读不出这个文件的画面 / 时长，可能已经损坏');
  }
  if (kind !== 'audio' && (!probed.width || !probed.height)) {
    fs.rmSync(file, { force: true });
    return err('读不出画面尺寸，文件可能损坏');
  }
  if (kind === 'video' && probed.duration !== undefined && probed.duration > ASSET_VIDEO_MAX_SECONDS) {
    fs.rmSync(file, { force: true });
    return err(`视频最长 ${ASSET_VIDEO_MAX_SECONDS / 60} 分钟（这个 ${Math.round(probed.duration)} 秒）`);
  }
  const base = path.basename(input.name, path.extname(input.name)).slice(0, 60) || '素材';
  const artifactId = await saveMediaArtifact(db, { workstationId: wsId, type: kind === 'image' ? 'image' : kind === 'video' ? 'video' : 'audio', name: base, file, meta: { kind: 'asset', duration: probed.duration, width: probed.width, height: probed.height, downloadName: `${base}.${ext}` } });
  const poster = kind === 'video' ? await makePoster(db, wsId, file, base, probed.duration) : null;
  const data: AssetData = {
    name: base, kind, source: 'upload', artifact: artifactId, mime: mimeOf(file), width: probed.width, height: probed.height,
    duration: probed.duration, ...(poster ? { poster } : {}), ...(input.license?.trim() ? { license: input.license.trim().slice(0, 500) } : {}),
    ...(input.tags?.length ? { tags: input.tags.slice(0, 20) } : {}), ...(input.notes?.trim() ? { notes: input.notes.trim().slice(0, 2000) } : {}),
  };
  const r = await createEntity(actor, db, wsId, { entityType: 'Asset', data: data as unknown as Record<string, unknown>, reason: '上传素材' });
  if (r.kind !== 'ok') return r;
  await logEvent(db, actor, 'video_asset', 'entity', r.id, { kind, source: 'upload', duration: probed.duration ?? null, bytes: input.bytes.byteLength });
  return { kind: 'ok' as const, id: r.id, assetKind: kind, width: probed.width, height: probed.height, duration: probed.duration, poster };
}

// 生成成功后由平台登记的素材：文件已经在媒体目录里，只要元数据
export async function saveGeneratedAsset(actor: Actor, db: DB, wsId: string, input: { name: string; file: string; prompt: string; provider: string; duration: number; width: number; height: number }) {
  const artifactId = await saveMediaArtifact(db, { workstationId: wsId, type: 'video', name: input.name, file: input.file, meta: { kind: 'asset', generated: true, duration: input.duration, width: input.width, height: input.height, downloadName: `${input.name}.mp4` } });
  const poster = await makePoster(db, wsId, input.file, input.name, input.duration);
  const data: AssetData = {
    name: input.name.slice(0, 60), kind: 'video', source: 'generated', artifact: artifactId, mime: mimeOf(input.file),
    width: input.width, height: input.height, duration: round3(input.duration), prompt: input.prompt.slice(0, 4000), provider: input.provider,
    ...(poster ? { poster } : {}),
  };
  const r = await createEntity(actor, db, wsId, { entityType: 'Asset', data: data as unknown as Record<string, unknown>, reason: '生成片段' });
  if (r.kind !== 'ok') return { kind: 'error' as const, status: 400 as const, error: r.error };
  await logEvent(db, actor, 'video_asset', 'entity', r.id, { kind: 'video', source: 'generated', duration: data.duration ?? null, provider: input.provider });
  return { kind: 'ok' as const, id: r.id, artifactId };
}

export const assetRow = async (db: DB, id: string) => {
  const e = (await db.select().from(entity).where(eq(entity.id, id)))[0];
  return e?.entityType === 'Asset' ? e : undefined;
};

// 素材文件及其真实规格：渲染要用文件路径、尺寸、时长，缺文件时返回 null
export async function assetMediaOf(db: DB, wsId: string, id: string) {
  const row = await assetRow(db, id);
  if (!row || row.workstationId !== wsId) return null;
  const d = dataOf<AssetData>(row);
  const a = (await db.select().from(artifact).where(eq(artifact.id, d.artifact)))[0];
  if (!a?.ref || !fs.existsSync(a.ref)) return null;
  const stat = fs.statSync(a.ref);
  return {
    id: row.id, data: d, artifactId: a.id, file: a.ref, kind: d.kind, width: d.width ?? 0, height: d.height ?? 0,
    duration: d.duration ?? null, size: stat.size, mtime: stat.mtimeMs,
  };
}

// 素材被哪些镜头用着：删除前要挡住，界面上要能点回镜头
export async function assetUsage(db: DB, wsId: string, assetId: string) {
  const shots = await db.select().from(entity).where(and(eq(entity.workstationId, wsId), eq(entity.entityType, 'Shot')));
  const used: { shotId: string; videoId: string; title: string }[] = [];
  for (const s of shots) {
    const d = JSON.parse(s.dataJson ?? '{}') as { asset?: string; video?: string; title?: string; order?: number };
    if (d.asset === assetId) used.push({ shotId: s.id, videoId: d.video ?? '', title: d.title || `镜头 ${d.order ?? ''}`.trim() });
  }
  return used;
}

export async function listAssets(db: DB, wsId: string, filter: { kind?: string | undefined } = {}) {
  const rows = await db.select().from(entity).where(and(eq(entity.workstationId, wsId), eq(entity.entityType, 'Asset'))).orderBy(desc(entity.createdAt));
  const shots = await db.select().from(entity).where(and(eq(entity.workstationId, wsId), eq(entity.entityType, 'Shot')));
  const usedBy = new Map<string, number>();
  for (const s of shots) {
    const d = JSON.parse(s.dataJson ?? '{}') as { asset?: string };
    if (d.asset) usedBy.set(d.asset, (usedBy.get(d.asset) ?? 0) + 1);
  }
  return rows
    .map((r) => {
      const d = dataOf<AssetData>(r);
      return {
        id: r.id, name: d.name, kind: d.kind, source: d.source, artifactId: d.artifact, mime: d.mime ?? '', width: d.width ?? null, height: d.height ?? null,
        duration: d.duration ?? null, poster: d.poster ?? null, prompt: d.prompt ?? '', provider: d.provider ?? '', license: d.license ?? '',
        tags: d.tags ?? [], notes: d.notes ?? '', used: usedBy.get(r.id) ?? 0, createdAt: r.createdAt, updatedAt: r.updatedAt,
      };
    })
    .filter((a) => !filter.kind || a.kind === filter.kind);
}

export async function getAsset(db: DB, wsId: string, id: string) {
  const row = await assetRow(db, id);
  if (!row || row.workstationId !== wsId) return null;
  const d = dataOf<AssetData>(row);
  return {
    id: row.id, version: row.version, name: d.name, kind: d.kind, source: d.source, artifactId: d.artifact, mime: d.mime ?? '',
    width: d.width ?? null, height: d.height ?? null, duration: d.duration ?? null, poster: d.poster ?? null, prompt: d.prompt ?? '',
    provider: d.provider ?? '', license: d.license ?? '', tags: d.tags ?? [], notes: d.notes ?? '', createdAt: row.createdAt, updatedAt: row.updatedAt,
    usedBy: await assetUsage(db, wsId, row.id),
  };
}

export async function updateAsset(actor: Actor, db: DB, wsId: string, id: string, input: { name?: string | undefined; license?: string | undefined; tags?: string[] | undefined; notes?: string | undefined; baseVersion?: number | undefined }) {
  const row = await assetRow(db, id);
  if (!row || row.workstationId !== wsId) return notFound();
  const { baseVersion, ...patch } = input;
  if (patch.name !== undefined && !patch.name.trim()) return err('素材名不能为空');
  const d = dataOf<AssetData>(row);
  const data: AssetData = { ...d, name: patch.name?.trim() ?? d.name, ...(patch.license !== undefined ? { license: patch.license.trim().slice(0, 500) } : {}), ...(patch.tags !== undefined ? { tags: patch.tags.slice(0, 20) } : {}), ...(patch.notes !== undefined ? { notes: patch.notes.slice(0, 2000) } : {}) };
  const r = await updateEntity(actor, db, id, { data: data as unknown as Record<string, unknown>, baseVersion: baseVersion ?? row.version, reason: '改素材信息' });
  return r.kind === 'ok' ? { kind: 'ok' as const, id, version: r.version } : r;
}

// 删除素材：还被镜头用着就挡住，先说清楚是哪几个镜头
export async function deleteAsset(actor: Actor, db: DB, wsId: string, id: string) {
  const row = await assetRow(db, id);
  if (!row || row.workstationId !== wsId) return notFound();
  const used = await assetUsage(db, wsId, id);
  if (used.length) return err(`还有 ${used.length} 个镜头在用这件素材：${used.slice(0, 3).map((u) => u.title).join('、')}${used.length > 3 ? ' 等' : ''}`, 409);
  await db.delete(entityVersion).where(eq(entityVersion.entityId, id));
  await db.delete(entity).where(eq(entity.id, id));
  await logEvent(db, actor, 'video_asset_deleted', 'entity', id, { name: dataOf<AssetData>(row).name });
  return { kind: 'ok' as const };
}

// 给 Agent 看的一行摘要
export async function assetContextOf(db: DB, wsId: string) {
  const list = await listAssets(db, wsId);
  if (list.length === 0) return '本台还没有素材（可以在素材面板上传，或用 generate_clip 申请生成）';
  return list.map((a) => `- ${a.name}（asset: ${a.id}）${a.kind === 'image' ? '图片' : a.kind === 'video' ? '视频' : '音频'} · ${a.width ?? '?'}×${a.height ?? '?'}${a.duration ? ` · ${a.duration}s` : ''} · ${a.source === 'generated' ? '生成' : '上传'}${a.used ? ` · 用在 ${a.used} 个镜头` : ''}`).join('\n');
}

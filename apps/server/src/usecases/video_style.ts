import { lookError, type Actor, type SubtitleLook, type VideoFonts, type VideoPalette } from '@aw/domain';
import { and, desc, eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from '../db/client.js';
import { artifact } from '../db/schema.js';
import { probeDuration } from '../runtime/media/ffmpeg.js';
import { mediaDir, saveMediaArtifact } from '../runtime/media/storage.js';
import type { VoicePref } from '../runtime/media/tts.js';
import { logEvent } from './core.js';
import { createEntity, updateEntity } from './entities.js';
import { refreshWorkstationVideos, videoStyleOf, type VideoStyleData } from './videos.js';

const err = (error: string, status: 400 | 404 | 409 | 413 = 400) => ({ kind: 'error' as const, status, error });

export interface VideoStylePatch {
  name?: string | undefined;
  palette?: VideoPalette | undefined;
  fonts?: VideoFonts | undefined;
  voice?: VoicePref | null | undefined;
  bgm?: string | null | undefined;
  bgmVolume?: number | undefined;
  ducking?: boolean | undefined;
  rules?: string | undefined;
  subtitle?: SubtitleLook | undefined;
}

const SIZES = ['s', 'm', 'l'];
const POSITIONS = ['bottom', 'top'];
const BACKGROUNDS = ['box', 'shadow', 'none'];

async function bgmArtifact(db: DB, wsId: string, id: string) {
  const a = (await db.select().from(artifact).where(eq(artifact.id, id)))[0];
  if (!a || a.workstationId !== wsId || a.type !== 'audio') return null;
  const meta = JSON.parse(a.metaJson ?? '{}') as { kind?: string };
  return meta.kind === 'bgm' ? a : null;
}

function patchError(p: VideoStylePatch): string | null {
  if (p.name !== undefined && (!p.name.trim() || p.name.length > 40)) return '风格名要 1 到 40 个字';
  const look = lookError({ palette: p.palette, fonts: p.fonts });
  if (look) return look;
  if (p.voice?.speed !== undefined && !(p.voice.speed >= 0.25 && p.voice.speed <= 4)) return '语速要在 0.25 到 4 之间';
  if (p.bgmVolume !== undefined && !(p.bgmVolume >= 0 && p.bgmVolume <= 1)) return '背景音乐音量要在 0 到 1 之间';
  if (p.rules !== undefined && p.rules.length > 20000) return '风格规则最多 20000 字';
  const s = p.subtitle;
  if (s && ((s.size !== undefined && !SIZES.includes(s.size)) || (s.position !== undefined && !POSITIONS.includes(s.position)) || (s.background !== undefined && !BACKGROUNDS.includes(s.background)))) {
    return '字幕样式：size 只能是 s/m/l，position 只能是 bottom/top，background 只能是 box/shadow/none';
  }
  return null;
}

// 本台风格：一台一份，第一次保存才落库；改了风格会影响所有视频的内容哈希（审片作废），保存后逐个重算状态
export async function saveVideoStyle(actor: Actor, db: DB, wsId: string, input: VideoStylePatch & { baseVersion?: number | undefined; reason?: string | undefined }) {
  const { baseVersion, reason, ...patch } = input;
  const bad = patchError(patch);
  if (bad) return err(bad);
  if (patch.bgm && !(await bgmArtifact(db, wsId, patch.bgm))) return err('背景音乐不存在（先上传）');
  const cur = await videoStyleOf(db, wsId);
  const data: VideoStyleData = {
    name: patch.name?.trim() ?? cur.name,
    palette: patch.palette ?? cur.palette,
    fonts: patch.fonts ?? cur.fonts,
    ...((patch.voice === undefined ? cur.voice : patch.voice) ? { voice: (patch.voice === undefined ? cur.voice : patch.voice)! } : {}),
    bgm: patch.bgm === undefined ? cur.bgm : patch.bgm,
    bgmVolume: patch.bgmVolume ?? cur.bgmVolume,
    ducking: patch.ducking ?? cur.ducking,
    rules: patch.rules ?? cur.rules,
    subtitle: patch.subtitle ?? cur.subtitle,
  };
  const r = cur.id
    ? await updateEntity(actor, db, cur.id, { data: data as unknown as Record<string, unknown>, baseVersion: baseVersion ?? cur.version, reason: reason ?? '改风格' })
    : await createEntity(actor, db, wsId, { entityType: 'VideoStyle', data: data as unknown as Record<string, unknown>, reason: reason ?? '设定风格' });
  if (r.kind !== 'ok') return r;
  await logEvent(db, actor, 'video_style', 'entity', r.id, {});
  await refreshWorkstationVideos(actor, db, wsId);
  return { kind: 'ok' as const, ...(await videoStyleOf(db, wsId)) };
}

export const BGM_MAX_BYTES = 30 * 1024 * 1024;
const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'ogg'] as const;
type AudioExt = (typeof AUDIO_EXT)[number];

// 只认文件头：扩展名和内容对不上的一律拒收
export function sniffAudio(buf: Uint8Array): AudioExt | null {
  const at = (i: number, s: string) => [...s].every((ch, k) => buf[i + k] === ch.charCodeAt(0));
  if (buf.length < 12) return null;
  if (at(0, 'RIFF') && at(8, 'WAVE')) return 'wav';
  if (at(0, 'OggS')) return 'ogg';
  if (at(4, 'ftyp')) return 'm4a';
  if (at(0, 'ID3') || (buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0)) return 'mp3';
  return null;
}

// 上传背景音乐：只收 mp3 / wav / m4a / ogg，30MB 以内，文件头要对得上，ffprobe 读得出时长
export async function uploadBgm(actor: Actor, db: DB, wsId: string, input: { name: string; bytes: Uint8Array }) {
  const ext = path.extname(input.name).slice(1).toLowerCase();
  if (!(AUDIO_EXT as readonly string[]).includes(ext)) return err('只支持 mp3、wav、m4a、ogg 音频');
  if (input.bytes.byteLength === 0) return err('文件是空的');
  if (input.bytes.byteLength > BGM_MAX_BYTES) return err('背景音乐最大 30MB', 413);
  const kind = sniffAudio(input.bytes);
  if (kind !== ext) return err(kind ? `文件内容是 ${kind}，和扩展名 .${ext} 不一致` : '文件内容不是可识别的音频');
  const id = crypto.randomUUID();
  const file = path.join(mediaDir(db, 'bgm'), `${id}.${ext}`);
  fs.writeFileSync(file, input.bytes);
  let duration: number;
  try {
    duration = Math.round((await probeDuration(file)) * 1000) / 1000;
  } catch {
    fs.rmSync(file, { force: true });
    return err('读不出音频时长，文件可能损坏');
  }
  const base = path.basename(input.name, path.extname(input.name)).slice(0, 60) || '背景音乐';
  const artifactId = await saveMediaArtifact(db, { workstationId: wsId, type: 'audio', name: base, file, meta: { kind: 'bgm', duration, format: ext, originalName: input.name.slice(0, 120), downloadName: `${base}.${ext}` } });
  await logEvent(db, actor, 'video_media', 'artifact', artifactId, { kind: 'bgm', duration });
  return { kind: 'ok' as const, id: artifactId, name: base, duration, format: ext, size: input.bytes.byteLength };
}

export async function listVideoMedia(db: DB, wsId: string, kind?: string) {
  const rows = await db.select().from(artifact).where(and(eq(artifact.workstationId, wsId), eq(artifact.type, 'audio'))).orderBy(desc(artifact.createdAt));
  return rows
    .map((a) => ({ a, meta: JSON.parse(a.metaJson ?? '{}') as { kind?: string; duration?: number; format?: string; size?: number } }))
    .filter(({ meta }) => (kind ? meta.kind === kind : meta.kind === 'bgm'))
    .map(({ a, meta }) => ({ id: a.id, name: a.name ?? '', kind: meta.kind ?? '', duration: meta.duration ?? null, format: meta.format ?? '', size: meta.size ?? 0, createdAt: a.createdAt }));
}

export async function bgmFileOf(db: DB, wsId: string, id: string) {
  const a = await bgmArtifact(db, wsId, id);
  return a?.ref && fs.existsSync(a.ref) ? { file: a.ref, duration: Number((JSON.parse(a.metaJson ?? '{}') as { duration?: number }).duration ?? 0) } : null;
}

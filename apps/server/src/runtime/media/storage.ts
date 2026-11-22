import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DB } from '../../db/client.js';
import { artifact } from '../../db/schema.js';

// 媒体文件（配音、成片、字幕、片段缓存）放在数据库旁边的 media/ 下；AW_MEDIA_DIR 可改。
// 内存库（测试）用进程独享的临时目录
export type MediaSub = 'audio' | 'renders' | 'cache' | 'bgm' | 'assets';
export const MEDIA_TYPES = ['audio', 'video_render', 'subtitle', 'image', 'video'] as const;
export type MediaArtifactType = (typeof MEDIA_TYPES)[number];

export function mediaRoot(db: DB): string {
  if (process.env.AW_MEDIA_DIR) return path.resolve(process.env.AW_MEDIA_DIR);
  const name = db.$client.name;
  if (!name || name === ':memory:') return path.join(os.tmpdir(), `aw-media-${process.pid}`);
  return path.join(path.dirname(path.resolve(name)), 'media');
}

export function mediaDir(db: DB, sub: MediaSub): string {
  const dir = path.join(mediaRoot(db), sub);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function insideMedia(db: DB, file: string): boolean {
  const rel = path.relative(mediaRoot(db), path.resolve(file));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

const MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.srt': 'application/x-subrip; charset=utf-8',
};
export const mimeOf = (file: string) => MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';

// 下载文件名：去掉 Windows / URL 不认的字符，保留中文
export const safeFileName = (s: string) => [...s].map((ch) => (ch.charCodeAt(0) < 32 ? '_' : ch)).join('').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'video';

export async function saveMediaArtifact(db: DB, input: { workstationId: string; type: MediaArtifactType; name: string; file: string; meta: Record<string, unknown> }) {
  const id = crypto.randomUUID();
  const size = fs.statSync(input.file).size;
  await db.insert(artifact).values({ id, workstationId: input.workstationId, type: input.type, name: input.name, ref: input.file, metaJson: JSON.stringify({ ...input.meta, size, mime: mimeOf(input.file) }), createdAt: new Date().toISOString() });
  return id;
}

// 只认单段 bytes=a-b / bytes=a- / bytes=-n；多段或写错的当没带 Range，越界的回 416
export function parseRange(header: string | undefined, size: number): [number, number] | 'invalid' | null {
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!m || (!m[1] && !m[2])) return null;
  if (!m[1]) {
    const n = Number(m[2]);
    if (n === 0 || size === 0) return 'invalid';
    return [Math.max(0, size - n), size - 1];
  }
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start >= size || end < start) return 'invalid';
  return [start, end];
}

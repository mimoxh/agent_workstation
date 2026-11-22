import { composeShotDoc, type ShotDocOptions } from './video.js';

// 素材镜头的纯函数：画面运动的 ffmpeg 滤镜、透明叠加画布。预览和成片用的是同一份运动定义，
// 所以播放器里的 Ken Burns 与 ffmpeg zoompan 的起止一致
export type ShotMotionKind = 'none' | 'zoom-in' | 'zoom-out' | 'pan-left' | 'pan-right';
export const SHOT_MOTIONS: readonly ShotMotionKind[] = ['none', 'zoom-in', 'zoom-out', 'pan-left', 'pan-right'];

export interface ShotMotion { kind?: ShotMotionKind | undefined }

export const isShotMotion = (v: unknown): v is ShotMotionKind => typeof v === 'string' && (SHOT_MOTIONS as readonly string[]).includes(v);

// 老镜头没有 motion 字段，一律当 none
export function motionKind(m: ShotMotion | ShotMotionKind | null | undefined): ShotMotionKind {
  if (typeof m === 'string') return isShotMotion(m) ? m : 'none';
  return m?.kind && isShotMotion(m.kind) ? m.kind : 'none';
}

export const MOTION_LABEL: Record<ShotMotionKind, string> = { none: '静止', 'zoom-in': '推近', 'zoom-out': '拉远', 'pan-left': '左移', 'pan-right': '右移' };

export const ASSET_KINDS = ['image', 'video', 'audio'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];
export const isAssetKind = (v: unknown): v is AssetKind => typeof v === 'string' && (ASSET_KINDS as readonly string[]).includes(v);

export const ASSET_EXT: Record<string, AssetKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image',
  mp4: 'video', webm: 'video', mov: 'video',
  mp3: 'audio', wav: 'audio', m4a: 'audio', ogg: 'audio',
};

export const assetKindOfName = (name: string): AssetKind | null => ASSET_EXT[name.split('.').pop()?.toLowerCase() ?? ''] ?? null;

// Ken Burns 的幅度：整段推进 10%，两端各留 5% 余量，缩放时不会露出画布底
export const MOTION_ZOOM = 0.1;
export const MOTION_ROOM = 1.1;

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const f3 = (n: number) => (Math.round(n * 1000) / 1000).toString();

export interface MediaFilterInput {
  kind: 'image' | 'video';
  motion?: ShotMotionKind | undefined;
  width: number;
  height: number;
  frames: number;
  fps: number;
  duration: number;
}

// 素材镜头的编码前滤镜：图片铺满画布再按运动推拉（zoompan，d=帧数），视频等比缩放留黑边、不足时长冻最后一帧
export function mediaFilter(i: MediaFilterInput): string {
  const w = even(i.width);
  const h = even(i.height);
  if (i.kind === 'video') {
    return [
      `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`,
      'setsar=1',
      `fps=${i.fps}`,
      `tpad=stop_mode=clone:stop_duration=${f3(i.duration)}`,
    ].join(',');
  }
  const motion = i.motion ?? 'none';
  if (motion === 'none') return [`scale=${w}:${h}:force_original_aspect_ratio=increase`, `crop=${w}:${h}`, 'setsar=1', `fps=${i.fps}`].join(',');
  const d = Math.max(2, i.frames);
  const span = `on/${d - 1}`;
  const z = motion === 'zoom-out' ? `1+${MOTION_ZOOM}-${MOTION_ZOOM}*${span}` : motion === 'zoom-in' ? `1+${MOTION_ZOOM}*${span}` : `${MOTION_ROOM}`;
  const x = motion === 'pan-left' ? `(iw-iw/zoom)*(1-${span})` : motion === 'pan-right' ? `(iw-iw/zoom)*${span}` : 'iw/2-(iw/zoom/2)';
  return [
    `scale=${w * 2}:${h * 2}:force_original_aspect_ratio=increase`,
    `crop=${w * 2}:${h * 2}`,
    'setsar=1',
    `zoompan=z='${z}':x='${x}':y='ih/2-(ih/zoom/2)':d=${d}:s=${w}x${h}:fps=${i.fps}`,
  ].join(',');
}

// 素材镜头的 shot.html 是一层叠加画面：透明底，预览叠在原生图片 / 视频上，成片用 Chromium 截透明度叠上去
export function overlayDoc(html: string | null | undefined, opts: ShotDocOptions): string {
  const src = (html ?? '').trim() ? html! : '<!doctype html><html><head></head><body></body></html>';
  const doc = composeShotDoc(src, opts);
  const transparent = '<style data-aw-overlay>html,body{background:transparent!important}</style>';
  return doc.includes('</head>') ? doc.replace('</head>', `${transparent}</head>`) : `${doc}${transparent}`;
}

export const EMPTY_OVERLAY_HTML = '<!doctype html><html><head></head><body></body></html>';

// 素材镜头要烧字幕时的透明画布（只有平台字幕，没有模型画面）
export const subtitleCanvasHtml = () => '<!doctype html><html><head></head><body></body></html>';

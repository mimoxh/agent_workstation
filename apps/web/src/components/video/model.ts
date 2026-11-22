import type { BadgeTone } from '@/components/ui/badge';

export const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  storyboarded: '已分镜',
  reviewing: '审片中',
  approved: '已通过',
  rendered: '已出片',
};

export const STATUS_TONE: Record<string, BadgeTone> = {
  draft: 'neutral',
  storyboarded: 'cool',
  reviewing: 'amber',
  approved: 'ok',
  rendered: 'ok',
};

export const TRANSITION_LABEL: Record<string, string> = { cut: '硬切', fade: '淡入', slide: '滑入' };
export const SUBTITLE_LABEL: Record<string, string> = { burn: '烧进画面', srt: '外挂', off: '不要' };
export const VISUAL_LABEL: Record<string, string> = { html: 'HTML 动画', generated: '生成画面', asset: '素材' };

export const ASSET_KIND_LABEL: Record<string, string> = { image: '图片', video: '视频', audio: '音频' };

export const CLIP_STATUS_LABEL: Record<string, string> = {
  pending: '等审批',
  approved: '已批准',
  rejected: '已拒绝',
  running: '生成中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

export const CLIP_STATUS_TONE: Record<string, BadgeTone> = {
  pending: 'amber',
  approved: 'cool',
  rejected: 'neutral',
  running: 'cool',
  succeeded: 'ok',
  failed: 'bad',
  cancelled: 'neutral',
};

export const ASPECTS = ['16:9', '9:16', '1:1'] as const;
export const RESOLUTIONS = ['720p', '1080p'] as const;
export type Aspect = (typeof ASPECTS)[number];
export type Resolution = (typeof RESOLUTIONS)[number];

// 秒 → m:ss.s；时间线和镜头列表共用
export function clock(sec: number, tenths = false): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const body = tenths ? rest.toFixed(1).padStart(4, '0') : String(Math.floor(rest)).padStart(2, '0');
  return `${m}:${body}`;
}

export const seconds = (sec: number) => `${Math.round(sec * 10) / 10} 秒`;

export const SEVERITY_LABEL: Record<string, string> = { block: '阻断', note: '备注' };

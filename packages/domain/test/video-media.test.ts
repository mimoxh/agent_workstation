import { describe, expect, it } from 'vitest';
import { lintShot, shotHashInput, videoHashInput, type HashShot } from '../src/video.js';
import {
  ASSET_EXT, EMPTY_OVERLAY_HTML, MOTION_LABEL, MOTION_ROOM, MOTION_ZOOM, SHOT_MOTIONS, assetKindOfName, isAssetKind, isShotMotion, mediaFilter, motionKind, overlayDoc, subtitleCanvasHtml,
} from '../src/video_media.js';

const doc = (html: string) => ({ width: 1280, height: 720, duration: 3, html });

describe('motionKind', () => {
  it('老镜头没有 motion 字段当 none；字符串和 { kind } 都认，非法值也当 none', () => {
    expect(motionKind(undefined)).toBe('none');
    expect(motionKind(null)).toBe('none');
    expect(motionKind({})).toBe('none');
    expect(motionKind('zoom-in')).toBe('zoom-in');
    expect(motionKind({ kind: 'pan-left' })).toBe('pan-left');
    expect(motionKind({ kind: 'spin' as never })).toBe('none');
    expect(motionKind('spin' as never)).toBe('none');
  });

  it('运动全集和中文名一一对应', () => {
    expect(SHOT_MOTIONS).toEqual(['none', 'zoom-in', 'zoom-out', 'pan-left', 'pan-right']);
    expect(SHOT_MOTIONS.every(isShotMotion)).toBe(true);
    expect(isShotMotion('zoom')).toBe(false);
    expect(Object.keys(MOTION_LABEL).sort()).toEqual([...SHOT_MOTIONS].sort());
  });
});

describe('mediaFilter', () => {
  const base = { width: 1280, height: 720, frames: 60, fps: 30, duration: 2 };

  it('图片静止：铺满画布再裁掉多出来的部分，不走 zoompan', () => {
    const f = mediaFilter({ ...base, kind: 'image', motion: 'none' });
    expect(f).toBe('scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1,fps=30');
    expect(f).not.toContain('zoompan');
  });

  it('图片推近 / 拉远：起点和终点差 10%，帧数就是片段帧数', () => {
    expect(mediaFilter({ ...base, kind: 'image', motion: 'zoom-in' })).toContain(`zoompan=z='1+${MOTION_ZOOM}*on/59'`);
    expect(mediaFilter({ ...base, kind: 'image', motion: 'zoom-out' })).toContain(`zoompan=z='1+${MOTION_ZOOM}-${MOTION_ZOOM}*on/59'`);
  });

  it('图片左移 / 右移：固定放大 1.1 倍，x 从右往左 / 从左往右扫', () => {
    expect(mediaFilter({ ...base, kind: 'image', motion: 'pan-left' })).toContain(`zoompan=z='${MOTION_ROOM}':x='(iw-iw/zoom)*(1-on/59)'`);
    expect(mediaFilter({ ...base, kind: 'image', motion: 'pan-right' })).toContain(`zoompan=z='${MOTION_ROOM}':x='(iw-iw/zoom)*on/59'`);
  });

  it('片段：等比缩到画布里留黑边、对齐帧率、不够长冻最后一帧', () => {
    const f = mediaFilter({ ...base, kind: 'video', motion: 'zoom-in' });
    expect(f).toBe('scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,tpad=stop_mode=clone:stop_duration=2');
    expect(f).not.toContain('zoompan');
  });

  it('奇数尺寸取偶数，帧数至少 2 帧', () => {
    expect(mediaFilter({ ...base, width: 721, height: 405, kind: 'image', motion: 'none' })).toContain('crop=722:406');
    expect(mediaFilter({ ...base, frames: 1, kind: 'image', motion: 'zoom-in' })).toContain('d=2');
  });
});

describe('overlayDoc', () => {
  it('素材镜头的一层叠加画面：和镜头画面同一份合成结果，再强制透明底', () => {
    const d = overlayDoc('<html><body><p>标注</p></body></html>', doc('<html></html>'));
    expect(d.startsWith('<!doctype html>')).toBe(true);
    expect(d).toContain('<p>标注</p>');
    expect(d).toContain('background:transparent!important');
    expect(d).toContain('data-aw-stage');
    expect(d).toContain('__awShot');
  });

  it('没有叠加 HTML 时给一个空画布，照样带透明底', () => {
    const d = overlayDoc('   ', doc(''));
    expect(d).toContain('background:transparent!important');
    expect(overlayDoc(null, doc(''))).toContain('<body></body>');
  });

  it('烧字幕用的透明画布是空文档', () => {
    expect(subtitleCanvasHtml()).toBe(EMPTY_OVERLAY_HTML);
  });
});

describe('素材类型', () => {
  it('按扩展名认类型，认不出返回 null', () => {
    expect(assetKindOfName('封面.PNG')).toBe('image');
    expect(assetKindOfName('clip.webm')).toBe('video');
    expect(assetKindOfName('bgm.m4a')).toBe('audio');
    expect(assetKindOfName('readme.txt')).toBeNull();
    expect(isAssetKind('image')).toBe(true);
    expect(isAssetKind('font')).toBe(false);
    expect(Object.values(ASSET_EXT)).toContain('video');
  });
});

describe('素材镜头的检查', () => {
  const shot = { id: 's1', order: 1, narration: '一句话', duration: 3 };

  it('asset / generated 没有素材是 error「缺素材」', () => {
    for (const visual of ['asset', 'generated'] as const) {
      const issues = lintShot({ ...shot, visual, prompt: visual === 'generated' ? '提示词' : '', html: null });
      const empty = issues.find((i) => i.rule === 'asset_empty')!;
      expect(empty.level).toBe('error');
      expect(empty.message).toContain('缺素材');
    }
  });

  it('有素材就不报缺素材；申请在等审批、上次失败只是 warn', () => {
    expect(lintShot({ ...shot, visual: 'asset', asset: 'a1' }).some((i) => i.level === 'error')).toBe(false);
    const pending = lintShot({ ...shot, visual: 'asset', asset: 'a1', clipRequest: 'pending' });
    expect(pending.find((i) => i.rule === 'clip_request_pending')).toMatchObject({ level: 'warn' });
    const failed = lintShot({ ...shot, visual: 'generated', asset: 'a1', clipRequest: 'failed' });
    expect(failed.find((i) => i.rule === 'clip_request_failed')).toMatchObject({ level: 'warn' });
  });

  it('html 镜头不看素材字段', () => {
    const issues = lintShot({ ...shot, visual: 'html', html: '<p>x</p>', clipRequest: 'pending' });
    expect(issues.some((i) => i.rule.startsWith('clip_request'))).toBe(false);
  });
});

describe('内容哈希带上素材镜头的扩展', () => {
  const s = (patch: Partial<HashShot> = {}): HashShot => ({ id: 's1', narration: '旁白', visual: 'asset', source: 'asset-a', duration: 3, voice: null, ...patch });

  it('同一份输入稳定', () => {
    expect(shotHashInput(s())).toBe(shotHashInput(s()));
  });

  it('换素材、改运动、改叠加层、保留原声都让哈希变', () => {
    const h = shotHashInput(s());
    expect(shotHashInput(s({ source: 'asset-b' }))).not.toBe(h);
    expect(shotHashInput(s({ motion: 'zoom-in' }))).not.toBe(h);
    expect(shotHashInput(s({ overlay: '<p>标注</p>' }))).not.toBe(h);
    expect(shotHashInput(s({ keepAudio: true }))).not.toBe(h);
    expect(shotHashInput(s({ overlay: '  <p>标注</p>  ' }))).toBe(shotHashInput(s({ overlay: '<p>标注</p>' })));
  });

  it('整片哈希把每个镜头的扩展都算进去，风格变化也影响结果', () => {
    const video = { width: 1280, height: 720, fps: 30, subtitles: 'burn', voiceOn: false };
    expect(videoHashInput(video, [s()], 'style')).not.toBe(videoHashInput(video, [s({ motion: 'pan-right' })], 'style'));
    expect(videoHashInput(video, [s()], 'style')).not.toBe(videoHashInput(video, [s()], 'style2'));
  });
});

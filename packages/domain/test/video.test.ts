import { describe, expect, it } from 'vitest';
import { AUDIO_PAD_SECONDS, buildSrt, cueAt, renderTimeline, shotTiming, subtitleOverlayCss, videoCues, VIDEO_CLOCK_SCRIPT, VIDEO_CSP, clockCommand, composeShotDoc, estimateDuration, lintShots, lintVideo, parsePlayerEvent, shotAt, subtitleCues, timeline, videoSize, DEFAULT_BGM_VOLUME, DEFAULT_PALETTE, deriveVideoStatus, evaluateRenderGate, isShotSelector, lookError, markCommand, pickCommand, styleKeyOf, styleVars, subtitleLayout, videoHashInput } from '../src/video.js';

describe('videoSize', () => {
  it('画幅 × 分辨率 → 像素', () => {
    expect(videoSize('16:9', '1080p')).toEqual({ width: 1920, height: 1080 });
    expect(videoSize('9:16', '1080p')).toEqual({ width: 1080, height: 1920 });
    expect(videoSize('1:1', '1080p')).toEqual({ width: 1080, height: 1080 });
    expect(videoSize('16:9', '720p')).toEqual({ width: 1280, height: 720 });
    expect(videoSize('9:16', '720p')).toEqual({ width: 720, height: 1280 });
    expect(videoSize('1:1', '720p')).toEqual({ width: 720, height: 720 });
    expect(videoSize(undefined, undefined)).toEqual({ width: 1920, height: 1080 });
  });
});

describe('estimateDuration', () => {
  it('中文按每秒 4.5 字，英文按每秒 2.6 词，至少 2 秒，保留一位小数', () => {
    expect(estimateDuration('一二三四五六七八九十一二三四五六七八')).toBe(4);
    expect(estimateDuration('one two three four five six seven eight nine ten eleven twelve thirteen')).toBe(5);
    expect(estimateDuration('短')).toBe(2);
    expect(estimateDuration('')).toBe(2);
    expect(estimateDuration(undefined)).toBe(2);
    expect(estimateDuration('用 React 写一个 todo app 吧，很简单的那种。')).toBe(3.6);
  });
});

describe('timeline', () => {
  const shots = [
    { id: 'b', order: 2, narration: '', duration: 3 },
    { id: 'a', order: 1, narration: '一二三四五六七八九十一二三四五六七八' },
    { id: 'c', order: 3, narration: 'x', duration: null },
  ];
  it('按 order 排序并累加起止时间；没填时长按旁白估算', () => {
    const tl = timeline(shots);
    expect(tl.shots.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(tl.shots.map((s) => [s.start, s.end, s.estimated])).toEqual([[0, 4, true], [4, 7, false], [7, 9, true]]);
    expect(tl.total).toBe(9);
  });
  it('shotAt：落点和本地时间，越界夹到首尾', () => {
    const tl = timeline(shots).shots;
    expect(shotAt(tl, 0)).toEqual({ index: 0, local: 0 });
    expect(shotAt(tl, 5.5)).toEqual({ index: 1, local: 1.5 });
    expect(shotAt(tl, 99)).toEqual({ index: 2, local: 2 });
    expect(shotAt([], 1)).toBeNull();
  });
});

describe('subtitleCues', () => {
  it('按句切分并铺满镜头时长', () => {
    const cues = subtitleCues('第一句话。第二句稍微长一点的话！', 6);
    expect(cues.map((c) => c.text)).toEqual(['第一句话', '第二句稍微长一点的话！']);
    expect(cues[0]!.start).toBe(0);
    expect(cues.at(-1)!.end).toBe(6);
    expect(cues[0]!.end).toBeLessThan(cues[1]!.end - cues[1]!.start);
    expect(subtitleCues('', 3)).toEqual([]);
  });
});

describe('lint', () => {
  it('空画面、旁白过长、缺旁白、顺序重复、外部资源', () => {
    const issues = lintShots([
      { id: 's1', order: 1, title: '开场', visual: 'html', html: '', narration: '你好' },
      { id: 's2', order: 1, visual: 'html', html: '<img src="https://x.com/a.png">', narration: '这是一段非常非常非常非常非常非常长的旁白，根本放不进两秒钟的镜头里面', duration: 2 },
      { id: 's3', order: 3, visual: 'generated', html: '', narration: '' },
    ]);
    const rules = issues.map((i) => `${i.shotId}:${i.rule}:${i.level}`);
    expect(rules).toContain('s1:html_empty:error');
    expect(rules).toContain('s2:narration_too_long:warn');
    expect(rules).toContain('s2:network:warn');
    expect(rules).toContain('s2:order_duplicate:warn');
    expect(rules).toContain('s3:prompt_empty:error');
    expect(rules).toContain('s3:narration_missing:warn');
    expect(issues.find((i) => i.rule === 'html_empty')!.message).toContain('开场');
  });
  it('视频级：缺讲解稿、缺分镜、帧率越界、时长非法', () => {
    const rules = lintVideo({ script: '', fps: 100 }, []).map((i) => i.rule);
    expect(rules).toEqual(expect.arrayContaining(['script_missing', 'no_shots', 'fps_invalid']));
    expect(lintVideo({ script: '# x', fps: 30 }, [{ id: 's', html: '<p>x</p>', narration: '好', duration: -1 }]).map((i) => i.rule)).toEqual(['duration_invalid']);
  });
});

describe('composeShotDoc', () => {
  it('注入 CSP、画布尺寸和时钟；片段补 doctype', () => {
    const doc = composeShotDoc('<div>hi</div>', { width: 1920, height: 1080, duration: 4 });
    expect(doc.startsWith('<!doctype html><head>')).toBe(true);
    expect(doc).toContain(VIDEO_CSP);
    expect(doc).toContain('width:1920px;height:1080px');
    expect(doc).toContain('"duration":4');
    expect(doc).toContain(VIDEO_CLOCK_SCRIPT);
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('__awSeek'));
    expect(doc.endsWith('<div>hi</div>')).toBe(true);
  });
  it('完整文档：注入到 <head> 最前，作者脚本之前', () => {
    const doc = composeShotDoc('<!doctype html><html><head><script>var x=1</script></head><body></body></html>', { width: 720, height: 1280, clock: false });
    expect(doc).not.toContain('__awSeek');
    expect(doc.indexOf('data-aw-stage')).toBeLessThan(doc.indexOf('var x=1'));
  });
  it('时钟脚本在纯 JS 里能解析', () => {
    expect(() => new Function(VIDEO_CLOCK_SCRIPT)).not.toThrow();
  });
});

describe('parsePlayerEvent', () => {
  it('只收形状正确的消息并截断长度', () => {
    expect(parsePlayerEvent({ aw: 'video-frame', type: 'ready', t: 0 })).toEqual({ type: 'ready', t: 0 });
    expect(parsePlayerEvent({ aw: 'video-frame', type: 'time', t: 1.5 })).toEqual({ type: 'time', t: 1.5 });
    expect(parsePlayerEvent({ aw: 'video-frame', type: 'issue', t: 2, message: 'x'.repeat(1000) })).toMatchObject({ type: 'issue', message: 'x'.repeat(300) });
    expect(parsePlayerEvent({ aw: 'video-frame', type: 'time', t: -5 })).toEqual({ type: 'time', t: 0 });
    expect(parsePlayerEvent({ aw: 'video-frame', type: 'issue', t: 1, message: '  ' })).toBeNull();
    expect(parsePlayerEvent({ aw: 'video-frame', type: 'time', t: Number.NaN })).toBeNull();
    expect(parsePlayerEvent({ aw: 'video-frame', type: 'evil', t: 1 })).toBeNull();
    expect(parsePlayerEvent({ aw: 'design-frame', type: 'time', t: 1 })).toBeNull();
    expect(parsePlayerEvent('ready')).toBeNull();
    expect(parsePlayerEvent(null)).toBeNull();
  });
  it('clockCommand 形状', () => {
    expect(clockCommand('seek', 1)).toEqual({ aw: 'video-clock', type: 'seek', t: 1 });
    expect(clockCommand('pause')).toEqual({ aw: 'video-clock', type: 'pause' });
  });
});

describe('配音时长与成片时间线', () => {
  it('生效时长：设定 > 新鲜配音 + 0.3 秒（向上取 0.1）> 估算', () => {
    expect(shotTiming({ duration: 4, audioDuration: 6, narration: '很长' })).toEqual({ duration: 4, source: 'set' });
    expect(shotTiming({ audioDuration: 2.01, narration: '一句话' })).toEqual({ duration: 2.4, source: 'audio' });
    expect(shotTiming({ audioDuration: 1.7, narration: '' })).toEqual({ duration: 2, source: 'audio' });
    expect(shotTiming({ audioDuration: 500 })).toEqual({ duration: 120, source: 'audio' });
    expect(shotTiming({ narration: '' })).toEqual({ duration: 2, source: 'estimate' });
    expect(AUDIO_PAD_SECONDS).toBe(0.3);
  });

  it('renderTimeline：淡入 / 滑入交叠最多 0.5 秒且不超过相邻镜头的一半，硬切不交叠；按帧对齐', () => {
    const tl = renderTimeline([{ duration: 2 }, { duration: 2, transition: 'fade' as const }, { duration: 0.6, transition: 'slide' as const }, { duration: 1, transition: 'cut' as const }], 30);
    expect(tl.shots.map((s) => s.overlap)).toEqual([0, 0.5, 0.3, 0]);
    expect(tl.shots.map((s) => s.renderStart)).toEqual([0, 1.5, 3.2, 3.8]);
    expect(tl.shots.map((s) => s.frames)).toEqual([60, 60, 18, 30]);
    expect(tl.total).toBe(4.8);
    const odd = renderTimeline([{ duration: 1.01 }, { duration: 0.95, transition: 'fade' as const }], 24);
    expect(odd.shots[0]!.frames).toBe(24);
    expect(odd.shots[1]!.duration).toBeCloseTo(23 / 24, 3);
    expect(odd.shots[1]!.overlap).toBeCloseTo(11 / 24, 3);
  });

  it('videoCues 按成片起点平移、截到下一镜头开始；buildSrt 格式', () => {
    const cues = videoCues([{ renderStart: 0, duration: 2, narration: '第一句。第二句。' }, { renderStart: 1.5, duration: 2, narration: '下一镜头' }]);
    expect(cues[0]).toMatchObject({ start: 0, text: '第一句' });
    expect(cues[1]!.end).toBe(1.5);
    expect(cues[2]).toEqual({ start: 1.5, end: 3.5, text: '下一镜头' });
    expect(buildSrt([{ start: 0, end: 1.25, text: '你好' }, { start: 61.5, end: 3723.004, text: 'a\nb' }])).toBe('1\n00:00:00,000 --> 00:00:01,250\n你好\n\n2\n00:01:01,500 --> 01:02:03,004\na b\n');
    expect(cueAt([{ start: 0, end: 1, text: 'x' }], 1.5, 1.5)?.text).toBe('x');
    expect(cueAt([{ start: 0, end: 1, text: 'x' }], 1.2, 1.5)).toBeUndefined();
  });

  it('lint：配音过期、配音超过设定时长；有配音时不再报旁白太长', () => {
    const rules = (s: Parameters<typeof lintShots>[0][number]) => lintShots([s]).map((l) => l.rule);
    expect(rules({ id: 'a', html: '<p>x</p>', narration: '旁白', audioState: 'stale' })).toContain('audio_stale');
    expect(rules({ id: 'a', html: '<p>x</p>', narration: '旁白', duration: 1, audioDuration: 3 })).toContain('audio_too_long');
    const long = '这是一段非常非常非常非常非常非常非常非常长的旁白文字';
    expect(rules({ id: 'a', html: '<p>x</p>', narration: long, duration: 1 })).toContain('narration_too_long');
    expect(rules({ id: 'a', html: '<p>x</p>', narration: long, duration: 1, audioDuration: 0.9 })).not.toContain('narration_too_long');
  });

  it('subtitleOverlayCss 用短边算字号，可换字体', () => {
    expect(subtitleOverlayCss(1280, 720)).toContain('font:500 32px/1.5');
    expect(subtitleOverlayCss(1280, 720, 'Noto Sans SC')).toContain('"Noto Sans SC", ');
  });
});

describe('统一时间线：预览 = 成片', () => {
  it('timeline 带转场交叠，给 fps 时和 renderTimeline 帧对齐的结果一致', () => {
    const shots = [{ id: 'a', order: 1, duration: 2 }, { id: 'b', order: 2, duration: 2, transition: 'fade' as const }, { id: 'c', order: 3, duration: 2, transition: 'cut' as const }];
    const tl = timeline(shots);
    expect(tl.shots.map((s) => [s.start, s.end, s.overlap])).toEqual([[0, 2, 0], [1.5, 3.5, 0.5], [3.5, 5.5, 0]]);
    expect(tl.total).toBe(5.5);
    expect(timeline(shots, 30).total).toBe(renderTimeline(shots, 30).total);
    expect(shotAt(tl.shots, 1.6)!.index).toBe(1);
    expect(shotAt(tl.shots, 1.6)!.local).toBeCloseTo(0.1, 6);
  });
});

describe('审片：内容哈希输入、状态、门禁', () => {
  const video = { width: 1280, height: 720, fps: 30, subtitles: 'burn', voiceOn: true };
  const shot = { id: 's1', narration: '你好  世界', visual: 'html' as const, source: '<p>x</p>', duration: 2, transition: 'cut' as const, voice: null };
  it('videoHashInput：旁白空白规整；画面 / 时长 / 风格变了才变', () => {
    const base = videoHashInput(video, [shot], 'k');
    expect(videoHashInput(video, [{ ...shot, narration: '你好 世界' }], 'k')).toBe(base);
    expect(videoHashInput(video, [{ ...shot, source: '<p>y</p>' }], 'k')).not.toBe(base);
    expect(videoHashInput(video, [{ ...shot, duration: 2.5 }], 'k')).not.toBe(base);
    expect(videoHashInput(video, [shot], 'k2')).not.toBe(base);
    expect(videoHashInput({ ...video, fps: 24 }, [shot], 'k')).not.toBe(base);
  });
  it('deriveVideoStatus：没镜头 draft；通过且哈希对得上 approved；出片哈希也对上 rendered；请求审片后没改保持 reviewing', () => {
    const pass = { verdict: 'pass' as const, contentHash: 'h1' };
    expect(deriveVideoStatus({ contentHash: 'h1', shots: 0, review: pass })).toBe('draft');
    expect(deriveVideoStatus({ contentHash: 'h1', shots: 2, review: pass })).toBe('approved');
    expect(deriveVideoStatus({ contentHash: 'h2', shots: 2, review: pass })).toBe('storyboarded');
    expect(deriveVideoStatus({ contentHash: 'h1', shots: 2, review: pass, renderHash: 'h1' })).toBe('rendered');
    expect(deriveVideoStatus({ contentHash: 'h1', shots: 2, review: { verdict: 'fail', contentHash: 'h1' } })).toBe('storyboarded');
    expect(deriveVideoStatus({ status: 'reviewing', contentHash: 'h1', shots: 2, reviewRequestHash: 'h1' })).toBe('reviewing');
    expect(deriveVideoStatus({ status: 'reviewing', contentHash: 'h2', shots: 2, reviewRequestHash: 'h1' })).toBe('storyboarded');
  });
  it('evaluateRenderGate：审片、检查、阻断评论、配音四项', () => {
    const ok = evaluateRenderGate({ review: { verdict: 'pass', contentHash: 'h' }, contentHash: 'h', lintErrors: [], openBlocks: 0, voiceOn: true, unvoiced: [] });
    expect(ok.ok).toBe(true);
    expect(ok.checks.map((c) => c.id)).toEqual(['review', 'lint', 'comments', 'voice']);
    const bad = evaluateRenderGate({ review: { verdict: 'pass', contentHash: 'old' }, contentHash: 'h', lintErrors: ['x'], openBlocks: 2, voiceOn: true, unvoiced: ['开场'] });
    expect(bad.ok).toBe(false);
    expect(bad.checks.filter((c) => !c.ok).map((c) => c.id)).toEqual(['review', 'lint', 'comments', 'voice']);
    expect(bad.reasons[0]).toContain('重新审片');
    expect(evaluateRenderGate({ review: { verdict: 'pass', contentHash: 'h' }, contentHash: 'h', lintErrors: [], openBlocks: 0, voiceOn: false, unvoiced: ['a'] }).ok).toBe(true);
  });
});

describe('风格', () => {
  it('styleVars / styleCss：默认色 + 自定义，字体追加兜底；composeShotDoc 注入', () => {
    const vars = styleVars({ palette: { accent: '#ff0000', brand: 'rgb(1,2,3)' }, fonts: { heading: 'Georgia' } });
    expect(vars['--aw-accent']).toBe('#ff0000');
    expect(vars['--aw-brand']).toBe('rgb(1,2,3)');
    expect(vars['--aw-bg']).toBe(DEFAULT_PALETTE.bg);
    expect(vars['--aw-font-heading']?.startsWith('Georgia, ')).toBe(true);
    const doc = composeShotDoc('<p>x</p>', { width: 100, height: 100, style: { palette: { accent: '#ff0000' } } });
    expect(doc).toContain('data-aw-style');
    expect(doc).toContain('--aw-accent:#ff0000');
    expect(composeShotDoc('<p>x</p>', { width: 100, height: 100 })).not.toContain('data-aw-style');
  });
  it('lookError 挡住能逃出 <style> 的值', () => {
    expect(lookError({ palette: { bg: '#fff' }, fonts: { body: '"Noto Sans SC", sans-serif' } })).toBeNull();
    expect(lookError({ palette: { bg: 'red;}body{display:none' } })).not.toBeNull();
    expect(lookError({ palette: { bg: 'url(http://x)' } })).not.toBeNull();
    expect(lookError({ palette: { 'Bad Key': '#fff' } })).not.toBeNull();
    expect(lookError({ fonts: { body: 'x}</style><script>' } })).not.toBeNull();
    expect(styleVars({ palette: { bg: 'red;}' } })['--aw-bg']).toBe(DEFAULT_PALETTE.bg);
  });
  it('styleKeyOf：背景音乐音量 / 压低只在有音乐时算数；字幕样式进键', () => {
    const a = styleKeyOf({ look: null });
    expect(styleKeyOf({ look: null, bgmVolume: 0.5 })).toBe(a);
    expect(styleKeyOf({ look: null, bgm: 'm1' })).not.toBe(a);
    expect(styleKeyOf({ look: null, bgm: 'm1', bgmVolume: 0.3 })).not.toBe(styleKeyOf({ look: null, bgm: 'm1' }));
    expect(styleKeyOf({ look: null, subtitle: { size: 'l' } })).not.toBe(a);
    expect(DEFAULT_BGM_VOLUME).toBe(0.15);
  });
  it('subtitleLayout：字号档位、位置、背景', () => {
    expect(subtitleLayout(1280, 720, null, { size: 'l' }).size).toBe(40);
    expect(subtitleLayout(1280, 720, null, { position: 'top' }).p.top).toBe('6%');
    expect(subtitleLayout(1280, 720, null, { background: 'none' }).span.background).toBeUndefined();
    expect(subtitleOverlayCss(1280, 720, null, { background: 'shadow' })).toContain('text-shadow');
  });
});

describe('圈选元素', () => {
  it('pick 事件只收平台生成的选择器；mark / pick 命令形状', () => {
    expect(parsePlayerEvent({ aw: 'video-frame', type: 'pick', t: 1, selector: 'body > main:nth-child(1) > h1:nth-child(2)', anchor: '标题', tag: 'h1' })).toEqual({ type: 'pick', t: 1, selector: 'body > main:nth-child(1) > h1:nth-child(2)', anchor: '标题', tag: 'h1' });
    expect(parsePlayerEvent({ aw: 'video-frame', type: 'pick', t: 1, selector: 'body > h1[onclick]', anchor: '' })).toBeNull();
    expect(parsePlayerEvent({ aw: 'video-frame', type: 'pick', t: 1, selector: 'body', anchor: 'x'.repeat(100), tag: '<b>' })).toMatchObject({ anchor: 'x'.repeat(60), tag: '' });
    expect(isShotSelector('body > div:nth-child(3)')).toBe(true);
    expect(isShotSelector('div')).toBe(false);
    const colors = { hover: 'red', mark: 'blue' };
    expect(pickCommand(true, colors)).toEqual({ aw: 'video-clock', type: 'pick', on: true, colors });
    expect(markCommand(null, colors)).toEqual({ aw: 'video-clock', type: 'mark', selector: null, colors });
  });
});

import { injectHead } from './design.js';
import type { ShotMotionKind } from './video_media.js';

// 讲解视频的纯函数：时间线、时长估算、分镜检查、镜头文档合成与虚拟时钟。
// 前端播放器和服务端逐帧渲染共用同一份 composeShotDoc + VIDEO_CLOCK_SCRIPT，保证预览与成片一致
export type VideoAspect = '16:9' | '9:16' | '1:1';
export type VideoResolution = '720p' | '1080p';
export type VideoStatus = 'draft' | 'storyboarded' | 'reviewing' | 'approved' | 'rendered';
export type ShotVisual = 'html' | 'generated' | 'asset';
export type ShotTransition = 'cut' | 'fade' | 'slide';

export const VIDEO_ASPECTS: readonly VideoAspect[] = ['16:9', '9:16', '1:1'];
export const VIDEO_RESOLUTIONS: readonly VideoResolution[] = ['720p', '1080p'];

// 短边 = 720 / 1080，长边按画幅换算
export function videoSize(aspect: VideoAspect | undefined, resolution: VideoResolution | undefined): { width: number; height: number } {
  const short = resolution === '720p' ? 720 : 1080;
  const long = Math.round((short * 16) / 9);
  if (aspect === '9:16') return { width: short, height: long };
  if (aspect === '1:1') return { width: short, height: short };
  return { width: long, height: short };
}

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;
const WORD = /[A-Za-z0-9]+(?:['’.-][A-Za-z0-9]+)*/g;

export const MIN_SHOT_SECONDS = 2;
export const MAX_SHOT_SECONDS = 120;

// 念完一段旁白要多久：中文约每秒 4.5 字，拉丁文约每秒 2.6 个词
export function speechSeconds(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0;
  const words = text.replace(CJK, ' ').match(WORD)?.length ?? 0;
  return cjk / 4.5 + words / 2.6;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function estimateDuration(narration: string | null | undefined): number {
  return Math.max(MIN_SHOT_SECONDS, round1(speechSeconds(narration ?? '')));
}

// audioDuration 只在配音与当前旁白 / 音色一致时给（由服务端判断新鲜度）
export interface ShotTiming { id: string; order?: number | null | undefined; narration?: string | null | undefined; duration?: number | null | undefined; audioDuration?: number | null | undefined }

const explicit = (d: number | null | undefined): d is number => typeof d === 'number' && Number.isFinite(d) && d > 0;

// 配音后面留一点气口，镜头不会在最后一个字上硬切
export const AUDIO_PAD_SECONDS = 0.3;

export type DurationSource = 'set' | 'audio' | 'estimate';

// 生效时长的优先级：人 / Agent 设定的时长 > 新鲜配音的实测时长 + 气口（向上取到 0.1 秒）> 按旁白估算
export function shotTiming(s: Pick<ShotTiming, 'narration' | 'duration' | 'audioDuration'>): { duration: number; source: DurationSource } {
  if (explicit(s.duration)) return { duration: s.duration, source: 'set' };
  if (explicit(s.audioDuration)) return { duration: Math.min(MAX_SHOT_SECONDS, Math.ceil(round3(s.audioDuration + AUDIO_PAD_SECONDS) * 10) / 10), source: 'audio' };
  return { duration: estimateDuration(s.narration), source: 'estimate' };
}

export function shotDuration(s: Pick<ShotTiming, 'narration' | 'duration' | 'audioDuration'>): number {
  return shotTiming(s).duration;
}

export type TimedShot<T> = T & RenderTimedShot & { start: number; end: number; duration: number; estimated: boolean; durationSource: DurationSource };

export function sortShots<T extends Pick<ShotTiming, 'order'>>(shots: T[]): T[] {
  return shots
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.order ?? Infinity) - (b.s.order ?? Infinity) || a.i - b.i)
    .map((x) => x.s);
}

// 预览、分镜和成片共用一条时间线：淡入 / 滑入与上一镜头交叠（renderTimeline），start / end 就是成片里的起止；
// 给 fps 时按帧对齐，和逐帧渲染出来的长度一致
export function timeline<T extends ShotTiming & { transition?: ShotTransition | null | undefined }>(shots: T[], fps?: number): { shots: TimedShot<T>[]; total: number } {
  const timed = sortShots(shots).map((s) => {
    const { duration, source } = shotTiming(s);
    return { ...s, duration, estimated: source === 'estimate', durationSource: source };
  });
  const tl = renderTimeline(timed, fps);
  return { shots: tl.shots.map((s) => ({ ...s, start: s.renderStart, end: s.renderEnd })), total: tl.total };
}

// 全片时间 t 落在哪个镜头、镜头内的本地时间；越界时夹到首尾
export function shotAt<T extends { start: number; end: number; duration: number }>(shots: T[], t: number): { index: number; local: number } | null {
  if (shots.length === 0) return null;
  let index = 0;
  for (let i = 0; i < shots.length; i++) if (shots[i]!.start <= t) index = i;
  const s = shots[index]!;
  return { index, local: Math.min(Math.max(0, t - s.start), s.duration) };
}

export interface SubtitleCue { start: number; end: number; text: string }

// 旁白按句切成字幕，按念的时长比例分配镜头时间；一句太长时再按逗号切
export function subtitleCues(narration: string | null | undefined, duration: number): SubtitleCue[] {
  const text = (narration ?? '').trim();
  if (!text || !(duration > 0)) return [];
  const sentences = text.split(/(?<=[。！？!?；;…\n])/).map((s) => s.trim()).filter(Boolean);
  const pieces = sentences.flatMap((s) => (s.length > 28 ? s.split(/(?<=[，,、：:])/).map((x) => x.trim()).filter(Boolean) : [s]));
  const weights = pieces.map((p) => Math.max(0.3, speechSeconds(p)));
  const sum = weights.reduce((a, b) => a + b, 0);
  let at = 0;
  return pieces.map((p, i) => {
    const start = at;
    at = i === pieces.length - 1 ? duration : at + (duration * weights[i]!) / sum;
    return { start: round3(start), end: round3(at), text: p.replace(/[。；;]$/, '') };
  });
}

export interface VideoLintIssue { level: 'error' | 'warn'; rule: string; message: string; shotId?: string | undefined }

export interface ShotLintInput extends ShotTiming {
  // 配音状态：stale = 旁白或音色改过，旧配音不再算数
  audioState?: 'fresh' | 'stale' | 'none' | undefined;
  title?: string | null | undefined;
  visual?: ShotVisual | null | undefined;
  html?: string | null | undefined;
  prompt?: string | null | undefined;
  asset?: string | null | undefined;
  // 片段申请还在等人批：不阻挡出片（门禁只认 error），但提示画面会缺
  clipRequest?: 'pending' | 'approved' | 'rejected' | 'running' | 'succeeded' | 'failed' | 'cancelled' | null | undefined;
}

const NETWORK_REF = /(?:\bsrc|\bhref)\s*=\s*["']\s*(?:https?:)?\/\/|url\(\s*["']?\s*(?:https?:)?\/\/|@import\s+(?:url\()?\s*["']?\s*(?:https?:)?\/\//i;

// 写入时的检查结果原样回给模型和人：error 必须修，warn 酌情
export function lintShot(s: ShotLintInput, label = s.title || s.id): VideoLintIssue[] {
  const out: VideoLintIssue[] = [];
  const add = (level: VideoLintIssue['level'], rule: string, message: string) => out.push({ level, rule, message: `${label}：${message}`, shotId: s.id });
  const visual = s.visual ?? 'html';
  const hasAsset = !!(s.asset ?? '').trim();
  if (visual === 'html' && !(s.html ?? '').trim()) add('error', 'html_empty', '还没有画面 HTML');
  if (visual === 'generated' && !(s.prompt ?? '').trim()) add('error', 'prompt_empty', '生成画面缺少提示词');
  // 生成画面和素材画面都要有落地的素材才画得出来：只有提示词只是排队申请，还不能出片
  if (visual !== 'html' && !hasAsset) add('error', 'asset_empty', '缺素材');
  if (visual !== 'html' && s.clipRequest === 'pending') add('warn', 'clip_request_pending', '片段申请还在等审批，批了才会生成');
  if (visual !== 'html' && s.clipRequest === 'failed') add('warn', 'clip_request_failed', '上一次片段生成失败了，需要重新申请或手动挑素材');
  if (s.duration !== undefined && s.duration !== null && (!Number.isFinite(s.duration) || s.duration <= 0 || s.duration > MAX_SHOT_SECONDS)) {
    add('error', 'duration_invalid', `时长要在 0 到 ${MAX_SHOT_SECONDS} 秒之间`);
  }
  const narration = (s.narration ?? '').trim();
  if (!narration) add('warn', 'narration_missing', '没有旁白');
  else if (explicit(s.duration)) {
    const need = round1(speechSeconds(narration));
    if (need > s.duration * 1.1 && !explicit(s.audioDuration)) add('warn', 'narration_too_long', `旁白约需 ${need} 秒，超过镜头时长 ${s.duration} 秒`);
    if (explicit(s.audioDuration) && s.audioDuration > s.duration + 0.05) add('warn', 'audio_too_long', `配音 ${round1(s.audioDuration)} 秒，超过镜头时长 ${s.duration} 秒，成片里会被截断`);
  }
  if (s.audioState === 'stale') add('warn', 'audio_stale', '旁白或音色改过，配音要重新生成');
  if (visual === 'html' && s.html) {
    if (NETWORK_REF.test(s.html)) add('warn', 'network', '引用了外部资源，播放和渲染时会被拦截');
    if (/\bfetch\(|XMLHttpRequest|new WebSocket/.test(s.html)) add('warn', 'network', '画面里没有网络，fetch / XHR / WebSocket 都会失败');
  }
  return out;
}

export function lintShots(shots: ShotLintInput[]): VideoLintIssue[] {
  const out: VideoLintIssue[] = [];
  const sorted = sortShots(shots);
  const seen = new Map<number, string>();
  sorted.forEach((s, i) => {
    out.push(...lintShot(s, s.title || `镜头 ${i + 1}`));
    if (typeof s.order === 'number') {
      if (seen.has(s.order)) out.push({ level: 'warn', rule: 'order_duplicate', message: `镜头顺序 ${s.order} 重复`, shotId: s.id });
      seen.set(s.order, s.id);
    }
  });
  return out;
}

export interface VideoLintInput { title?: string | null | undefined; script?: string | null | undefined; fps?: number | null | undefined }

export const MAX_VIDEO_SECONDS = 600;

export function lintVideo(video: VideoLintInput, shots: ShotLintInput[]): VideoLintIssue[] {
  const out: VideoLintIssue[] = [];
  if (!(video.script ?? '').trim()) out.push({ level: 'warn', rule: 'script_missing', message: '还没有讲解稿' });
  if (shots.length === 0) out.push({ level: 'warn', rule: 'no_shots', message: '还没有分镜' });
  if (video.fps !== undefined && video.fps !== null && (!Number.isInteger(video.fps) || video.fps < 12 || video.fps > 60)) {
    out.push({ level: 'error', rule: 'fps_invalid', message: '帧率要是 12 到 60 之间的整数' });
  }
  const total = timeline(shots).total;
  if (total > MAX_VIDEO_SECONDS) out.push({ level: 'warn', rule: 'too_long', message: `全片约 ${Math.round(total)} 秒，超过 ${MAX_VIDEO_SECONDS} 秒` });
  return [...out, ...lintShots(shots)];
}

// 镜头画面是模型写的代码：完全断网，只放行内联脚本样式和 data:/blob: 资源，预览与渲染结果一致
export const VIDEO_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'font-src data:',
  'img-src data: blob:',
  'media-src data: blob:',
  "connect-src 'none'",
  "form-action 'none'",
].join('; ');

// 注入每个镜头文档最前面的虚拟时钟：接管 performance.now / Date / rAF / 定时器 / Math.random 和全部 CSS / Web 动画，
// 画面因此只是时间的函数。window.__awSeek(秒) 推进到该时刻并在样式落定后 resolve；
// 父页面用 postMessage {aw:'video-clock', type:'seek'|'play'|'pause', t} 控制，镜头回 {aw:'video-frame', type:'ready'|'time'|'issue', t, message?}
export const VIDEO_CLOCK_SCRIPT = `(function () {
  if (window.__awClock) return;
  var cfg = window.__awShot || {};
  var EPOCH = 1704067200000;
  var MAX_STEPS = 10000;
  var realNow = performance.now.bind(performance);
  var realRaf = window.requestAnimationFrame.bind(window);
  var realSetTimeout = window.setTimeout.bind(window);
  var RealDate = window.Date;
  var t = 0;
  var mode = 'pause';
  var baseReal = 0;
  var baseVirtual = 0;
  var lastPost = 0;
  var rafQ = [];
  var rafSeq = 0;
  var timers = [];
  var timerSeq = 0;
  var starts = new WeakMap();
  var issues = [];
  var seen = {};
  var hasParent = window.parent !== window;
  var picking = false;
  var overlay = null;
  var hoverBox = null;
  var markBox = null;
  var markSel = null;

  function post(type, extra) {
    if (!hasParent) return;
    var m = { aw: 'video-frame', type: type, t: t / 1000 };
    if (extra) for (var k in extra) m[k] = extra[k];
    try { window.parent.postMessage(m, '*'); } catch (e) {}
  }
  function issue(msg, key) {
    msg = String(msg).slice(0, 300);
    key = key || msg;
    if (seen[key]) return;
    seen[key] = 1;
    if (issues.length < 50) issues.push(msg);
    post('issue', { message: msg });
  }
  function errText(e) { return e && e.message ? e.message : String(e); }

  var seed = 0x2f6b3a1d;
  Math.random = function () {
    seed = (seed + 0x6d2b79f5) | 0;
    var r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };

  function VDate() {
    if (!(this instanceof VDate)) return new RealDate(EPOCH + t).toString();
    if (arguments.length === 0) return new RealDate(EPOCH + t);
    return new (Function.prototype.bind.apply(RealDate, [null].concat(Array.prototype.slice.call(arguments))))();
  }
  VDate.prototype = RealDate.prototype;
  VDate.now = function () { return EPOCH + t; };
  VDate.parse = RealDate.parse;
  VDate.UTC = RealDate.UTC;
  window.Date = VDate;
  try { Object.defineProperty(performance, 'now', { configurable: true, value: function () { return t; } }); } catch (e) {}

  window.requestAnimationFrame = function (cb) {
    var id = ++rafSeq;
    if (typeof cb === 'function') rafQ.push({ id: id, cb: cb });
    return id;
  };
  window.cancelAnimationFrame = function (id) {
    rafQ = rafQ.filter(function (r) { return r.id !== id; });
  };
  function addTimer(fn, delay, args, repeat) {
    var id = ++timerSeq;
    if (typeof fn !== 'function') return id;
    var d = Math.max(0, Number(delay) || 0);
    timers.push({ id: id, at: t + d, fn: fn, args: args, every: repeat ? Math.max(d, 4) : 0 });
    return id;
  }
  window.setTimeout = function (fn, delay) { return addTimer(fn, delay, Array.prototype.slice.call(arguments, 2), false); };
  window.setInterval = function (fn, delay) { return addTimer(fn, delay, Array.prototype.slice.call(arguments, 2), true); };
  window.clearTimeout = window.clearInterval = function (id) {
    timers = timers.filter(function (x) { return x.id !== id; });
  };

  function nextTimer(limit) {
    var best = null;
    for (var i = 0; i < timers.length; i++) {
      var x = timers[i];
      if (x.at <= limit && (!best || x.at < best.at || (x.at === best.at && x.id < best.id))) best = x;
    }
    return best;
  }
  function adopt() {
    var list = document.getAnimations ? document.getAnimations() : [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (!starts.has(a)) {
        starts.set(a, t);
        try { a.pause(); } catch (e) {}
      }
    }
    return list;
  }
  function syncAnimations() {
    var list = adopt();
    for (var i = 0; i < list.length; i++) {
      try { list[i].currentTime = Math.max(0, t - starts.get(list[i])); } catch (e) {}
    }
    if (document.documentElement) document.documentElement.style.setProperty('--aw-t', String(t / 1000));
  }
  function flushRaf() {
    var q = rafQ;
    rafQ = [];
    for (var i = 0; i < q.length; i++) {
      try { q[i].cb(t); } catch (e) { issue('脚本错误：' + errText(e)); }
    }
  }
  function selectorOf(el) {
    if (el === document.body || el === document.documentElement) return 'body';
    var parts = [];
    for (var n = el; n && n !== document.body; n = n.parentElement) {
      var i = 1, s = n;
      while ((s = s.previousElementSibling)) i++;
      parts.unshift(n.localName.replace(/[^a-z0-9-]/gi, '') + ':nth-child(' + i + ')');
    }
    return 'body > ' + parts.join(' > ');
  }
  function find(sel) { try { return sel ? document.querySelector(sel) : null; } catch (e) { return null; } }
  function ensureOverlay() {
    if (overlay) return;
    overlay = document.createElement('aw-video-overlay');
    var root = overlay.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>:host{all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none}div{position:fixed;display:none;border-radius:2px}#h{outline:3px solid var(--h);outline-offset:1px}#m{outline:3px dashed var(--m);outline-offset:3px}</style><div id="h"></div><div id="m"></div>';
    hoverBox = root.getElementById('h');
    markBox = root.getElementById('m');
    document.documentElement.appendChild(overlay);
  }
  function boxTo(b, el) {
    if (!b) return;
    if (!el) { b.style.display = 'none'; return; }
    var r = el.getBoundingClientRect();
    b.style.cssText = 'display:block;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px';
  }
  function targetOf(e) {
    var el = e.target;
    if (!el || el.nodeType !== 1 || el === overlay) return null;
    return el.closest('svg') || el;
  }
  function colors(c) {
    if (!c || typeof c !== 'object') return;
    ensureOverlay();
    if (typeof c.hover === 'string') overlay.style.setProperty('--h', c.hover.slice(0, 60));
    if (typeof c.mark === 'string') overlay.style.setProperty('--m', c.mark.slice(0, 60));
  }
  function advanceTo(target) {
    var steps = 0;
    var x;
    while ((x = nextTimer(target))) {
      if (++steps > MAX_STEPS) { issue('定时器触发次数过多，已截断'); break; }
      if (x.at > t) t = x.at;
      if (x.every) x.at += x.every; else timers.splice(timers.indexOf(x), 1);
      try { x.fn.apply(window, x.args); } catch (e) { issue('脚本错误：' + errText(e)); }
      adopt();
    }
    t = target;
    flushRaf();
    syncAnimations();
    if (markSel) boxTo(markBox, find(markSel));
  }
  function toMs(sec) {
    var s = Number(sec);
    if (!isFinite(s) || s < 0) s = 0;
    return Math.min(s, 3600) * 1000;
  }
  function settle() {
    return new Promise(function (resolve) {
      var done = false;
      function finish() {
        if (done) return;
        done = true;
        if (document.documentElement) document.documentElement.getBoundingClientRect();
        resolve(t / 1000);
      }
      realRaf(function () { realRaf(finish); });
      realSetTimeout(finish, 120);
    });
  }
  function ownText(el) {
    for (var c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 3 && c.nodeValue.trim()) return true;
    return false;
  }
  function checkLayout() {
    if (!document.body) return;
    var W = window.innerWidth;
    var H = window.innerHeight;
    var els = document.body.getElementsByTagName('*');
    var n = 0;
    for (var i = 0; i < els.length && i < 3000; i++) {
      var el = els[i];
      if (!ownText(el)) continue;
      if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      var r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      var visible = r.right > 0 && r.bottom > 0 && r.left < W && r.top < H;
      var clipped = r.left < -1 || r.top < -1 || r.right > W + 1 || r.bottom > H + 1;
      if (visible && clipped) {
        var txt = (el.textContent || '').trim().slice(0, 40);
        issue('文字超出画面（' + (t / 1000).toFixed(1) + 's）：' + txt, 'overflow:' + txt);
        if (++n >= 5) return;
      }
    }
  }
  function seek(sec) {
    mode = 'pause';
    advanceTo(toMs(sec));
    return settle();
  }
  function tick() {
    if (mode !== 'play') return;
    advanceTo(baseVirtual + (realNow() - baseReal));
    if (realNow() - lastPost > 250) {
      lastPost = realNow();
      post('time');
    }
    realRaf(tick);
  }
  function play(sec) {
    if (sec !== undefined) advanceTo(toMs(sec));
    baseVirtual = t;
    baseReal = realNow();
    if (mode !== 'play') {
      mode = 'play';
      realRaf(tick);
    }
  }

  window.addEventListener('mousemove', function (e) {
    if (picking) boxTo(hoverBox, targetOf(e));
  }, true);
  window.addEventListener('click', function (e) {
    if (!picking) return;
    e.preventDefault();
    e.stopPropagation();
    var el = targetOf(e);
    if (!el) return;
    picking = false;
    boxTo(hoverBox, null);
    document.documentElement.style.cursor = '';
    post('pick', { selector: selectorOf(el), anchor: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60), tag: el.localName });
  }, true);
  window.addEventListener('error', function (e) { issue('脚本错误：' + (e.message || '未知错误')); });
  window.addEventListener('unhandledrejection', function (e) { issue('脚本错误：' + errText(e.reason)); });
  document.addEventListener('securitypolicyviolation', function (e) {
    issue('外部资源被拦截：' + String(e.blockedURI || e.violatedDirective).slice(0, 120), 'csp:' + e.violatedDirective);
  });
  window.addEventListener('message', function (e) {
    if (!hasParent || e.source !== window.parent) return;
    var d = e.data;
    if (!d || typeof d !== 'object' || d.aw !== 'video-clock') return;
    var s = typeof d.t === 'number' && isFinite(d.t) ? d.t : undefined;
    if (d.type === 'seek') seek(s || 0).then(function () { checkLayout(); post('time'); });
    else if (d.type === 'play') play(s);
    else if (d.type === 'pause') {
      if (s !== undefined) seek(s).then(function () { post('time'); });
      else { mode = 'pause'; post('time'); }
    } else if (d.type === 'pick') {
      colors(d.colors);
      picking = d.on === true;
      if (!picking) boxTo(hoverBox, null);
      document.documentElement.style.cursor = picking ? 'crosshair' : '';
    } else if (d.type === 'mark') {
      colors(d.colors);
      markSel = typeof d.selector === 'string' ? d.selector.slice(0, 500) : null;
      boxTo(markBox, find(markSel));
    }
  });
  window.addEventListener('load', function () {
    if (mode !== 'play') advanceTo(t);
    settle().then(function () { post('ready'); });
  });

  window.__awSeek = seek;
  // 成片逐帧用：同步推进并强制排版，截图本身会出新帧，不再等两次 rAF
  window.__awFrame = function (sec) {
    mode = 'pause';
    advanceTo(toMs(sec));
    if (document.documentElement) document.documentElement.getBoundingClientRect();
    return t / 1000;
  };
  window.__awCheck = function () { checkLayout(); return issues.slice(); };
  window.__awDuration = Number(cfg.duration) || 0;
  window.__awIssues = issues;
  window.__awClock = { seek: seek, play: play, time: function () { return t / 1000; } };
})();`;

export interface ShotDocOptions {
  width: number;
  height: number;
  duration?: number | undefined;
  // 关掉时钟只用于静态缩略图；播放和渲染都必须带
  clock?: boolean | undefined;
  csp?: string | false | undefined;
  head?: string | undefined;
  // 本台风格：注入成 CSS 变量（--aw-bg / --aw-font-heading …），镜头 HTML 直接 var() 引用
  style?: VideoLook | null | undefined;
}

// 镜头文档的唯一合成入口：视口就是画布（宽高 = 分辨率），缩放由宿主在外面做（iframe 整体 transform / 渲染器视口），
// 这样 px / vw / vh / fixed 在预览和成片里含义一致
export function composeShotDoc(html: string, opts: ShotDocOptions): string {
  const w = Math.max(1, Math.round(opts.width));
  const h = Math.max(1, Math.round(opts.height));
  const csp = opts.csp === false ? '' : `<meta http-equiv="Content-Security-Policy" content="${opts.csp ?? VIDEO_CSP}">`;
  const stage = `<style data-aw-stage>html,body{margin:0;padding:0;width:${w}px;height:${h}px;overflow:hidden}</style>`;
  const clock = opts.clock === false ? '' : `<script>window.__awShot=${JSON.stringify({ width: w, height: h, duration: opts.duration ?? 0 })};</script><script>${VIDEO_CLOCK_SCRIPT}</script>`;
  const look = opts.style ? `<style data-aw-style>${styleCss(opts.style)}</style>` : '';
  const head = `<meta charset="utf-8">${csp}<meta name="viewport" content="width=${w}, height=${h}">${stage}${look}${clock}${opts.head ?? ''}`;
  const src = /^\s*<!doctype/i.test(html) ? html : `<!doctype html>${html}`;
  return injectHead(src, head);
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// 还没有可播放画面的镜头用占位画面顶上，时间线照常走
export function placeholderShotHtml(label: string): string {
  return `<!doctype html><html><head><style>body{display:grid;place-items:center;background:#1d1d1f;color:#9a9a9f;font:600 4vmin/1.4 system-ui,"PingFang SC","Microsoft YaHei",sans-serif}p{margin:0;padding:0 8vmin;text-align:center}</style></head><body><p>${escapeHtml(label.slice(0, 120))}</p></body></html>`;
}

// html 镜头有画面文档；素材 / 生成镜头有落地素材时不需要占位画面（播放器直接放原生图片 / 视频）；
// 两者都没有时用占位画面顶上，时间线照常走
export function shotSource(s: { title?: string | null | undefined; visual?: ShotVisual | null | undefined; html?: string | null | undefined; asset?: string | null | undefined }): { html: string; placeholder: boolean; kind: 'html' | 'media' } {
  const visual = s.visual ?? 'html';
  if (visual === 'html' && (s.html ?? '').trim()) return { html: s.html!, placeholder: false, kind: 'html' };
  if (visual !== 'html' && (s.asset ?? '').trim()) return { html: '', placeholder: false, kind: 'media' };
  const name = s.title ? `「${s.title}」` : '这个镜头';
  const label = visual === 'generated' ? `${name}缺素材：先生成片段` : visual === 'asset' ? `${name}缺素材` : `${name}的画面还没做`;
  return { html: placeholderShotHtml(label), placeholder: true, kind: 'html' };
}

export type ClockCommandType = 'seek' | 'play' | 'pause';
export interface ClockCommand { aw: 'video-clock'; type: ClockCommandType; t?: number | undefined }

export const clockCommand = (type: ClockCommandType, t?: number): ClockCommand => (t === undefined ? { aw: 'video-clock', type } : { aw: 'video-clock', type, t });

// 圈选元素（人给镜头留评论时用）和高亮评论钉住的元素；颜色由宿主传入令牌的计算值
export interface OverlayColors { hover: string; mark: string }
export const pickCommand = (on: boolean, colors: OverlayColors) => ({ aw: 'video-clock' as const, type: 'pick' as const, on, colors });
export const markCommand = (selector: string | null, colors: OverlayColors) => ({ aw: 'video-clock' as const, type: 'mark' as const, selector, colors });

const SELECTOR = /^body(?: > [a-z][a-z0-9-]*:nth-child\(\d{1,4}\))*$/;
export const isShotSelector = (s: string) => s.length <= 500 && SELECTOR.test(s);

export type PlayerEvent =
  | { type: 'ready'; t: number }
  | { type: 'time'; t: number }
  | { type: 'issue'; t: number; message: string }
  | { type: 'pick'; t: number; selector: string; anchor: string; tag: string };

// 沙箱里的代码也能发消息：只接受形状正确的事件，内容只当纯文本用
export function parsePlayerEvent(d: unknown): PlayerEvent | null {
  if (typeof d !== 'object' || d === null) return null;
  const m = d as Record<string, unknown>;
  if (m.aw !== 'video-frame') return null;
  const t = typeof m.t === 'number' && Number.isFinite(m.t) ? Math.min(Math.max(0, m.t), 3600) : null;
  if (t === null) return null;
  if (m.type === 'ready' || m.type === 'time') return { type: m.type, t };
  if (m.type === 'issue' && typeof m.message === 'string' && m.message.trim()) return { type: 'issue', t, message: m.message.slice(0, 300) };
  if (m.type === 'pick' && typeof m.selector === 'string' && isShotSelector(m.selector)) {
    const tag = typeof m.tag === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(m.tag) ? m.tag : '';
    return { type: 'pick', t, selector: m.selector, anchor: typeof m.anchor === 'string' ? m.anchor.slice(0, 60) : '', tag };
  }
  return null;
}

// ---- 成片：转场重叠、全片字幕、SRT ----

// 淡入 / 滑入在成片里是两个镜头交叠（ffmpeg xfade）：前一镜头的最后 overlap 秒与后一镜头的开头叠在一起，
// 所以成片总长 = 各镜头时长之和 − 各转场重叠；硬切不重叠。重叠最多 0.5 秒，且不超过相邻两个镜头各自的一半
export const TRANSITION_SECONDS = 0.5;

export const RENDER_FPS = [24, 25, 30, 60] as const;

const frames = (sec: number, fps: number) => Math.max(1, Math.round(sec * fps));

export interface RenderTimedShot { renderStart: number; renderEnd: number; duration: number; overlap: number; frames: number }

// fps 给出时按帧对齐：镜头时长 = 帧数 / fps，和逐帧渲染出来的片段一致
export function renderTimeline<T extends { duration: number; transition?: ShotTransition | null | undefined }>(shots: T[], fps?: number): { shots: (T & RenderTimedShot)[]; total: number } {
  let end = 0;
  let prev = 0;
  const out = shots.map((s, i) => {
    const n = fps ? frames(s.duration, fps) : 0;
    const duration = fps ? n / fps : s.duration;
    let overlap = 0;
    if (i > 0 && (s.transition === 'fade' || s.transition === 'slide')) {
      overlap = Math.min(TRANSITION_SECONDS, prev / 2, duration / 2);
      if (fps) overlap = Math.floor(overlap * fps) / fps;
    }
    const renderStart = end - overlap;
    end = renderStart + duration;
    prev = duration;
    return { ...s, duration: round3(duration), overlap: round3(overlap), renderStart: round3(renderStart), renderEnd: round3(end), frames: n };
  });
  return { shots: out, total: round3(end) };
}

// 镜头内时间 t 的字幕：和预览一致，最后一句一直留到镜头结束
export function cueAt(cues: SubtitleCue[], local: number, duration: number): SubtitleCue | undefined {
  return cues.find((c) => local >= c.start && local < c.end) ?? (local >= duration ? cues.at(-1) : undefined);
}

// 全片字幕：每个镜头的字幕按成片起点平移；上一镜头的最后一句截到下一镜头开始，转场重叠期间不叠两行
export function videoCues(shots: { renderStart: number; duration: number; narration?: string | null | undefined }[]): SubtitleCue[] {
  const out: SubtitleCue[] = [];
  shots.forEach((s, i) => {
    const next = shots[i + 1]?.renderStart;
    for (const c of subtitleCues(s.narration, s.duration)) {
      const start = round3(s.renderStart + c.start);
      const end = round3(Math.min(s.renderStart + c.end, next ?? Infinity));
      if (end > start) out.push({ start, end, text: c.text });
    }
  });
  return out;
}

const srtTime = (sec: number) => {
  const ms = Math.max(0, Math.round(sec * 1000));
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
};

export function buildSrt(cues: SubtitleCue[]): string {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text.replace(/\r?\n/g, ' ')}\n`).join('\n');
}

// 烧进画面的字幕版式：和播放器的 Subtitle 同一套几何（短边 4.5% 字号、底部 6%、左右 6%），字体可换
export const SUBTITLE_FONT = 'system-ui, "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';

export type SubtitleSize = 's' | 'm' | 'l';
export type SubtitlePosition = 'bottom' | 'top';
export type SubtitleBackground = 'box' | 'shadow' | 'none';
export interface SubtitleLook { size?: SubtitleSize | undefined; position?: SubtitlePosition | undefined; background?: SubtitleBackground | undefined }

const SUB_SCALE: Record<SubtitleSize, number> = { s: 0.036, m: 0.045, l: 0.056 };
type Css = Record<string, string>;

// 字幕版式的唯一来源：成片烧字幕拼成 CSS，预览播放器原样当内联样式用（再整体按画面缩放），两边像素一致
export function subtitleLayout(width: number, height: number, font?: string | null | undefined, look?: SubtitleLook | null | undefined): { p: Css; span: Css; size: number } {
  const size = Math.max(12, Math.round(Math.min(width, height) * SUB_SCALE[look?.size ?? 'm']));
  const family = font?.trim() ? `${JSON.stringify(font.trim())}, ${SUBTITLE_FONT}` : SUBTITLE_FONT;
  const p: Css = { position: 'absolute', left: '6%', right: '6%', [look?.position === 'top' ? 'top' : 'bottom']: '6%', margin: '0', textAlign: 'center', font: `500 ${size}px/1.5 ${family}` };
  const bg = look?.background ?? 'box';
  const span: Css = bg === 'box'
    ? { background: 'rgba(20,20,22,.75)', color: '#fff', borderRadius: '.25em', padding: '.08em .45em', WebkitBoxDecorationBreak: 'clone', boxDecorationBreak: 'clone' }
    : bg === 'shadow'
      ? { color: '#fff', textShadow: '0 0 .25em rgba(0,0,0,.95), 0 .06em .12em rgba(0,0,0,.95)' }
      : { color: '#fff' };
  return { p, span, size };
}

const cssText = (o: Css) => Object.entries(o).map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${v}`).join(';');

export function subtitleOverlayCss(width: number, height: number, font?: string | null | undefined, look?: SubtitleLook | null | undefined): string {
  const l = subtitleLayout(width, height, font, look);
  return `p{${cssText(l.p)}}span{${cssText(l.span)}}`;
}

// ---- 风格：CSS 变量 ----

export interface VideoPalette { bg?: string | undefined; fg?: string | undefined; accent?: string | undefined; muted?: string | undefined; [key: string]: string | undefined }
export interface VideoFonts { heading?: string | undefined; body?: string | undefined }
export interface VideoLook { palette?: VideoPalette | null | undefined; fonts?: VideoFonts | null | undefined }

export const DEFAULT_PALETTE = { bg: '#14202b', fg: '#f4f1ea', accent: '#f2a541', muted: '#8a96a3' } as const;
export const DEFAULT_FONT = 'system-ui, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';

const COLOR = /^(?:#[0-9a-f]{3,8}|(?:rgba?|hsla?)\([\d\s.,%/+-]{1,60}\)|[a-z]{3,20})$/i;
const FONT_LIST = /^[\p{L}\p{N} ,"'_-]{1,200}$/u;
const PALETTE_KEY = /^[a-z][a-z0-9-]{0,23}$/;

// 值会拼进 <style>：颜色和字体只收白名单字符，挡住 ; { } url( 之类
export function lookError(look: VideoLook): string | null {
  const entries = Object.entries(look.palette ?? {});
  if (entries.length > 16) return '调色板最多 16 个颜色';
  for (const [k, v] of entries) {
    if (!PALETTE_KEY.test(k)) return `颜色名 ${k} 只能用小写字母、数字和 -`;
    if (v !== undefined && !COLOR.test(v.trim())) return `颜色 ${k} 的值不合法（用 #rrggbb、rgb()、hsl() 或颜色名）`;
  }
  for (const [k, v] of Object.entries(look.fonts ?? {})) {
    if (v !== undefined && v.trim() && !FONT_LIST.test(v.trim())) return `字体 ${k} 只能写字体名列表（逗号分隔，可加引号）`;
  }
  return null;
}

export function styleVars(look: VideoLook | null | undefined): Record<string, string> {
  const palette = { ...DEFAULT_PALETTE, ...Object.fromEntries(Object.entries(look?.palette ?? {}).filter(([k, v]) => PALETTE_KEY.test(k) && v && COLOR.test(v.trim())).map(([k, v]) => [k, v!.trim()])) };
  const font = (v: string | undefined) => (v?.trim() && FONT_LIST.test(v.trim()) ? `${v.trim()}, ${DEFAULT_FONT}` : DEFAULT_FONT);
  const out: Record<string, string> = {};
  for (const k of Object.keys(palette).sort()) out[`--aw-${k}`] = palette[k as keyof typeof palette];
  out['--aw-font-heading'] = font(look?.fonts?.heading);
  out['--aw-font-body'] = font(look?.fonts?.body);
  return out;
}

// 只给 html 元素铺底色、字色和正文字体（选择器最弱），镜头自己的样式照常覆盖
export function styleCss(look: VideoLook | null | undefined): string {
  const vars = Object.entries(styleVars(look)).map(([k, v]) => `${k}:${v}`).join(';');
  return `:root{${vars}}html{background:var(--aw-bg);color:var(--aw-fg);font-family:var(--aw-font-body)}`;
}

// ---- 审片：内容哈希的输入、状态、出片门禁 ----

export interface HashShot {
  id: string;
  narration?: string | null | undefined;
  visual?: ShotVisual | null | undefined;
  // html 画面的原文（缺画面时是占位画面）；generated / asset 时是素材产物 id
  source: string;
  duration: number;
  transition?: ShotTransition | null | undefined;
  // 新鲜配音的 textHash（含 provider / 音色 / 语速）；没有或过期为 null
  voice: string | null;
  // 素材镜头的运动、叠加画面原文和是否保留原声
  motion?: ShotMotionKind | undefined;
  overlay?: string | null | undefined;
  keepAudio?: boolean | undefined;
}

export interface HashVideo { width: number; height: number; fps: number; subtitles: string; voiceOn: boolean }

// 审片结论钉在「成片会是什么样」上：镜头按顺序的旁白、画面、生效时长、转场、配音，加尺寸 / 帧率 / 字幕 / 风格。
// 讲解稿、标题、备注不进哈希：改它们不影响成片，审片结论不该作废
export function videoHashInput(video: HashVideo, shots: HashShot[], styleKey: string): string {
  return JSON.stringify([
    'video-v2',
    [video.width, video.height, video.fps, video.subtitles, video.voiceOn],
    styleKey,
    shots.map((s) => [s.id, (s.narration ?? '').replace(/\s+/g, ' ').trim(), s.visual ?? 'html', s.source, round3(s.duration), s.transition ?? 'cut', s.voice, ...shotExtras(s)]),
  ]);
}

const shotExtras = (s: HashShot) => [s.motion ?? 'none', (s.overlay ?? '').trim(), s.keepAudio === true];

// 单个镜头的内容哈希输入：成片对比按镜头比「这一镜变了没有」
export function shotHashInput(s: HashShot): string {
  return JSON.stringify(['shot-v1', s.id, (s.narration ?? '').replace(/\s+/g, ' ').trim(), s.visual ?? 'html', s.source, round3(s.duration), s.transition ?? 'cut', s.voice, ...shotExtras(s)]);
}

export interface StyleKeyInput { look: VideoLook | null | undefined; subtitle?: SubtitleLook | null | undefined; bgm?: string | null | undefined; bgmVolume?: number | null | undefined; ducking?: boolean | null | undefined }

export function styleKeyOf(i: StyleKeyInput): string {
  const sub = i.subtitle ?? {};
  return JSON.stringify([styleVars(i.look), [sub.size ?? 'm', sub.position ?? 'bottom', sub.background ?? 'box'], i.bgm ?? null, i.bgm ? round3(i.bgmVolume ?? DEFAULT_BGM_VOLUME) : null, i.bgm ? i.ducking !== false : null]);
}

export const DEFAULT_BGM_VOLUME = 0.15;

export interface ReviewRef { verdict: 'pass' | 'fail'; contentHash: string }

// 状态由平台按内容哈希推出来：审片通过且哈希没变才是 approved；出片时的哈希也对得上才是 rendered；
// 请求审片后内容没变保持 reviewing；其余（包括改了内容）回到 storyboarded，没有镜头是 draft
export function deriveVideoStatus(i: { status?: VideoStatus | null | undefined; contentHash: string; shots: number; review?: ReviewRef | null | undefined; reviewRequestHash?: string | null | undefined; renderHash?: string | null | undefined }): VideoStatus {
  if (i.shots === 0) return 'draft';
  const approved = i.review?.verdict === 'pass' && i.review.contentHash === i.contentHash;
  if (approved && i.renderHash === i.contentHash) return 'rendered';
  if (approved) return 'approved';
  if (i.status === 'reviewing' && i.reviewRequestHash === i.contentHash) return 'reviewing';
  return 'storyboarded';
}

export type GateCheckId = 'review' | 'lint' | 'comments' | 'voice';
export interface GateCheck { id: GateCheckId; label: string; ok: boolean; detail: string }

export interface RenderGateInput {
  review: ReviewRef | null | undefined;
  contentHash: string;
  lintErrors: string[];
  openBlocks: number;
  voiceOn: boolean;
  // 有旁白但没有新鲜配音的镜头名
  unvoiced: string[];
}

export function evaluateRenderGate(i: RenderGateInput): { ok: boolean; checks: GateCheck[]; reasons: string[] } {
  const review: GateCheck = !i.review
    ? { id: 'review', label: '审片通过', ok: false, detail: '还没有审片结论' }
    : i.review.contentHash !== i.contentHash
      ? { id: 'review', label: '审片通过', ok: false, detail: '审片后内容改过，需要重新审片' }
      : i.review.verdict !== 'pass'
        ? { id: 'review', label: '审片通过', ok: false, detail: '审片没通过' }
        : { id: 'review', label: '审片通过', ok: true, detail: '审片通过，内容没再改过' };
  const lint: GateCheck = i.lintErrors.length
    ? { id: 'lint', label: '检查没有错误', ok: false, detail: `${i.lintErrors.length} 个错误：${i.lintErrors.slice(0, 3).join('；')}` }
    : { id: 'lint', label: '检查没有错误', ok: true, detail: '没有 error 级问题' };
  const comments: GateCheck = i.openBlocks > 0
    ? { id: 'comments', label: '阻断评论已解决', ok: false, detail: `${i.openBlocks} 条阻断评论未解决` }
    : { id: 'comments', label: '阻断评论已解决', ok: true, detail: '没有未解决的阻断评论' };
  const voice: GateCheck = !i.voiceOn
    ? { id: 'voice', label: '配音齐全', ok: true, detail: '这支视频不配音' }
    : i.unvoiced.length
      ? { id: 'voice', label: '配音齐全', ok: false, detail: `${i.unvoiced.length} 个有旁白的镜头没有最新配音：${i.unvoiced.slice(0, 3).join('、')}` }
      : { id: 'voice', label: '配音齐全', ok: true, detail: '有旁白的镜头都有最新配音' };
  const checks = [review, lint, comments, voice];
  return { ok: checks.every((c) => c.ok), checks, reasons: checks.filter((c) => !c.ok).map((c) => c.detail) };
}

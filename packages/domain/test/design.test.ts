import { describe, expect, it } from 'vitest';
import { applyTextEdits, composeDesignDoc, designStyles, injectHead, lintDesign, type DesignTweak } from '../src/design.js';

const knob: DesignTweak = { id: 'r', label: '圆角', cssVar: '--r', type: 'range', value: '8', unit: 'px' };

describe('composeDesignDoc', () => {
  it('插在 head 开头，稿子自己的样式能覆盖令牌', () => {
    const doc = composeDesignDoc('<!doctype html><html><head><style>a{}</style></head><body></body></html>', { tokens: [{ name: '--x', value: '1px' }], tweaks: [], head: '<meta name="a">' });
    expect(doc.indexOf('--x')).toBeLessThan(doc.indexOf('a{}'));
    expect(doc.indexOf('<meta name="a">')).toBeLessThan(doc.indexOf('--x'));
  });

  it('没有 head / html 时也不破坏 doctype 与正文结构', () => {
    expect(injectHead('<!doctype html><p>x</p>', '<i>')).toBe('<!doctype html><head><i></head><p>x</p>');
    expect(injectHead('<html><body></body></html>', '<i>')).toBe('<html><head><i></head><body></body></html>');
    expect(injectHead('<p>x</p>', '<i>')).toBe('<head><i></head><p>x</p>');
  });

  it('旋钮带单位且优先级高于令牌', () => {
    expect(designStyles([{ name: '--r', value: '2px' }], [knob])).toBe(':root{--r:2px}:root:root{--r:8px}');
  });

  it('丢弃能逃出 style 标签或串改规则的值', () => {
    expect(designStyles([{ name: '--a', value: '</style><script>' }, { name: 'bad', value: '1' }, { name: '--b', value: '1;color:red' }], [])).toBe('');
  });
});

describe('applyTextEdits', () => {
  it('按序替换', () => {
    expect(applyTextEdits('a b', [{ oldText: 'a', newText: 'c' }, { oldText: 'b', newText: 'd' }])).toEqual({ ok: true, html: 'c d', replaced: 2 });
  });
  it('找不到或不唯一都失败，不做部分修改', () => {
    expect(applyTextEdits('a', [{ oldText: 'z', newText: '' }]).ok).toBe(false);
    expect(applyTextEdits('a a', [{ oldText: 'a', newText: 'b' }]).ok).toBe(false);
    expect(applyTextEdits('a', [{ oldText: '', newText: 'b' }]).ok).toBe(false);
  });
});

describe('lintDesign', () => {
  const ctx = { tokens: [{ name: '--ok', value: '1' }], tweaks: [] };
  it('干净的稿子没有警告', () => {
    expect(lintDesign('<style>:root{--own:1}a{color:var(--ok);margin:var(--own);padding:var(--nope, 0)}</style>', ctx)).toEqual([]);
  });
  it('指出不存在的令牌、死旋钮、写死的颜色、会被拦的脚本和网络调用', () => {
    const w = lintDesign('<style>a{color:var(--nope);b:#111;c:#222;d:#333;e:rgb(0,0,0)}</style><script src="https://evil.test/x.js"></script><script>fetch("/x")</script>', { tokens: ctx.tokens, tweaks: [knob] }).join('\n');
    for (const s of ['--nope', '4 处写死', '--r', 'evil.test', 'fetch']) expect(w).toContain(s);
  });
});

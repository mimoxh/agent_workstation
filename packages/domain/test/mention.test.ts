import { describe, expect, it } from 'vitest';
import { extractMentions } from '../src/mention.js';

const members = [
  { id: 'a', name: '前端开发' },
  { id: 'b', name: '前端开发 #2' },
  { id: 'c', name: '架构师' },
];

describe('extractMentions', () => {
  it('最长名优先，不误中前缀相同的成员', () => {
    expect(extractMentions('@前端开发 #2 看下', members)).toEqual(['b']);
    expect(extractMentions('@前端开发 看下', members)).toEqual(['a']);
  });

  it('中文紧贴后文也能识别，重复只算一次', () => {
    expect(extractMentions('@架构师你看 @架构师', members)).toEqual(['c']);
  });

  it('多人按出现顺序，未知名忽略', () => {
    expect(extractMentions('@架构师 和 @前端开发，还有 @路人', members)).toEqual(['c', 'a']);
  });
});

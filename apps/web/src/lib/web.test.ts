import { describe, expect, it } from 'vitest';
import { filterTasks } from '../components/board/filter';
import { fromChecks, toChecks } from '../components/board/schemaForm';
import { mentionQuery } from '../components/chat/mention';
import { foldByDecision } from '../components/timeline/fold';
import { parseDiff } from './diff';
import { duration, parseJson, seconds, tokens, when } from './format';
import { keysFor } from './live';

describe('parseDiff', () => {
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 111..222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -10,3 +10,4 @@ function x() {',
    ' keep',
    '-old',
    '+new',
    '+added',
    ' tail',
    'diff --git a/b c.txt b/b c.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/b c.txt',
    '@@ -0,0 +1 @@',
    '+hello',
  ].join('\n');

  it('按文件切分并统计增删', () => {
    const files = parseDiff(patch);
    expect(files.map((f) => [f.path, f.additions, f.deletions])).toEqual([['src/a.ts', 2, 1], ['b c.txt', 1, 0]]);
  });

  it('文件头的 --- / +++ 不算增删行', () => {
    expect(parseDiff(patch)[0]!.lines.filter((l) => l.kind === 'del').map((l) => l.text)).toEqual(['old']);
  });

  it('行号跟随 hunk 递增，新增行没有旧行号', () => {
    const lines = parseDiff(patch)[0]!.lines.slice(1);
    expect(lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ['ctx', 10, 10],
      ['del', 11, null],
      ['add', null, 11],
      ['add', null, 12],
      ['ctx', 12, 13],
    ]);
  });

  it('空补丁与 CRLF', () => {
    expect(parseDiff('')).toEqual([]);
    const f = parseDiff('diff --git a/x b/x\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n')[0]!;
    expect(f.lines.at(-1)!.text).toBe('b');
  });
});

describe('filterTasks', () => {
  const names = { ws: { w1: '开发' }, agent: { a1: '前端开发' } };
  const t = (title: string, status: string, extra: Partial<{ inputJson: string; assigneeId: string }> = {}) => ({ title, status, inputJson: null, assigneeId: null, ...extra });
  const tasks = [
    t('看板筛选', 'in_progress', { inputJson: '{"module":"apps/web"}', assigneeId: 'a1' }),
    t('修复登录', 'blocked'),
    t('已合并', 'done'),
    t('废弃', 'cancelled'),
  ];
  const titles = (f: Parameters<typeof filterTasks>[1]) => filterTasks(tasks, f, names).map((x) => x.title);

  it('空筛选返回全部', () => expect(titles({})).toHaveLength(4));
  it('按标题、模块、指派搜索', () => {
    expect(titles({ q: '登录' })).toEqual(['修复登录']);
    expect(titles({ q: 'APPS/web' })).toEqual(['看板筛选']);
    expect(titles({ q: '前端' })).toEqual(['看板筛选']);
  });
  it('状态分组', () => {
    expect(titles({ status: 'open' })).toEqual(['看板筛选', '修复登录']);
    expect(titles({ status: 'attention' })).toEqual(['修复登录']);
    expect(titles({ status: 'done' })).toEqual(['已合并', '废弃']);
  });
  it('搜索与状态同时生效', () => expect(titles({ q: '看板', status: 'done' })).toEqual([]));
});

describe('验收命令', () => {
  it('多行文本与 check 互转，忽略空行', () => {
    const checks = toChecks('pnpm build\n\n  pnpm test  \n');
    expect(checks.map((c) => c.run)).toEqual(['pnpm build', 'pnpm test']);
    expect(fromChecks(JSON.stringify(checks))).toBe('pnpm build\npnpm test');
  });
  it('坏 JSON 不抛错', () => expect(fromChecks('{')).toBe(''));
});

describe('mentionQuery', () => {
  it('只在 @ 紧贴光标的词上触发', () => {
    expect(mentionQuery('hi @架', 5)).toBe('架');
    expect(mentionQuery('@', 1)).toBe('');
    expect(mentionQuery('hi @架构师 好', 9)).toBeNull();
    expect(mentionQuery('a@b.com', 7)).toBeNull();
  });
});

describe('foldByDecision', () => {
  const rows = (kinds: string[]) => foldByDecision(kinds, (k) => k === 'chat', (k) => k === 'decision');

  it('结论收起它之前的聊天，其他条目保留原位', () => {
    expect(rows(['chat', 'status', 'chat', 'decision'])).toEqual([
      { item: 'status', folded: [] },
      { item: 'decision', folded: ['chat', 'chat'] },
    ]);
  });
  it('结论之后的聊天不被折叠', () => {
    expect(rows(['chat', 'decision', 'chat'])).toEqual([
      { item: 'decision', folded: ['chat'] },
      { item: 'chat', folded: [] },
    ]);
  });
  it('没有结论时全部展开并保持时间顺序', () => {
    expect(rows(['chat', 'status', 'chat'])).toEqual([
      { item: 'chat', folded: [] },
      { item: 'status', folded: [] },
      { item: 'chat', folded: [] },
    ]);
  });
});

describe('format', () => {
  it('tokens 分档', () => {
    expect(tokens(null)).toBe('0');
    expect(tokens(9999)).toBe('9,999');
    expect(tokens(46310)).toBe('46.3k');
    expect(tokens(1_500_000)).toBe('1.5M');
  });
  it('seconds 跨分钟', () => {
    expect(seconds(4.56)).toBe('4.6s');
    expect(seconds(65)).toBe('1:05');
  });
  it('duration 用结束时间，缺开始时间给占位', () => {
    expect(duration('2026-01-01T00:00:00Z', '2026-01-01T00:00:02Z')).toBe('2.0s');
    expect(duration(null)).toBe('—');
  });
  it('when 当天只显示时分', () => {
    const now = new Date(2026, 10, 6, 12);
    expect(when(new Date(2026, 10, 6, 9, 5).toISOString(), now)).toBe('09:05');
    expect(when(new Date(2026, 10, 5, 9, 5).toISOString(), now)).toBe('11-05 09:05');
  });
  it('parseJson 兜底', () => {
    expect(parseJson('{', 1)).toBe(1);
    expect(parseJson(null, 2)).toBe(2);
  });
});

describe('实时失效映射', () => {
  it('任务变更刷新看板、详情和收件箱', () => {
    expect(keysFor('task_status_changed')).toEqual(expect.arrayContaining(['tasks', 'task', 'inbox']));
  });
  it('消息刷新时间线和会话', () => expect(keysFor('message_created')).toEqual(['timeline', 'thread-messages']));
  it('运行步骤只刷新脉搏和时间线', () => expect(keysFor('run_step')).toEqual(['pulse', 'timeline']));
  it('未知动作不触发刷新', () => expect(keysFor('unknown_action')).toEqual([]));
});

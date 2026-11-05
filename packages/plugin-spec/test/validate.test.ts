import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateInput, validateManifest } from '../src/index.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const load = (name: string) => JSON.parse(fs.readFileSync(path.join(dir, `../../plugins/${name}/manifest.json`), 'utf8'));

const pm = load('pm');
const dev = load('dev');

describe('validateManifest', () => {
  it.each(['pm', 'dev'])('%s manifest 通过', (name) => {
    const r = validateManifest(load(name));
    expect(r.ok, r.ok ? '' : r.errors.join('; ')).toBe(true);
  });

  it('steward 不存在 → 报错', () => {
    const r = validateManifest({ ...pm, steward: 'nope' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain('steward');
  });

  it('面板引用不存在的实体 → 报错', () => {
    const bad = structuredClone(pm) as typeof pm;
    bad.panels[0]!.entity = 'Ghost';
    const r = validateManifest(bad);
    expect(r.ok).toBe(false);
  });

  it('system: 前缀实体 → 报错', () => {
    const bad = structuredClone(pm) as typeof pm;
    bad.entities['system:x'] = { label: 'x', description: 'x', titleField: 'n', fields: {} };
    const r = validateManifest(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain('system:');
  });

  it('stage 引用不存在的 Agent → 报错', () => {
    const bad = structuredClone(dev) as typeof dev;
    bad.stages![0]!.activeAgents = ['ghost'];
    const r = validateManifest(bad);
    expect(r.ok).toBe(false);
  });

  it('任务类型引用不存在的 stage → 报错', () => {
    const bad = structuredClone(dev) as typeof dev;
    bad.tasks[0]!.stages = ['nope'];
    const r = validateManifest(bad);
    expect(r.ok).toBe(false);
  });

  it('Agent 声明未知工具 → 报错', () => {
    const bad = structuredClone(pm) as typeof pm;
    bad.agents[0]!.tools = ['hack_everything'];
    const r = validateManifest(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain('hack_everything');
  });

  it('zod 结构不合法 → 报错', () => {
    const r = validateManifest({ id: 'x' });
    expect(r.ok).toBe(false);
  });
});

describe('validateInput', () => {
  const schema = {
    type: 'object',
    required: ['title', 'module'],
    properties: {
      title: { type: 'string' },
      kind: { type: 'string', enum: ['feature', 'bug'] },
      module: { type: 'string' },
    },
  };
  it('合法 input 通过', () => {
    expect(validateInput(schema, { title: 't', kind: 'feature', module: 'm' })).toEqual([]);
  });
  it('缺必填 → 报错', () => {
    expect(validateInput(schema, { title: 't' }).join()).toContain('module');
  });
  it('enum 越界 → 报错', () => {
    expect(validateInput(schema, { title: 't', module: 'm', kind: 'x' }).length).toBeGreaterThan(0);
  });
});

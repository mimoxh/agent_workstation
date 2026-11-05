import { describe, expect, it } from 'vitest';
import { can } from '../src/permission.js';
import type { PermCtx, Scope } from '../src/scope.js';
import type { Actor } from '../src/actor.js';
import type { Right } from '../src/permission.js';

// 树：root → dev → dev-sub；root → sales（dev 的兄弟）
const ctx = (agent?: PermCtx['agent'], grants: PermCtx['grants'] = []): PermCtx => ({
  workstations: [
    { id: 'root', parentId: null },
    { id: 'dev', parentId: 'root' },
    { id: 'dev-sub', parentId: 'dev' },
    { id: 'sales', parentId: 'root' },
  ],
  agent,
  grants,
});

const human: Actor = { type: 'human', id: 'local' };
const ws = (id: string): Scope => ({ type: 'workstation', id });

const cases: Array<[string, Actor, Right, string, PermCtx, boolean]> = [
  ['人全项目', human, 'invoke', 'sales', ctx(), true],
  ['本台四权', { type: 'agent', id: 'a1' }, 'speak', 'dev', ctx({ id: 'a1', workstationId: 'dev', isSteward: false }), true],
  ['本台 invoke', { type: 'agent', id: 'a1' }, 'invoke', 'dev', ctx({ id: 'a1', workstationId: 'dev', isSteward: false }), true],
  ['祖先 observe', { type: 'agent', id: 'a1' }, 'observe', 'root', ctx({ id: 'a1', workstationId: 'dev', isSteward: false }), true],
  ['祖先无 invoke', { type: 'agent', id: 'a1' }, 'invoke', 'root', ctx({ id: 'a1', workstationId: 'dev', isSteward: false }), false],
  ['普通 agent 父级无 speak', { type: 'agent', id: 'a1' }, 'speak', 'root', ctx({ id: 'a1', workstationId: 'dev', isSteward: false }), false],
  ['steward 父级 speak', { type: 'agent', id: 'a1' }, 'speak', 'root', ctx({ id: 'a1', workstationId: 'dev', isSteward: true }), true],
  ['steward 隔级无 speak', { type: 'agent', id: 'a1' }, 'speak', 'root', ctx({ id: 'a1', workstationId: 'dev-sub', isSteward: true }), false],
  ['子孙 invoke', { type: 'agent', id: 'a1' }, 'invoke', 'dev-sub', ctx({ id: 'a1', workstationId: 'dev', isSteward: false }), true],
  ['子孙 observe', { type: 'agent', id: 'a1' }, 'observe', 'dev-sub', ctx({ id: 'a1', workstationId: 'dev', isSteward: false }), true],
  ['兄弟全无', { type: 'agent', id: 'a1' }, 'observe', 'sales', ctx({ id: 'a1', workstationId: 'dev', isSteward: false }), false],
  [
    '显式 grant 兄弟 speak',
    { type: 'agent', id: 'a1' },
    'speak',
    'sales',
    ctx({ id: 'a1', workstationId: 'dev', isSteward: false }, [
      { subjectType: 'agent', subjectId: 'a1', scopeType: 'workstation', scopeId: 'sales', rights: ['speak'] },
    ]),
    true,
  ],
  [
    'grant 不给的仍无',
    { type: 'agent', id: 'a1' },
    'invoke',
    'sales',
    ctx({ id: 'a1', workstationId: 'dev', isSteward: false }, [
      { subjectType: 'agent', subjectId: 'a1', scopeType: 'workstation', scopeId: 'sales', rights: ['observe'] },
    ]),
    false,
  ],
];

describe('can', () => {
  it.each(cases)('%s：%s %s → %s', (_name, actor, right, target, c, expected) => {
    expect(can(actor, right, ws(target), c)).toBe(expected);
  });
});

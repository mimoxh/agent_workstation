import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { FAKE_HARNESS_SOURCE } from './scripts.js';
import type { HarnessAdapter, TurnReport } from './types.js';

export const fakeHarness: HarnessAdapter = {
  id: 'fake',
  label: 'Fake（测试）',
  presetSession: true,
  resolveBin: () => process.execPath,
  versionArgs: ['--version'],
  models: () => ({ defaultModel: 'fake-default', models: [{ id: 'fake-fast', label: 'Fake Fast' }, { id: 'fake-pro', label: 'Fake Pro' }] }),
  launch: (bin, spec) => {
    const script = path.join(spec.runDir, 'fake-harness.cjs');
    writeFileSync(script, FAKE_HARNESS_SOURCE);
    return { file: bin, args: [script, spec.mcpUrl, spec.token, spec.hook.url, spec.sessionId ?? '', spec.contextFile] };
  },
  parseTurn: async (payload): Promise<TurnReport> => ({
    sessionId: typeof payload.session_id === 'string' ? payload.session_id : undefined,
    lastMessage: typeof payload.last_message === 'string' ? payload.last_message : undefined,
    usage: payload.usage as TurnReport['usage'],
  }),
};

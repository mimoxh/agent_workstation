import { builtinManifests } from '@aw/plugins';
import { validateManifest, type WorkbenchManifest } from '@aw/plugin-spec';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROMPTS_DIRS = [
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../packages/plugins'),
  path.resolve(process.cwd(), '../../packages/plugins'),
];

// 启动时装载全部内置 manifest，任一失败即抛错（进程退出）
export const pluginRegistry = new Map<string, WorkbenchManifest>();

export function loadPlugins() {
  pluginRegistry.clear();
  for (const raw of builtinManifests) {
    const r = validateManifest(raw);
    if (!r.ok) {
      throw new Error(`内置插件 ${(raw as { id?: string }).id} 校验失败：${r.errors.join('; ')}`);
    }
    // promptFile 指向的文件必须存在（加载失败要报错）
    for (const a of r.manifest.agents) {
      if (!a.promptFile) continue;
      const dir = PROMPTS_DIRS.find((d) => existsSync(path.join(d, r.manifest.id, 'prompts', a.promptFile!)));
      if (!dir) throw new Error(`插件 ${r.manifest.id} agent ${a.id} 的 promptFile ${a.promptFile} 不存在`);
      (a as { promptContent?: string }).promptContent = readFileSync(path.join(dir, r.manifest.id, 'prompts', a.promptFile), 'utf8');
    }
    pluginRegistry.set(r.manifest.id, r.manifest);
  }
  return pluginRegistry;
}

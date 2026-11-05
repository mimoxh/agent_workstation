import { builtinManifests } from '@aw/plugins';
import { validateManifest, type WorkbenchManifest } from '@aw/plugin-spec';

// 启动时装载全部内置 manifest，任一失败即抛错（进程退出）
export const pluginRegistry = new Map<string, WorkbenchManifest>();

export function loadPlugins() {
  pluginRegistry.clear();
  for (const raw of builtinManifests) {
    const r = validateManifest(raw);
    if (!r.ok) {
      throw new Error(`内置插件 ${(raw as { id?: string }).id} 校验失败：${r.errors.join('; ')}`);
    }
    pluginRegistry.set(r.manifest.id, r.manifest);
  }
  return pluginRegistry;
}

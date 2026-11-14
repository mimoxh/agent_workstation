import dev from '../dev/manifest.json' with { type: 'json' };
import docs from '../docs/manifest.json' with { type: 'json' };
import pm from '../pm/manifest.json' with { type: 'json' };

export const builtinManifests = [pm, dev, docs] as const;

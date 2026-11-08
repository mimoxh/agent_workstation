import design from '../design/manifest.json' with { type: 'json' };
import dev from '../dev/manifest.json' with { type: 'json' };
import pm from '../pm/manifest.json' with { type: 'json' };

export const builtinManifests = [pm, dev, design] as const;

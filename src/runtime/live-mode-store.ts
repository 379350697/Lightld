import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { z } from 'zod';

export const LiveModeSchema = z.enum(['OFF', 'SHADOW', 'LIVE']);

export const LiveModeStateSchema = z.object({
  globalMode: LiveModeSchema,
  liveStrategies: z.array(z.string()),
  killSwitchEngaged: z.boolean()
});

export type LiveMode = z.infer<typeof LiveModeSchema>;
export type LiveModeState = z.infer<typeof LiveModeStateSchema>;

export const DEFAULT_LIVE_MODE_STATE: LiveModeState = {
  globalMode: 'OFF',
  liveStrategies: [],
  killSwitchEngaged: false
};

export class LiveModeStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async write(state: LiveModeState) {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(LiveModeStateSchema.parse(state), null, 2), 'utf8');
  }

  async read(): Promise<LiveModeState> {
    try {
      const raw = await readFile(this.path, 'utf8');

      return LiveModeStateSchema.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return DEFAULT_LIVE_MODE_STATE;
      }

      throw error;
    }
  }
}

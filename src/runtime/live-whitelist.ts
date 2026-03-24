import { readFile } from 'node:fs/promises';

import { z } from 'zod';

const LiveWhitelistSchema = z.object({
  tokens: z.array(z.string())
});

export class LiveWhitelist {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async read(): Promise<string[]> {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = LiveWhitelistSchema.parse(JSON.parse(raw));

      return [...new Set(parsed.tokens)];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }

      throw error;
    }
  }
}

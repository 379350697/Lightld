import fsRaw from 'fs';
import pathRaw from 'path';
import { fileURLToPath } from 'url';

export type NewTokenPoolStatus = 'pending' | 'promoted' | 'expired';

export type NewTokenPoolEntry = {
  tokenMint: string;
  firstSeenAt: string;
  lastSeenAt: string;
  source: string;
  tokenSymbol?: string;
  pairAddress?: string;
  status: NewTokenPoolStatus;
};

export type NewTokenPoolData = {
  tokens: NewTokenPoolEntry[];
};

export class NewTokenPoolStore {
  private readonly filePath: string;
  private readonly expiryMs = 48 * 60 * 60 * 1000;

  constructor(filePath?: string) {
    if (filePath) {
      this.filePath = filePath;
    } else {
      const __dirname = pathRaw.dirname(fileURLToPath(import.meta.url));
      this.filePath = pathRaw.join(__dirname, '../../../state/new-token-pool.json');
    }
  }

  private getStoreDir(): string {
    return pathRaw.dirname(this.filePath);
  }

  private ensureStoreExists() {
    const dir = this.getStoreDir();
    if (!fsRaw.existsSync(dir)) {
      fsRaw.mkdirSync(dir, { recursive: true });
    }
    if (!fsRaw.existsSync(this.filePath)) {
      this.writeAtomic({ tokens: [] });
    }
  }

  private writeAtomic(data: NewTokenPoolData) {
    const tempFile = `${this.filePath}.${Date.now()}.tmp`;
    fsRaw.writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf8');
    fsRaw.renameSync(tempFile, this.filePath);
  }

  public readAll(): NewTokenPoolEntry[] {
    this.ensureStoreExists();
    try {
      const raw = fsRaw.readFileSync(this.filePath, 'utf8');
      const data = JSON.parse(raw) as NewTokenPoolData;
      return data.tokens || [];
    } catch {
      return [];
    }
  }

  public upsertToken(input: {
    tokenMint: string;
    source: string;
    tokenSymbol?: string;
    pairAddress?: string;
    seenAt?: string;
  }) {
    const tokens = this.readAll();
    const seenAt = input.seenAt ?? new Date().toISOString();
    const existing = tokens.find((entry) => entry.tokenMint === input.tokenMint);

    if (existing) {
      existing.lastSeenAt = seenAt;
      if (input.tokenSymbol) existing.tokenSymbol = input.tokenSymbol;
      if (input.pairAddress) existing.pairAddress = input.pairAddress;
    } else {
      tokens.push({
        tokenMint: input.tokenMint,
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
        source: input.source,
        tokenSymbol: input.tokenSymbol,
        pairAddress: input.pairAddress,
        status: 'pending'
      });
    }

    this.writeAtomic({ tokens });
  }

  public getActiveTokens(): NewTokenPoolEntry[] {
    const tokens = this.readAll();
    const now = Date.now();
    let hasChanges = false;

    for (const token of tokens) {
      if (token.status === 'pending') {
        const age = now - new Date(token.firstSeenAt).getTime();
        if (age > this.expiryMs) {
          token.status = 'expired';
          hasChanges = true;
        }
      }
    }

    if (hasChanges) {
      this.writeAtomic({ tokens });
    }

    return tokens.filter((token) => token.status === 'pending');
  }

  public markPromoted(tokenMint: string) {
    const tokens = this.readAll();
    const target = tokens.find((entry) => entry.tokenMint === tokenMint);
    if (target) {
      target.status = 'promoted';
      this.writeAtomic({ tokens });
    }
  }
}

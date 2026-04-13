import fsRaw from 'fs';
import pathRaw from 'path';
import { fileURLToPath } from 'url';

export type SignalStatus = 'pending' | 'processing' | 'completed' | 'expired';

export type TokenSignal = {
  id: string;
  tokenMint: string;
  tokenSymbol: string;
  pairAddress: string;
  source: string;
  discoveredAt: string;
  status: SignalStatus;
  metrics: {
    tvl: number;
    volume24h: number;
    rugpullScore: number;
    bluechipPercent: number;
    sniperPercent: number;
  };
};

export type SignalStoreData = {
  signals: TokenSignal[];
};

export class SignalStore {
  private readonly filePath: string;
  private readonly expiryMs = 2 * 60 * 60 * 1000; // 2 hours

  constructor(filePath?: string) {
    if (filePath) {
      this.filePath = filePath;
    } else {
      const __dirname = pathRaw.dirname(fileURLToPath(import.meta.url));
      this.filePath = pathRaw.join(__dirname, '../../../state/signals.json');
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
      this.writeAtomic({ signals: [] });
    }
  }

  private writeAtomic(data: SignalStoreData) {
    const tempFile = `${this.filePath}.${Date.now()}.tmp`;
    fsRaw.writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf8');
    fsRaw.renameSync(tempFile, this.filePath);
  }

  public readAll(): TokenSignal[] {
    this.ensureStoreExists();
    try {
      const raw = fsRaw.readFileSync(this.filePath, 'utf8');
      const data = JSON.parse(raw) as SignalStoreData;
      return data.signals || [];
    } catch (err) {
      return [];
    }
  }

  public pushSignal(signal: Omit<TokenSignal, 'id' | 'status'>) {
    const signals = this.readAll();
    
    // Prevent duplicate active signals for the same mint
    if (signals.some(s => s.tokenMint === signal.tokenMint && (s.status === 'pending' || s.status === 'processing'))) {
      return; 
    }

    signals.push({
      ...signal,
      id: `${signal.tokenMint}-${Date.now()}`,
      status: 'pending'
    });

    this.writeAtomic({ signals });
  }

  public getPendingSignals(): TokenSignal[] {
    const signals = this.readAll();
    const now = Date.now();
    let hasChanges = false;

    // Filter pending and prune expired
    const valid: TokenSignal[] = [];
    
    for (const sig of signals) {
      if (sig.status === 'pending') {
        const age = now - new Date(sig.discoveredAt).getTime();
        if (age > this.expiryMs) {
          sig.status = 'expired';
          hasChanges = true;
        } else {
          valid.push(sig);
        }
      }
    }

    if (hasChanges) {
      this.writeAtomic({ signals });
    }

    return valid; // Oldest first implicitly if pushed in order
  }

  public updateSignalStatus(id: string, status: SignalStatus) {
    const signals = this.readAll();
    const target = signals.find(s => s.id === id);
    if (target) {
      target.status = status;
      this.writeAtomic({ signals });
    }
  }
}

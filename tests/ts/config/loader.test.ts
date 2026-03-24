import { afterEach, describe, expect, it } from 'vitest';

import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { clearStrategyConfigCache, loadStrategyConfig } from '../../../src/config/loader';

const TEST_CONFIG_DIR = join('tmp', 'tests', 'config-loader');

async function cloneStrategyConfig(fileName: string) {
  await mkdir(TEST_CONFIG_DIR, { recursive: true });
  const sourcePath = join('src', 'config', 'strategies', fileName);
  const testPath = join(TEST_CONFIG_DIR, fileName);
  await copyFile(sourcePath, testPath);

  return testPath;
}

describe('loadStrategyConfig', () => {
  afterEach(async () => {
    clearStrategyConfigCache();
    await rm(TEST_CONFIG_DIR, { recursive: true, force: true });
  });

  it('loads the new-token strategy config from YAML', async () => {
    const path = await cloneStrategyConfig('new-token-v1.yaml');
    const config = await loadStrategyConfig(path);

    expect(config.strategyId).toBe('new-token-v1');
    expect(config.poolClass).toBe('new-token');
    expect(config.live.enabled).toBe(true);
  });

  it('loads the large-pool strategy config from YAML', async () => {
    const path = await cloneStrategyConfig('large-pool-v1.yaml');
    const config = await loadStrategyConfig(path);

    expect(config.strategyId).toBe('large-pool-v1');
    expect(config.poolClass).toBe('large-pool');
    expect(config.live.enabled).toBe(false);
  });

  it('reuses the cached config result until the cache is cleared', async () => {
    const path = await cloneStrategyConfig('new-token-v1.yaml');
    const first = await loadStrategyConfig(path);

    await writeFile(
      path,
      first.strategyId === 'new-token-v1'
        ? 'strategyId: broken\n'
        : '',
      'utf8'
    );

    const second = await loadStrategyConfig(path);

    expect(second.strategyId).toBe('new-token-v1');
  });
});

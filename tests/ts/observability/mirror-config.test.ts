import { describe, expect, it } from 'vitest';

import { loadMirrorConfig } from '../../../src/observability/mirror-config';

describe('loadMirrorConfig', () => {
  it('loads an enabled sqlite mirror config', () => {
    expect(loadMirrorConfig({
      LIVE_DB_MIRROR_ENABLED: 'true',
      LIVE_DB_MIRROR_PATH: '/tmp/lightld.sqlite'
    })).toMatchObject({
      enabled: true,
      path: '/tmp/lightld.sqlite'
    });
  });

  it('returns a disabled config when the mirror is not enabled', () => {
    expect(loadMirrorConfig({ LIVE_DB_MIRROR_ENABLED: 'false' })).toMatchObject({
      enabled: false
    });
  });
});

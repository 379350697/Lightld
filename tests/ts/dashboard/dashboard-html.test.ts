import { describe, expect, it } from 'vitest';

import { buildDashboardHtml } from '../../../src/dashboard/dashboard-html';

describe('buildDashboardHtml', () => {
  it('includes a dedicated evolution summary panel placeholders', () => {
    const html = buildDashboardHtml();

    expect(html).toContain('id="research-brief"');
    expect(html).toContain('id="research-window"');
    expect(html).toContain('id="research-scores"');
    expect(html).toContain('id="research-latest-proposal"');
    expect(html).toContain('id="research-latest-review"');
  });
});

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

  it('renders a real historical positions table shell instead of a hard-coded empty placeholder', () => {
    const html = buildDashboardHtml();

    expect(html).toContain('id="history-tbody"');
    expect(html).toContain('id="history-empty"');
    expect(html).toContain('id="history-pagination"');
    expect(html).toContain('id="history-prev-page"');
    expect(html).toContain('id="history-next-page"');
    expect(html).not.toContain('暂未接入真实 historical 数据');
  });

  it('includes the historical trust badge copy for estimated and untrusted rows', () => {
    const html = buildDashboardHtml();

    expect(html).toContain('收益估算');
    expect(html).toContain('收益不可信');
    expect(html).toContain('history-trust-badge');
  });
});

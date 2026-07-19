import { describe, expect, it } from 'vitest';

import { buildDashboardHtml } from '../../../src/dashboard/dashboard-html';

describe('buildDashboardHtml', () => {
  it('includes the lightweight strategy research summary placeholders', () => {
    const html = buildDashboardHtml();

    expect(html).toContain('id="research-brief"');
    expect(html).toContain('id="research-window"');
    expect(html).toContain('id="research-scores"');
    expect(html).toContain('id="research-marks"');
    expect(html).toContain('id="research-worker"');
    expect(html).toContain('Active Experiment');
    expect(html).toContain('Mark Coverage');
    expect(html).not.toContain('evolution proposal');
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

  it('does not coerce missing open position valuations into zero PnL', () => {
    const html = buildDashboardHtml();

    expect(html).toContain('function finiteNumberOrNull');
    expect(html).toContain('function lpTotalValueOrNull');
    expect(html).toContain('var currentValue = lpTotalValueOrNull(p);');
    expect(html).not.toContain('var currentValue = Number(p.currentValueSol);');
    expect(html).not.toContain('Number(p.currentValueSol) || 0');
    expect(html).not.toContain('currentValue + unclaimedFee - entrySol');
    expect(html).not.toContain('walletSol + openValue + openFees');
  });

  it('includes the historical trust badge copy for estimated, modeled, and untrusted rows', () => {
    const html = buildDashboardHtml();

    expect(html).toContain('收益估算');
    expect(html).toContain('纸面模型');
    expect(html).toContain('收益不可信');
    expect(html).toContain('history-trust-badge');
  });

  it('includes a close-reason column alongside each historical PnL row', () => {
    const html = buildDashboardHtml();

    expect(html).toContain('Close Reason');
    expect(html).toContain('function historyCloseReasonLabel');
    expect(html).toContain('达到最长持仓时间');
    expect(html).toContain('超出 LP 区间（上方）');
  });
});

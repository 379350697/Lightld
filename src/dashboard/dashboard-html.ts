export function buildDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lightld Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg-primary: #0a0e1a;
      --bg-secondary: #111827;
      --bg-card: rgba(17, 24, 39, 0.7);
      --bg-card-hover: rgba(17, 24, 39, 0.9);
      --border: rgba(99, 102, 241, 0.15);
      --border-active: rgba(99, 102, 241, 0.4);
      --text-primary: #f1f5f9;
      --text-secondary: #94a3b8;
      --text-muted: #64748b;
      --accent: #818cf8;
      --accent-glow: rgba(129, 140, 248, 0.25);
      --green: #34d399;
      --green-dim: rgba(52, 211, 153, 0.15);
      --red: #f87171;
      --red-dim: rgba(248, 113, 113, 0.15);
      --yellow: #fbbf24;
      --yellow-dim: rgba(251, 191, 36, 0.15);
      --blue: #60a5fa;
      --radius: 12px;
      --radius-sm: 8px;
    }

    body {
      font-family: 'Inter', -apple-system, sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      min-height: 100vh;
      overflow-x: hidden;
    }

    body::before {
      content: '';
      position: fixed;
      top: -50%;
      left: -50%;
      width: 200%;
      height: 200%;
      background: radial-gradient(ellipse at 30% 20%, rgba(99, 102, 241, 0.06) 0%, transparent 50%),
                  radial-gradient(ellipse at 70% 80%, rgba(52, 211, 153, 0.04) 0%, transparent 50%);
      pointer-events: none;
      z-index: 0;
    }

    .app { position: relative; z-index: 1; max-width: 1400px; margin: 0 auto; padding: 20px 24px; }

    /* Header */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 0;
      margin-bottom: 24px;
      border-bottom: 1px solid var(--border);
    }

    .header-left { display: flex; align-items: center; gap: 14px; }

    .logo {
      width: 36px;
      height: 36px;
      background: linear-gradient(135deg, var(--accent), #6366f1);
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 16px;
      box-shadow: 0 0 20px var(--accent-glow);
    }

    .header h1 { font-size: 20px; font-weight: 700; letter-spacing: -0.5px; }
    .header h1 span { color: var(--accent); }

    .header-right { display: flex; align-items: center; gap: 16px; }

    .refresh-indicator {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--text-muted);
      font-family: 'JetBrains Mono', monospace;
    }

    .pulse {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--green);
      animation: pulse-anim 2s ease-in-out infinite;
    }

    @keyframes pulse-anim {
      0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(52, 211, 153, 0.4); }
      50% { opacity: 0.6; box-shadow: 0 0 0 6px rgba(52, 211, 153, 0); }
    }

    /* Cards */
    .card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 20px;
      backdrop-filter: blur(12px);
      transition: border-color 0.3s, box-shadow 0.3s;
    }

    .card:hover {
      border-color: var(--border-active);
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.2);
    }

    .card-title {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--text-muted);
      margin-bottom: 12px;
    }

    /* Status grid */
    .status-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }

    .status-value {
      font-size: 28px;
      font-weight: 700;
      font-family: 'JetBrains Mono', monospace;
      line-height: 1.2;
    }

    .status-label {
      font-size: 13px;
      color: var(--text-secondary);
      margin-top: 4px;
    }

    .mode-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .mode-healthy { background: var(--green-dim); color: var(--green); }
    .mode-degraded { background: var(--yellow-dim); color: var(--yellow); }
    .mode-circuit_open, .mode-paused, .mode-flatten_only { background: var(--red-dim); color: var(--red); }
    .mode-recovering { background: var(--yellow-dim); color: var(--yellow); }

    /* Position card */
    .position-section { margin-bottom: 24px; }

    .position-summary {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 16px;
      margin-bottom: 16px;
    }

    .position-card {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 16px;
    }

    .position-card .card { display: flex; flex-direction: column; }

    .pos-mint {
      font-family: 'JetBrains Mono', monospace;
      font-size: 13px;
      color: var(--accent);
      word-break: break-all;
    }

    .position-meta {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-top: 14px;
    }

    .position-meta-item {
      padding: 10px;
      background: rgba(99, 102, 241, 0.06);
      border: 1px solid rgba(99, 102, 241, 0.08);
      border-radius: 8px;
    }

    .position-meta-label {
      font-size: 10px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 6px;
    }

    .position-meta-value {
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      color: var(--text-secondary);
      word-break: break-word;
    }

    .lifecycle-badge {
      display: inline-flex;
      padding: 3px 10px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      margin-top: 6px;
    }

    .lc-open { background: var(--green-dim); color: var(--green); }
    .lc-open_pending { background: var(--yellow-dim); color: var(--yellow); }
    .lc-closed { background: rgba(100, 116, 139, 0.2); color: var(--text-muted); }
    .lc-lp_exit_pending, .lc-inventory_exit_pending, .lc-inventory_exit_ready {
      background: var(--red-dim); color: var(--red);
    }

    /* PnL */
    .pnl-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 16px;
      margin-bottom: 24px;
    }

    .pnl-value {
      font-size: 32px;
      font-weight: 700;
      font-family: 'JetBrains Mono', monospace;
      transition: color 0.3s;
    }

    .pnl-positive { color: var(--green); }
    .pnl-negative { color: var(--red); }
    .pnl-zero { color: var(--text-muted); }

    .pnl-unit {
      font-size: 14px;
      color: var(--text-secondary);
      margin-left: 4px;
      font-weight: 500;
    }

    /* Chart */
    .chart-section { margin-bottom: 24px; }

    .chart-container {
      height: 200px;
      display: flex;
      align-items: flex-end;
      gap: 3px;
      padding: 16px 0 0;
      position: relative;
    }

    .chart-zero-line {
      position: absolute;
      left: 0;
      right: 0;
      border-top: 1px dashed var(--text-muted);
      opacity: 0.3;
    }

    .chart-bar-wrapper {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      height: 100%;
      position: relative;
    }

    .chart-bar {
      width: 100%;
      max-width: 24px;
      border-radius: 3px 3px 0 0;
      position: absolute;
      transition: height 0.5s ease;
      cursor: pointer;
      min-height: 2px;
    }

    .chart-bar.positive {
      background: linear-gradient(180deg, var(--green), rgba(52, 211, 153, 0.4));
      bottom: 50%;
    }

    .chart-bar.negative {
      background: linear-gradient(0deg, var(--red), rgba(248, 113, 113, 0.4));
      top: 50%;
      border-radius: 0 0 3px 3px;
    }

    .chart-bar:hover { filter: brightness(1.3); }

    .chart-date {
      position: absolute;
      bottom: -20px;
      font-size: 9px;
      color: var(--text-muted);
      font-family: 'JetBrains Mono', monospace;
      white-space: nowrap;
    }

    .chart-tooltip {
      display: none;
      position: absolute;
      bottom: calc(100% + 8px);
      left: 50%;
      transform: translateX(-50%);
      background: var(--bg-secondary);
      border: 1px solid var(--border-active);
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 11px;
      font-family: 'JetBrains Mono', monospace;
      white-space: nowrap;
      z-index: 10;
      pointer-events: none;
    }

    .chart-bar-wrapper:hover .chart-tooltip { display: block; }

    /* Tabs */
    .tabs-section { margin-bottom: 24px; }

    .tab-header {
      display: flex;
      gap: 2px;
      margin-bottom: 16px;
      background: rgba(17, 24, 39, 0.5);
      border-radius: var(--radius-sm);
      padding: 3px;
    }

    .tab-btn {
      flex: 1;
      padding: 10px 16px;
      background: transparent;
      border: none;
      color: var(--text-muted);
      font-size: 13px;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      border-radius: 6px;
      transition: all 0.2s;
    }

    .tab-btn.active {
      background: var(--bg-card);
      color: var(--text-primary);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
    }

    .tab-btn:hover:not(.active) { color: var(--text-secondary); }

    .tab-panel { display: none; }
    .tab-panel.active { display: block; }

    /* Tables */
    .data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }

    .data-table th {
      text-align: left;
      padding: 10px 12px;
      color: var(--text-muted);
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      border-bottom: 1px solid var(--border);
    }

    .data-table td {
      padding: 10px 12px;
      border-bottom: 1px solid rgba(99, 102, 241, 0.06);
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      color: var(--text-secondary);
    }

    .data-table tr:hover td { background: rgba(99, 102, 241, 0.04); }

    .side-buy, .side-add-lp { color: var(--green); }
    .side-sell, .side-withdraw-lp, .side-claim-fee { color: var(--red); }

    /* Log viewer */
    .log-viewer {
      max-height: 500px;
      overflow-y: auto;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      line-height: 1.8;
      padding: 12px;
      background: rgba(0, 0, 0, 0.3);
      border-radius: var(--radius-sm);
    }

    .log-viewer::-webkit-scrollbar { width: 6px; }
    .log-viewer::-webkit-scrollbar-track { background: transparent; }
    .log-viewer::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

    .log-entry {
      padding: 4px 8px;
      border-radius: 4px;
      margin-bottom: 2px;
      display: flex;
      gap: 10px;
      align-items: flex-start;
    }

    .log-entry:hover { background: rgba(99, 102, 241, 0.06); }

    .log-time { color: var(--text-muted); flex-shrink: 0; }
    .log-action { color: var(--accent); flex-shrink: 0; min-width: 100px; }
    .log-reason { color: var(--text-secondary); word-break: break-all; }

    .log-severity-warning .log-action { color: var(--yellow); }
    .log-severity-error .log-action { color: var(--red); }

    /* Empty state */
    .empty-state {
      text-align: center;
      padding: 48px 16px;
      color: var(--text-muted);
      font-size: 14px;
    }

    .empty-state-icon {
      font-size: 32px;
      margin-bottom: 12px;
      opacity: 0.5;
    }

    /* Responsive */
    @media (max-width: 768px) {
      .status-grid { grid-template-columns: repeat(2, 1fr); }
      .pnl-grid { grid-template-columns: 1fr; }
      .position-summary { grid-template-columns: 1fr; }
      .position-card { grid-template-columns: 1fr; }
      .pnl-value { font-size: 24px; }
    }

    /* Animations */
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .card { animation: fadeIn 0.4s ease; }

    /* Section titles */
    .section-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-secondary);
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .section-title::before {
      content: '';
      width: 3px;
      height: 14px;
      background: var(--accent);
      border-radius: 2px;
    }
  </style>
</head>
<body>
  <div class="app">
    <!-- Header -->
    <header class="header">
      <div class="header-left">
        <div class="logo">L</div>
        <h1>Light<span>ld</span> Dashboard</h1>
      </div>
      <div class="header-right">
        <div class="refresh-indicator">
          <div class="pulse" id="pulse-dot"></div>
          <span id="last-update">--</span>
        </div>
      </div>
    </header>

    <!-- Status Grid -->
    <div class="status-grid" id="status-grid">
      <div class="card">
        <div class="card-title">运行模式</div>
        <div id="rt-mode"><span class="mode-badge mode-healthy">● healthy</span></div>
        <div class="status-label" id="rt-circuit-reason"></div>
      </div>
      <div class="card">
        <div class="card-title">生命周期</div>
        <div id="rt-lifecycle"><span class="lifecycle-badge lc-closed">closed</span></div>
        <div class="status-label" id="rt-last-action">--</div>
      </div>
      <div class="card">
        <div class="card-title">钱包余额</div>
        <div class="status-value" id="rt-wallet-sol">--</div>
        <div class="status-label">SOL</div>
      </div>
      <div class="card">
        <div class="card-title">最后 Tick</div>
        <div class="status-value" style="font-size:16px;" id="rt-last-tick">--</div>
        <div class="status-label" id="rt-updated-at"></div>
      </div>
    </div>

    <!-- Current Positions -->
    <div class="position-section">
      <div class="section-title">当前持仓</div>
      <div class="position-summary">
        <div class="card">
          <div class="card-title">持仓数量</div>
          <div class="status-value" id="pos-count">0</div>
          <div class="status-label">active LP positions</div>
        </div>
        <div class="card">
          <div class="card-title">当前总价值</div>
          <div class="status-value" id="pos-total-value">0.0000</div>
          <div class="status-label">SOL</div>
        </div>
        <div class="card">
          <div class="card-title">未领取费用</div>
          <div class="status-value" id="pos-total-fees">0.0000</div>
          <div class="status-label">SOL</div>
        </div>
      </div>
      <div class="empty-state" id="positions-empty"><div class="empty-state-icon">🧺</div>暂无活跃持仓</div>
      <div class="position-card" id="positions-list" style="display:none;"></div>
    </div>

    <!-- PnL Overview -->
    <div class="section-title">收益概览</div>
    <div class="pnl-grid">
      <div class="card">
        <div class="card-title">总收益</div>
        <div class="pnl-value pnl-zero" id="pnl-total">0.0000<span class="pnl-unit">SOL</span></div>
      </div>
      <div class="card">
        <div class="card-title">今日收益</div>
        <div class="pnl-value pnl-zero" id="pnl-today">0.0000<span class="pnl-unit">SOL</span></div>
      </div>
      <div class="card">
        <div class="card-title">本月收益</div>
        <div class="pnl-value pnl-zero" id="pnl-month">0.0000<span class="pnl-unit">SOL</span></div>
      </div>
    </div>

    <!-- Chart -->
    <div class="chart-section">
      <div class="card">
        <div class="card-title">最近 30 天日收益</div>
        <div class="chart-container" id="daily-chart">
          <div class="chart-zero-line" style="bottom:50%;"></div>
        </div>
      </div>
    </div>

    <!-- Tabs: Orders / Fills / Logs -->
    <div class="tabs-section">
      <div class="card" style="padding:0;">
        <div class="tab-header">
          <button class="tab-btn active" data-tab="orders">订单</button>
          <button class="tab-btn" data-tab="fills">成交</button>
          <button class="tab-btn" data-tab="incidents">事件</button>
          <button class="tab-btn" data-tab="logs">决策日志</button>
        </div>
        <div id="tab-orders" class="tab-panel active" style="padding:0 4px 4px;">
          <div class="empty-state" id="orders-empty"><div class="empty-state-icon">📋</div>暂无订单数据</div>
          <table class="data-table" id="orders-table" style="display:none;">
            <thead><tr>
              <th>时间</th><th>Token</th><th>操作</th><th>金额 (SOL)</th><th>状态</th>
            </tr></thead>
            <tbody id="orders-tbody"></tbody>
          </table>
        </div>
        <div id="tab-fills" class="tab-panel" style="padding:0 4px 4px;">
          <div class="empty-state" id="fills-empty"><div class="empty-state-icon">💰</div>暂无成交数据</div>
          <table class="data-table" id="fills-table" style="display:none;">
            <thead><tr>
              <th>时间</th><th>Token</th><th>方向</th><th>数量</th><th>SOL</th>
            </tr></thead>
            <tbody id="fills-tbody"></tbody>
          </table>
        </div>
        <div id="tab-incidents" class="tab-panel" style="padding:0 4px 4px;">
          <div class="empty-state" id="incidents-empty"><div class="empty-state-icon">⚠️</div>暂无事件</div>
          <div class="log-viewer" id="incidents-viewer" style="display:none;"></div>
        </div>
        <div id="tab-logs" class="tab-panel" style="padding:0 4px 4px;">
          <div class="empty-state" id="logs-empty"><div class="empty-state-icon">📝</div>暂无日志</div>
          <div class="log-viewer" id="logs-viewer" style="display:none;"></div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    // Tabs
    $$('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('.tab-btn').forEach(b => b.classList.remove('active'));
        $$('.tab-panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        $('#tab-' + btn.dataset.tab).classList.add('active');
      });
    });

    function formatTime(iso) {
      if (!iso) return '--';
      const d = new Date(iso);
      return d.toLocaleTimeString('zh-CN', { hour12: false }) + ' ' + d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
    }

    function formatShortTime(iso) {
      if (!iso) return '--';
      return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });
    }

    function formatDuration(ms) {
      if (!ms || ms <= 0) return '--';
      const sec = Math.floor(ms / 1000);
      if (sec < 60) return sec + 's';
      const min = Math.floor(sec / 60);
      if (min < 60) return min + 'm ' + (sec % 60) + 's';
      const hr = Math.floor(min / 60);
      return hr + 'h ' + (min % 60) + 'm';
    }

    function formatSol(val) {
      if (typeof val !== 'number') return '0.0000';
      return val.toFixed(4);
    }

    function pnlClass(val) {
      if (typeof val !== 'number' || val === 0) return 'pnl-zero';
      return val > 0 ? 'pnl-positive' : 'pnl-negative';
    }

    function truncMint(mint) {
      if (!mint || mint.length < 12) return mint || '--';
      return mint.slice(0, 6) + '...' + mint.slice(-4);
    }

    function sideClass(side) {
      if (!side) return '';
      return 'side-' + side.replace(/_/g, '-');
    }

    function renderPositions(positions) {
      const list = $('#positions-list');
      const empty = $('#positions-empty');
      const safePositions = Array.isArray(positions) ? positions : [];

      const totalValue = safePositions.reduce((sum, p) => sum + (typeof p.currentValueSol === 'number' ? p.currentValueSol : 0), 0);
      const totalFees = safePositions.reduce((sum, p) => sum + (typeof p.unclaimedFeeSol === 'number' ? p.unclaimedFeeSol : 0), 0);

      $('#pos-count').textContent = String(safePositions.length);
      $('#pos-total-value').textContent = formatSol(totalValue);
      $('#pos-total-fees').textContent = formatSol(totalFees);

      if (!safePositions.length) {
        empty.style.display = '';
        list.style.display = 'none';
        list.innerHTML = '';
        return;
      }

      empty.style.display = 'none';
      list.style.display = 'grid';
      list.innerHTML = safePositions.map(p => {
        const coverage = (typeof p.fundedBinCount === 'number' && typeof p.binCount === 'number')
          ? (p.fundedBinCount + '/' + p.binCount)
          : '--';
        const range = (typeof p.lowerBinId === 'number' && typeof p.upperBinId === 'number')
          ? (p.lowerBinId + ' → ' + p.upperBinId)
          : '--';
        const activeBin = typeof p.activeBinId === 'number' ? String(p.activeBinId) : '--';
        const depleted = typeof p.solDepletedBins === 'number' ? String(p.solDepletedBins) : '--';

        return '<div class="card">' +
          '<div class="card-title">LP 仓位</div>' +
          '<div class="pos-mint">' + truncMint(p.mint) + '</div>' +
          '<div class="status-label" style="margin-top:8px;">Pool: ' + truncMint(p.poolAddress) + '</div>' +
          '<div class="position-meta">' +
            '<div class="position-meta-item"><div class="position-meta-label">当前价值</div><div class="position-meta-value">' + formatSol(p.currentValueSol) + ' SOL</div></div>' +
            '<div class="position-meta-item"><div class="position-meta-label">未领费用</div><div class="position-meta-value">' + formatSol(p.unclaimedFeeSol) + ' SOL</div></div>' +
            '<div class="position-meta-item"><div class="position-meta-label">Bin 覆盖</div><div class="position-meta-value">' + coverage + '</div></div>' +
            '<div class="position-meta-item"><div class="position-meta-label">Active Bin</div><div class="position-meta-value">' + activeBin + '</div></div>' +
            '<div class="position-meta-item"><div class="position-meta-label">Bin Range</div><div class="position-meta-value">' + range + '</div></div>' +
            '<div class="position-meta-item"><div class="position-meta-label">SOL 耗尽 Bin</div><div class="position-meta-value">' + depleted + '</div></div>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    // Render status
    function renderStatus(data) {
      if (!data) return;

      // Mode
      const mode = data.mode || 'healthy';
      $('#rt-mode').innerHTML = '<span class="mode-badge mode-' + mode + '">● ' + mode + '</span>';
      $('#rt-circuit-reason').textContent = data.circuitReason || '';

      // Lifecycle
      const lc = data.lifecycleState || 'closed';
      $('#rt-lifecycle').innerHTML = '<span class="lifecycle-badge lc-' + lc + '">' + lc.replace(/_/g, ' ') + '</span>';
      $('#rt-last-action').textContent = data.lastAction ? '操作: ' + data.lastAction : '--';

      // Wallet
      $('#rt-wallet-sol').textContent = typeof data.walletSol === 'number' ? formatSol(data.walletSol) : '--';

      // Last tick
      $('#rt-last-tick').textContent = data.lastSuccessfulTickAt ? formatTime(data.lastSuccessfulTickAt) : '--';
      $('#rt-updated-at').textContent = data.updatedAt ? '更新: ' + formatTime(data.updatedAt) : '';

    }

    // Render PnL
    function renderPnl(data) {
      if (!data) return;

      const total = data.totalPnl || 0;
      const today = data.todayPnl || 0;
      const month = data.monthPnl || 0;

      $('#pnl-total').className = 'pnl-value ' + pnlClass(total);
      $('#pnl-total').innerHTML = formatSol(total) + '<span class="pnl-unit">SOL</span>';

      $('#pnl-today').className = 'pnl-value ' + pnlClass(today);
      $('#pnl-today').innerHTML = formatSol(today) + '<span class="pnl-unit">SOL</span>';

      $('#pnl-month').className = 'pnl-value ' + pnlClass(month);
      $('#pnl-month').innerHTML = formatSol(month) + '<span class="pnl-unit">SOL</span>';

      // Chart
      renderChart(data.dailyPnl || []);
    }

    function renderChart(dailyPnl) {
      const container = $('#daily-chart');
      container.innerHTML = '<div class="chart-zero-line" style="top:50%;"></div>';

      if (!dailyPnl.length) return;

      const maxAbs = Math.max(...dailyPnl.map(d => Math.abs(d.pnl)), 0.0001);

      dailyPnl.forEach((d, i) => {
        const pct = (Math.abs(d.pnl) / maxAbs) * 45;
        const isPos = d.pnl >= 0;
        const wrapper = document.createElement('div');
        wrapper.className = 'chart-bar-wrapper';

        const bar = document.createElement('div');
        bar.className = 'chart-bar ' + (isPos ? 'positive' : 'negative');
        bar.style.height = Math.max(pct, 1) + '%';

        const tooltip = document.createElement('div');
        tooltip.className = 'chart-tooltip';
        tooltip.textContent = d.date + ': ' + (d.pnl >= 0 ? '+' : '') + formatSol(d.pnl) + ' SOL';

        wrapper.appendChild(bar);
        wrapper.appendChild(tooltip);

        if (i % 5 === 0 || i === dailyPnl.length - 1) {
          const label = document.createElement('div');
          label.className = 'chart-date';
          label.textContent = d.date.slice(5);
          wrapper.appendChild(label);
        }

        container.appendChild(wrapper);
      });
    }

    // Render orders
    function renderOrders(orders) {
      if (!orders || !orders.length) {
        $('#orders-empty').style.display = '';
        $('#orders-table').style.display = 'none';
        return;
      }
      $('#orders-empty').style.display = 'none';
      $('#orders-table').style.display = '';

      const tbody = $('#orders-tbody');
      tbody.innerHTML = orders.map(o => '<tr>' +
        '<td>' + formatTime(o.updatedAt || o.createdAt) + '</td>' +
        '<td>' + (o.tokenSymbol || truncMint(o.tokenMint)) + '</td>' +
        '<td class="' + sideClass(o.action) + '">' + (o.action || '--') + '</td>' +
        '<td>' + formatSol(o.requestedPositionSol) + '</td>' +
        '<td>' + (o.confirmationStatus || '--') + '</td>' +
        '</tr>').join('');
    }

    // Render fills
    function renderFills(fills) {
      if (!fills || !fills.length) {
        $('#fills-empty').style.display = '';
        $('#fills-table').style.display = 'none';
        return;
      }
      $('#fills-empty').style.display = 'none';
      $('#fills-table').style.display = '';

      const tbody = $('#fills-tbody');
      tbody.innerHTML = fills.map(f => '<tr>' +
        '<td>' + formatTime(f.recordedAt) + '</td>' +
        '<td>' + (f.tokenSymbol || truncMint(f.tokenMint)) + '</td>' +
        '<td class="' + sideClass(f.side) + '">' + (f.side || '--') + '</td>' +
        '<td>' + (typeof f.amount === 'number' ? f.amount.toFixed(2) : '--') + '</td>' +
        '<td>' + formatSol(f.filledSol) + '</td>' +
        '</tr>').join('');
    }

    // Render incidents
    function renderIncidents(incidents) {
      const viewer = $('#incidents-viewer');
      const empty = $('#incidents-empty');
      if (!incidents || !incidents.length) {
        empty.style.display = '';
        viewer.style.display = 'none';
        return;
      }
      empty.style.display = 'none';
      viewer.style.display = '';

      viewer.innerHTML = incidents.map(inc =>
        '<div class="log-entry log-severity-' + (inc.severity || 'warning') + '">' +
        '<span class="log-time">' + formatShortTime(inc.recordedAt) + '</span>' +
        '<span class="log-action">[' + (inc.stage || '--') + ']</span>' +
        '<span class="log-reason">' + escapeHtml(inc.reason || '') + '</span>' +
        '</div>'
      ).join('');
    }

    // Render logs
    function renderLogs(logs) {
      const viewer = $('#logs-viewer');
      const empty = $('#logs-empty');
      if (!logs || !logs.length) {
        empty.style.display = '';
        viewer.style.display = 'none';
        return;
      }
      empty.style.display = 'none';
      viewer.style.display = '';

      viewer.innerHTML = logs.map(l =>
        '<div class="log-entry">' +
        '<span class="log-time">' + formatShortTime(l.recordedAt) + '</span>' +
        '<span class="log-action">' + (l.action || l.stage || '--') + '</span>' +
        '<span class="log-reason">' + escapeHtml(l.reason || '') +
        (l.tokenSymbol ? ' [' + l.tokenSymbol + ']' : '') +
        '</span>' +
        '</div>'
      ).join('');
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    // Fetch data
    async function fetchJson(url) {
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        return await res.json();
      } catch { return null; }
    }

    async function refreshAll() {
      const [status, positions, pnl, orders, fills, incidents, logs] = await Promise.all([
        fetchJson('/api/status'),
        fetchJson('/api/positions'),
        fetchJson('/api/pnl'),
        fetchJson('/api/orders'),
        fetchJson('/api/fills'),
        fetchJson('/api/incidents'),
        fetchJson('/api/logs'),
      ]);

      renderStatus(status);
      renderPositions(positions);
      renderPnl(pnl);
      renderOrders(orders);
      renderFills(fills);
      renderIncidents(incidents);
      renderLogs(logs);

      $('#last-update').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    }

    // Initial load + polling
    refreshAll();
    setInterval(refreshAll, 5000);
  </script>
</body>
</html>`;
}

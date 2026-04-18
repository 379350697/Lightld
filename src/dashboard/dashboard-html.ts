export function buildDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lightld Dashboard</title>
  <meta name="description" content="Lightld Trading Engine dashboard">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg-page: #0b0b0b;
      --bg-surface: #141414;
      --bg-card: #1a1a1a;
      --bg-card-hover: #1f1f1f;
      --bg-header: #141414;
      --border: #2a2a2a;
      --border-subtle: #222222;
      --text-primary: #ffffff;
      --text-secondary: #a0a0a0;
      --text-muted: #666666;
      --text-dim: #444444;
      --green: #22c55e;
      --green-bg: rgba(34, 197, 94, 0.12);
      --red: #ef4444;
      --red-bg: rgba(239, 68, 68, 0.12);
      --yellow: #eab308;
      --yellow-bg: rgba(234, 179, 8, 0.12);
      --blue: #3b82f6;
      --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      --font-mono: 'JetBrains Mono', 'Fira Code', monospace;
    }
    html { scroll-behavior: smooth; }
    body {
      font-family: var(--font-sans);
      background: var(--bg-page);
      color: var(--text-primary);
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
      line-height: 1.5;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 24px;
      height: 56px;
      background: var(--bg-header);
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .header-left { display: flex; align-items: center; gap: 24px; }
    .logo-group { display: flex; align-items: center; gap: 10px; }
    .logo-icon {
      width: 32px; height: 32px; background: linear-gradient(135deg, #22c55e, #16a34a);
      border-radius: 50%; display: flex; align-items: center; justify-content: center; position: relative;
    }
    .logo-icon::after {
      content: ''; width: 14px; height: 14px; border: 2px solid rgba(255,255,255,0.9);
      border-radius: 3px; transform: rotate(45deg);
    }
    .logo-text { font-size: 17px; font-weight: 700; color: var(--text-primary); letter-spacing: -0.3px; }
    .nav-tabs { display: flex; align-items: center; gap: 4px; }
    .nav-tab {
      padding: 6px 16px; border-radius: 8px; font-size: 14px; font-weight: 500;
      color: var(--text-secondary); cursor: pointer; transition: all 0.2s; text-decoration: none; user-select: none;
    }
    .nav-tab:hover, .nav-tab.active { color: var(--text-primary); background: rgba(255,255,255,0.08); }
    .header-right { display: flex; align-items: center; gap: 16px; }
    .live-indicator {
      display: flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 6px;
      background: var(--green-bg); font-size: 12px; font-weight: 600; color: var(--green);
    }
    .live-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: pulse 2s ease-in-out infinite; }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
    .header-wallet {
      display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 8px;
      background: var(--bg-card); border: 1px solid var(--border); font-size: 13px;
      font-family: var(--font-mono); color: var(--text-secondary);
    }
    .header-wallet .sol-icon { width: 18px; height: 18px; background: linear-gradient(135deg, #9945FF, #14F195); border-radius: 50%; }
    .main { max-width: 1400px; margin: 0 auto; padding: 24px; }
    .wallet-bar { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
    .wallet-address { font-family: var(--font-mono); font-size: 14px; color: var(--text-primary); }
    .copy-btn {
      display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; border-radius: 4px;
      background: transparent; border: 1px solid var(--border); color: var(--text-muted); font-size: 11px; cursor: pointer;
    }
    .update-info { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-muted); margin-bottom: 16px; }
    .portfolio-section {
      display: grid; grid-template-columns: 340px 1fr; background: var(--bg-card); border: 1px solid var(--border);
      border-radius: 12px; overflow: hidden; margin-bottom: 32px;
    }
    .portfolio-stats { padding: 28px; border-right: 1px solid var(--border); }
    .net-worth-label { font-size: 12px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
    .net-worth-value { font-size: 34px; font-weight: 800; color: var(--text-primary); letter-spacing: -1px; margin-bottom: 24px; }
    .net-worth-value .sol-unit { font-size: 20px; font-weight: 600; color: var(--text-secondary); margin-left: 6px; }
    .stats-grid { display: grid; grid-template-columns: 1fr 1fr; }
    .stat-item { padding: 12px 0; border-top: 1px solid var(--border-subtle); }
    .stat-item:nth-child(odd) { padding-right: 16px; }
    .stat-item:nth-child(even) { padding-left: 16px; border-left: 1px solid var(--border-subtle); }
    .stat-label { font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 4px; }
    .stat-value { font-size: 18px; font-weight: 700; color: var(--text-primary); }
    .stat-value.green { color: var(--green); }
    .stat-value.red { color: var(--red); }
    .portfolio-chart { padding: 28px; display: flex; flex-direction: column; }
    .chart-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; flex-wrap: wrap; gap: 12px; }
    .chart-title { font-size: 13px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 1px; }
    .chart-controls { display: flex; align-items: center; gap: 8px; }
    .chart-filter-group { display: flex; align-items: center; gap: 2px; background: var(--bg-surface); border-radius: 8px; padding: 2px; }
    .chart-filter-btn { padding: 5px 12px; border-radius: 6px; border: none; background: transparent; color: var(--text-muted); font-size: 12px; font-weight: 600; }
    .chart-filter-btn.active { background: var(--green); color: #000; }
    .chart-body { flex: 1; min-height: 200px; display: flex; align-items: flex-end; gap: 2px; position: relative; padding-left: 50px; padding-bottom: 28px; }
    .chart-watermark { position: absolute; top: 50%; left: 55%; transform: translate(-50%, -50%); display: flex; align-items: center; gap: 10px; opacity: 0.06; pointer-events: none; }
    .chart-watermark .wm-icon { width: 40px; height: 40px; background: var(--green); border-radius: 50%; }
    .chart-watermark .wm-text { font-size: 28px; font-weight: 800; color: var(--text-primary); }
    .chart-y-axis { position: absolute; left: 0; top: 0; bottom: 28px; width: 46px; display: flex; flex-direction: column; justify-content: space-between; align-items: flex-end; padding-right: 8px; }
    .chart-y-label { font-size: 10px; font-family: var(--font-mono); color: var(--text-dim); white-space: nowrap; }
    .chart-zero-line { position: absolute; left: 50px; right: 0; border-top: 1px solid var(--border-subtle); }
    .chart-bar-wrap { flex: 1; display: flex; flex-direction: column; align-items: center; height: 100%; position: relative; }
    .chart-bar { width: 80%; max-width: 16px; border-radius: 2px; position: absolute; min-height: 2px; }
    .chart-bar.pos { background: var(--green); bottom: 50%; }
    .chart-bar.neg { background: var(--red); top: 50%; }
    .chart-svg { position: absolute; left: 50px; right: 0; top: 0; bottom: 28px; width: calc(100% - 50px); height: calc(100% - 28px); overflow: visible; }
    .chart-grid-line { stroke: var(--border-subtle); stroke-width: 1; }
    .chart-area { fill: rgba(34, 197, 94, 0.12); }
    .chart-line { fill: none; stroke: var(--green); stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
    .chart-point { fill: var(--green); }
    .chart-x-label { position: absolute; bottom: -22px; font-size: 9px; font-family: var(--font-mono); color: var(--text-dim); white-space: nowrap; }
    .chart-tooltip { display: none; position: absolute; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%); background: #252525; border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 11px; font-family: var(--font-mono); color: var(--text-primary); white-space: nowrap; z-index: 10; }
    .chart-bar-wrap:hover .chart-tooltip { display: block; }
    .positions-section, .logs-section {
      background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; margin-bottom: 32px;
    }
    .research-brief {
      display: grid; grid-template-columns: 1.2fr 1fr 1fr; gap: 16px; margin-bottom: 32px;
    }
    .research-card {
      background: linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01));
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 18px 20px;
      min-height: 124px;
    }
    .research-label {
      font-size: 11px;
      font-weight: 700;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.9px;
      margin-bottom: 10px;
    }
    .research-main {
      font-size: 20px;
      font-weight: 700;
      color: var(--text-primary);
      margin-bottom: 8px;
    }
    .research-meta {
      font-size: 12px;
      color: var(--text-secondary);
      line-height: 1.6;
    }
    .research-mono { font-family: var(--font-mono); }
    .research-score-row {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
      margin-top: 12px;
    }
    .research-score-chip {
      border-radius: 8px;
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      padding: 10px 12px;
    }
    .research-score-chip b {
      display: block;
      font-size: 15px;
      color: var(--text-primary);
      margin-top: 4px;
      font-family: var(--font-mono);
    }
    .positions-header, .logs-header { padding: 20px 24px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .positions-title, .logs-title { font-size: 16px; font-weight: 700; color: var(--text-primary); }
    .positions-summary { display: flex; align-items: center; gap: 20px; font-size: 13px; color: var(--text-secondary); flex-wrap: wrap; }
    .positions-summary b { color: var(--text-primary); font-weight: 600; }
    .positions-summary .green { color: var(--green); }
    .positions-summary .red { color: var(--red); }
    .view-btn {
      padding: 5px 10px; border-radius: 6px; border: 1px solid var(--border); background: transparent;
      color: var(--text-muted); font-size: 12px; font-weight: 500;
    }
    .view-btn.active { background: rgba(255,255,255,0.08); color: var(--text-primary); }
    .pos-table { width: 100%; border-collapse: collapse; }
    .pos-table th {
      text-align: left; padding: 10px 16px; font-size: 12px; font-weight: 600; color: var(--text-muted);
      border-bottom: 1px solid var(--border); border-top: 1px solid var(--border); background: var(--bg-surface); white-space: nowrap;
    }
    .pos-table td { padding: 14px 16px; border-bottom: 1px solid var(--border-subtle); font-size: 13px; color: var(--text-secondary); vertical-align: middle; }
    .token-cell { display: flex; align-items: center; gap: 12px; }
    .token-avatar {
      width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
      font-size: 14px; font-weight: 700; color: #fff; flex-shrink: 0; background: linear-gradient(135deg, #6366f1, #8b5cf6);
    }
    .token-info { display: flex; flex-direction: column; gap: 2px; }
    .token-name { font-size: 14px; font-weight: 600; color: var(--text-primary); }
    .token-meta { display: flex; align-items: center; gap: 6px; }
    .dlmm-badge { display: inline-flex; align-items: center; padding: 1px 6px; border-radius: 4px; background: var(--green-bg); color: var(--green); font-size: 10px; font-weight: 700; letter-spacing: 0.5px; }
    .pool-addr, .cell-sub, .log-time, .log-token { font-size: 11px; font-family: var(--font-mono); color: var(--text-muted); }
    .cell-main { font-size: 14px; font-weight: 600; color: var(--text-primary); font-family: var(--font-mono); }
    .cell-green { color: var(--green); }
    .cell-red { color: var(--red); }
    .fee-unclaim { padding: 2px 8px; border-radius: 4px; background: var(--green-bg); color: var(--green); font-size: 12px; font-weight: 500; }
    .dpr-value { font-size: 14px; font-weight: 600; font-family: var(--font-mono); color: var(--green); }
    .range-bar { display: flex; height: 6px; background: var(--border); border-radius: 3px; overflow: hidden; margin: 4px 0; min-width: 120px; }
    .range-fill.blue { background: var(--blue); }
    .range-fill.yellow { background: var(--yellow); }
    .range-fill.red { background: var(--red); }
    .range-labels { display: flex; justify-content: space-between; font-size: 9px; font-family: var(--font-mono); color: var(--text-dim); }
    .action-btn { width: 28px; height: 28px; border-radius: 6px; border: 1px solid var(--border); background: transparent; color: var(--text-muted); }
    .logs-header { border-bottom: 1px solid var(--border); cursor: pointer; }
    .logs-count { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 10px; background: rgba(255,255,255,0.08); color: var(--text-secondary); font-family: var(--font-mono); }
    .logs-toggle { font-size: 12px; color: var(--text-muted); }
    .logs-body.collapsed { display: none; }
    .log-row { display: grid; grid-template-columns: 80px 100px 1fr auto; gap: 12px; padding: 8px 24px; font-size: 12px; font-family: var(--font-mono); border-bottom: 1px solid var(--border-subtle); align-items: center; }
    .log-action { color: var(--green); font-weight: 600; font-size: 11px; }
    .log-action.warn { color: var(--yellow); }
    .log-action.error { color: var(--red); }
    .log-reason { color: var(--text-secondary); font-size: 11px; word-break: break-all; }
    .empty-state { text-align: center; padding: 32px 16px; color: var(--text-muted); font-size: 14px; }
    .section-note { padding: 14px 24px; border-top: 1px solid var(--border); color: var(--text-muted); font-size: 12px; }
    @media (max-width: 900px) {
      .portfolio-section { grid-template-columns: 1fr; }
      .research-brief { grid-template-columns: 1fr; }
      .portfolio-stats { border-right: none; border-bottom: 1px solid var(--border); }
      .header { padding: 0 12px; }
      .main { padding: 16px; }
    }
  </style>
</head>
<body>
  <header class="header">
    <div class="header-left">
      <div class="logo-group"><div class="logo-icon"></div><span class="logo-text">Lightld</span></div>
      <nav class="nav-tabs">
        <a class="nav-tab active">Portfolio</a>
        <a class="nav-tab">Positions</a>
        <a class="nav-tab">Logs</a>
      </nav>
    </div>
    <div class="header-right">
      <div class="live-indicator" id="live-indicator"><div class="live-dot"></div><span id="live-text">LIVE</span></div>
      <div class="header-wallet"><div class="sol-icon"></div><span id="header-addr">--</span></div>
    </div>
  </header>

  <div class="main">
    <div class="wallet-bar">
      <span class="wallet-address" id="wallet-full-addr">--</span>
      <button class="copy-btn" id="copy-btn">📋 Copy</button>
    </div>
    <div class="update-info">Last updated: <span id="last-update">--</span></div>

    <div class="portfolio-section">
      <div class="portfolio-stats">
        <div class="net-worth-label">TOTAL NET WORTH</div>
        <div class="net-worth-value"><span id="net-worth-num">--</span><span class="sol-unit">SOL</span></div>
        <div class="stats-grid">
          <div class="stat-item"><div class="stat-label">MODE</div><div class="stat-value" id="stat-mode">--</div></div>
          <div class="stat-item"><div class="stat-label">LIFECYCLE</div><div class="stat-value" id="stat-lifecycle">--</div></div>
          <div class="stat-item"><div class="stat-label">OPEN POSITIONS</div><div class="stat-value" id="stat-open-count">0</div></div>
          <div class="stat-item"><div class="stat-label">UNCLAIMED FEES</div><div class="stat-value" id="stat-fee-earned">0.0000</div></div>
          <div class="stat-item"><div class="stat-label">TOTAL FLOW</div><div class="stat-value" id="stat-total-profit">0.0000</div></div>
          <div class="stat-item"><div class="stat-label">MONTH FLOW</div><div class="stat-value" id="stat-monthly-profit">0.0000</div></div>
          <div class="stat-item" style="grid-column: span 2;"><div class="stat-label">CIRCUIT REASON</div><div class="stat-value" id="stat-circuit" style="font-size:14px;">--</div></div>
          <div class="stat-item" style="grid-column: span 2;"><div class="stat-label">RESEARCH</div><div class="stat-value" id="stat-research" style="font-size:14px;">--</div></div>
        </div>
      </div>
      <div class="portfolio-chart">
        <div class="chart-header">
          <div class="chart-title">NET WORTH HISTORY</div>
          <div class="chart-controls">
            <div class="chart-filter-group"><button class="chart-filter-btn active">Equity</button></div>
          </div>
        </div>
        <div class="chart-body" id="pnl-chart">
          <div class="chart-watermark"><div class="wm-icon"></div><span class="wm-text">Lightld</span></div>
        </div>
      </div>
    </div>

    <div class="research-brief" id="research-brief">
      <div class="research-card">
        <div class="research-label">Research Window</div>
        <div class="research-main research-mono" id="research-window">--</div>
        <div class="research-meta" id="research-scores">coverage=-- readiness=-- regime=--</div>
      </div>
      <div class="research-card">
        <div class="research-label">Latest Proposal</div>
        <div class="research-main research-mono" id="research-latest-proposal">--</div>
        <div class="research-meta" id="research-latest-proposal-meta">No evolution proposal yet.</div>
      </div>
      <div class="research-card">
        <div class="research-label">Latest Review</div>
        <div class="research-main research-mono" id="research-latest-review">--</div>
        <div class="research-meta" id="research-latest-review-meta">No outcome review yet.</div>
      </div>
    </div>

    <div class="positions-section">
      <div class="positions-header">
        <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
          <div class="positions-title" id="open-title">Open positions (0)</div>
          <div class="positions-summary" id="open-summary"></div>
        </div>
        <button class="view-btn active">▨ Table</button>
      </div>
      <div style="overflow-x:auto;">
        <table class="pos-table">
          <thead>
            <tr>
              <th style="width:20px;"></th>
              <th>Position/Pool</th>
              <th>Value</th>
              <th>Unclaimed Fee</th>
              <th>Current Price</th>
              <th>Coverage</th>
              <th>Price Range</th>
              <th>SOL Side</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody id="open-tbody"></tbody>
        </table>
      </div>
      <div class="empty-state" id="open-empty" style="display:none;">暂无活跃持仓</div>
    </div>

    <div class="positions-section">
      <div class="positions-header">
        <div class="positions-title">Historical positions</div>
        <button class="view-btn active">▨ Table</button>
      </div>
      <div class="empty-state">暂未接入真实 historical 数据</div>
      <div class="section-note">避免误导，已移除 mock 历史仓位。</div>
    </div>

    <div class="logs-section">
      <div class="logs-header" id="logs-header-toggle">
        <div class="logs-title">Decision Logs <span class="logs-count" id="logs-count">0</span></div>
        <div class="logs-toggle" id="logs-chevron">▼</div>
      </div>
      <div class="logs-body" id="logs-body"></div>
      <div class="section-note">仅显示真实日志，不再展示 mock 示例数据。</div>
    </div>
  </div>

  <script>
    var $ = function(sel) { return document.querySelector(sel); };
    function escHtml(t) { var d = document.createElement('div'); d.textContent = t == null ? '' : String(t); return d.innerHTML; }
    function truncAddr(a) { if (!a || a.length < 12) return a || '--'; return a.slice(0, 6) + '...' + a.slice(-4); }
    function fmtSol(v) { return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(4) : '--'; }
    function fmtPrice(v) { return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(4) : '--'; }
    function fmtTime(iso) { if (!iso) return '--'; try { return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false }); } catch { return '--'; } }
    function timeAgo(iso) {
      if (!iso) return '--';
      var ms = Date.now() - new Date(iso).getTime();
      var min = Math.floor(ms / 60000);
      if (min < 1) return 'just now';
      if (min < 60) return min + ' min ago';
      var hr = Math.floor(min / 60);
      if (hr < 24) return hr + ' hours ago';
      return Math.floor(hr / 24) + ' days ago';
    }
    function fetchJson(url) { return fetch(url).then(function(res) { if (!res.ok) return null; return res.json(); }).catch(function() { return null; }); }
    function renderChart(dailyEquity) {
      var data = Array.isArray(dailyEquity) ? dailyEquity : [];
      var container = $('#pnl-chart');
      var watermark = container.querySelector('.chart-watermark');
      container.innerHTML = '';
      if (watermark) container.appendChild(watermark);
      if (!data.length) {
        var empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.style.position = 'absolute';
        empty.style.inset = '0';
        empty.style.display = 'flex';
        empty.style.alignItems = 'center';
        empty.style.justifyContent = 'center';
        empty.style.paddingBottom = '28px';
        empty.textContent = 'No net worth history yet';
        container.appendChild(empty);
        return;
      }
      var values = data.map(function(d) { return Number(d.netWorthSol) || 0; });
      var minValue = Math.min.apply(null, values);
      var maxValue = Math.max.apply(null, values);
      if (maxValue === minValue) {
        var padding = maxValue === 0 ? 0.1 : Math.abs(maxValue) * 0.05;
        maxValue += padding;
        minValue -= padding;
      }
      var yAxis = document.createElement('div');
      yAxis.className = 'chart-y-axis';
      [maxValue, (maxValue + minValue) / 2, minValue].forEach(function(v) {
        var el = document.createElement('div'); el.className = 'chart-y-label'; el.textContent = v.toFixed(4); yAxis.appendChild(el);
      });
      container.appendChild(yAxis);

      var svgNS = 'http://www.w3.org/2000/svg';
      var svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('class', 'chart-svg');
      svg.setAttribute('viewBox', '0 0 1000 220');
      svg.setAttribute('preserveAspectRatio', 'none');

      [0, 0.5, 1].forEach(function(offset) {
        var line = document.createElementNS(svgNS, 'line');
        var y = 12 + (180 * offset);
        line.setAttribute('x1', '0');
        line.setAttribute('y1', String(y));
        line.setAttribute('x2', '1000');
        line.setAttribute('y2', String(y));
        line.setAttribute('class', 'chart-grid-line');
        svg.appendChild(line);
      });

      var points = data.map(function(d, i) {
        var x = data.length === 1 ? 500 : (i / (data.length - 1)) * 1000;
        var value = Number(d.netWorthSol) || 0;
        var y = 12 + ((maxValue - value) / (maxValue - minValue)) * 180;
        return { x: x, y: y, date: d.date || '--', value: value };
      });

      var linePath = points.map(function(point, index) {
        return (index === 0 ? 'M ' : 'L ') + point.x.toFixed(2) + ' ' + point.y.toFixed(2);
      }).join(' ');
      var areaPath = 'M ' + points[0].x.toFixed(2) + ' 192 '
        + points.map(function(point) {
          return 'L ' + point.x.toFixed(2) + ' ' + point.y.toFixed(2);
        }).join(' ')
        + ' L ' + points[points.length - 1].x.toFixed(2) + ' 192 Z';

      var area = document.createElementNS(svgNS, 'path');
      area.setAttribute('class', 'chart-area');
      area.setAttribute('d', areaPath);
      svg.appendChild(area);

      var line = document.createElementNS(svgNS, 'path');
      line.setAttribute('class', 'chart-line');
      line.setAttribute('d', linePath);
      svg.appendChild(line);

      points.forEach(function(point, i) {
        var dot = document.createElementNS(svgNS, 'circle');
        dot.setAttribute('class', 'chart-point');
        dot.setAttribute('cx', point.x.toFixed(2));
        dot.setAttribute('cy', point.y.toFixed(2));
        dot.setAttribute('r', i === points.length - 1 ? '4' : '3');
        var title = document.createElementNS(svgNS, 'title');
        title.textContent = point.date + ': ' + point.value.toFixed(4) + ' SOL';
        dot.appendChild(title);
        svg.appendChild(dot);
      });

      container.appendChild(svg);

      data.forEach(function(d, i) {
        var wrap = document.createElement('div'); wrap.className = 'chart-bar-wrap';
        wrap.style.pointerEvents = 'none';
        if (i % 7 === 0 || i === data.length - 1) { var xl = document.createElement('div'); xl.className = 'chart-x-label'; xl.textContent = String(d.date || '').slice(5); wrap.appendChild(xl); }
        container.appendChild(wrap);
      });
    }
    function renderOpenPositions(positions) {
      var data = Array.isArray(positions) ? positions : [];
      var tbody = $('#open-tbody');
      var empty = $('#open-empty');
      var totalValue = 0, totalFees = 0;
      data.forEach(function(p) { totalValue += Number(p.currentValueSol) || 0; totalFees += Number(p.unclaimedFeeSol) || 0; });
      $('#open-title').textContent = 'Open positions (' + data.length + ')';
      $('#open-summary').innerHTML = 'Total value <b>' + fmtSol(totalValue) + ' SOL</b> &nbsp; Total unclaimed fee <b>' + fmtSol(totalFees) + ' SOL</b>';
      $('#stat-open-count').textContent = String(data.length);
      $('#stat-fee-earned').textContent = fmtSol(totalFees);
      if (!data.length) { tbody.innerHTML = ''; empty.style.display = ''; return; }
      empty.style.display = 'none';
      tbody.innerHTML = data.map(function(p, i) {
        var mint = p.mint || '--';
        var pool = p.poolAddress || '--';
        var coverage = (typeof p.fundedBinCount === 'number' && typeof p.binCount === 'number') ? (p.fundedBinCount + '/' + p.binCount) : '--';
        var rawRange = (typeof p.lowerBinId === 'number' && typeof p.upperBinId === 'number') ? (p.lowerBinId + ' → ' + p.upperBinId) : '--';
        var currentPrice = typeof p.currentPrice === 'number' ? p.currentPrice : null;
        var lowerPrice = typeof p.lowerPrice === 'number' ? p.lowerPrice : null;
        var upperPrice = typeof p.upperPrice === 'number' ? p.upperPrice : null;
        var priceProgress = typeof p.priceProgress === 'number' ? p.priceProgress : null;
        var leftPct = priceProgress !== null ? Math.round(priceProgress * 100) : ((typeof p.fundedBinCount === 'number' && typeof p.binCount === 'number' && p.binCount > 0) ? Math.round((p.fundedBinCount / p.binCount) * 100) : 50);
        var av = mint.charAt(0).toUpperCase() || '?';
        return '<tr>' +
          '<td style="width:20px;color:var(--text-dim);font-size:14px;">↗</td>' +
          '<td><div class="token-cell"><div class="token-avatar">' + escHtml(av) + '</div><div class="token-info"><div class="token-name">' + escHtml(truncAddr(mint)) + ' / SOL</div><div class="token-meta"><span class="dlmm-badge">DLMM</span><span class="pool-addr">' + escHtml(truncAddr(pool)) + '</span></div></div></div></td>' +
          '<td><div class="cell-main">' + fmtSol(Number(p.currentValueSol)) + '</div><div class="cell-sub">SOL</div></td>' +
          '<td><span class="fee-unclaim">' + fmtSol(Number(p.unclaimedFeeSol)) + ' SOL</span></td>' +
          '<td><div class="cell-main">' + fmtPrice(currentPrice) + '</div><div class="cell-sub">SOL/token</div></td>' +
          '<td><span class="cell-main">' + escHtml(coverage) + '</span></td>' +
          '<td><div class="range-labels"><span>' + fmtPrice(lowerPrice) + '</span><span>' + fmtPrice(upperPrice) + '</span></div><div class="range-bar"><div class="range-fill blue" style="width:' + leftPct + '%"></div><div class="range-fill yellow" style="width:' + (100 - leftPct) + '%"></div></div><div class="cell-sub">raw bins ' + escHtml(rawRange) + '</div></td>' +
          '<td><span class="cell-sub">' + escHtml(p.solSide || '--') + '</span></td>' +
          '<td><button class="action-btn" title="position address">↗</button></td>' +
        '</tr>';
      }).join('');
    }
    function renderLogs(logs) {
      var data = Array.isArray(logs) ? logs : [];
      $('#logs-count').textContent = String(data.length);
      $('#logs-body').innerHTML = data.length ? data.map(function(l) {
        var action = l.action || l.stage || '--';
        var klass = '';
        if (action === 'withdraw-lp' || action === 'dca-out') klass = ' warn';
        if (action === 'error' || action === 'circuit-break') klass = ' error';
        return '<div class="log-row"><span class="log-time">' + escHtml(fmtTime(l.recordedAt)) + '</span><span class="log-action' + klass + '">' + escHtml(action) + '</span><span class="log-reason">' + escHtml(l.reason || '') + '</span><span class="log-token">' + escHtml(l.tokenSymbol || '') + '</span></div>';
      }).join('') : '<div class="empty-state">暂无真实日志</div>';
    }
    var logsCollapsed = false;
    $('#logs-header-toggle').addEventListener('click', function() {
      logsCollapsed = !logsCollapsed;
      $('#logs-body').classList.toggle('collapsed', logsCollapsed);
      $('#logs-chevron').textContent = logsCollapsed ? '▶' : '▼';
    });
    $('#copy-btn').addEventListener('click', function() {
      var addr = $('#wallet-full-addr').dataset.full;
      if (!addr || addr === '--') return;
      navigator.clipboard.writeText(addr).then(function() { $('#copy-btn').textContent = '✓ Copied'; setTimeout(function() { $('#copy-btn').textContent = '📋 Copy'; }, 1200); });
    });
    function refreshAll() {
      Promise.all([fetchJson('/api/overview')]).then(function(results) {
        var overview = results[0] || {};
        var status = overview.status || null;
        var positions = overview.positions || [];
        var pnl = overview.pnl || {};
        var equity = overview.equity || {};
        var logs = overview.logs || [];
        if (status) {
          var addr = status.activePoolAddress || status.activeMint || '--';
          $('#wallet-full-addr').textContent = truncAddr(addr);
          $('#wallet-full-addr').dataset.full = addr;
          $('#header-addr').textContent = truncAddr(addr);
          $('#live-text').textContent = String(status.mode || 'unknown').toUpperCase();
          var indicator = $('#live-indicator');
          if (status.mode === 'healthy') { indicator.style.background = 'var(--green-bg)'; indicator.style.color = 'var(--green)'; }
          else if (status.mode === 'circuit_open' || status.mode === 'paused' || status.mode === 'flatten_only') { indicator.style.background = 'var(--red-bg)'; indicator.style.color = 'var(--red)'; }
          else { indicator.style.background = 'var(--yellow-bg)'; indicator.style.color = 'var(--yellow)'; }
          $('#stat-mode').textContent = status.mode || '--';
          $('#stat-lifecycle').textContent = status.lifecycleState || '--';
          $('#stat-circuit').textContent = status.circuitReason || '--';
          var evolution = status.evolution || null;
          $('#stat-research').textContent = evolution
            ? ('proposals=' + String(evolution.proposalCount || 0)
              + ' queue=' + String(evolution.approvalQueueCount || 0)
              + ' scans=' + String(evolution.mirroredCandidateScanCount || 0)
              + ' watch=' + String(evolution.mirroredWatchlistSnapshotCount || 0))
            : '--';
          $('#research-window').textContent = evolution ? String(evolution.latestEvidenceWindow || '--') : '--';
          $('#research-scores').innerHTML = evolution
            ? (
              '<div class="research-score-row">'
              + '<div class="research-score-chip">Coverage<b>' + escHtml(fmtMaybeScore(evolution.latestCoverageScore)) + '</b></div>'
              + '<div class="research-score-chip">Readiness<b>' + escHtml(fmtMaybeScore(evolution.latestReadinessScore)) + '</b></div>'
              + '<div class="research-score-chip">Regime<b>' + escHtml(fmtMaybeScore(evolution.latestRegimeScore)) + '</b></div>'
              + '</div>'
            )
            : 'coverage=-- readiness=-- regime=--';
          $('#research-latest-proposal').textContent = evolution && evolution.latestProposalPath
            ? String(evolution.latestProposalPath)
            : '--';
          $('#research-latest-proposal-meta').textContent = evolution && evolution.latestProposalStatus
            ? ('status=' + String(evolution.latestProposalStatus))
            : 'No evolution proposal yet.';
          $('#research-latest-review').textContent = evolution && evolution.latestReviewStatus
            ? String(evolution.latestReviewStatus)
            : '--';
          $('#research-latest-review-meta').textContent = evolution && evolution.latestReviewProposalId
            ? ('proposal=' + String(evolution.latestReviewProposalId))
            : 'No outcome review yet.';
          var walletSol = typeof status.walletSol === 'number' ? status.walletSol : 0;
          var openValue = Array.isArray(positions) ? positions.reduce(function(sum, p) { return sum + (Number(p.currentValueSol) || 0); }, 0) : 0;
          var openFees = Array.isArray(positions) ? positions.reduce(function(sum, p) { return sum + (Number(p.unclaimedFeeSol) || 0); }, 0) : 0;
          $('#net-worth-num').textContent = (walletSol + openValue + openFees).toFixed(4) + ' ';
          $('#last-update').textContent = timeAgo(status.updatedAt || status.lastSuccessfulTickAt || '');
        }
        var totalCashflow = Number(pnl.totalCashflowSol != null ? pnl.totalCashflowSol : pnl.totalPnl);
        var monthCashflow = Number(pnl.monthCashflowSol != null ? pnl.monthCashflowSol : pnl.monthPnl);
        var dailyEquity = Array.isArray(equity.dailyEquity) ? equity.dailyEquity : [];
        $('#stat-total-profit').textContent = fmtSol(totalCashflow);
        $('#stat-monthly-profit').textContent = fmtSol(monthCashflow);
        $('#stat-total-profit').className = 'stat-value ' + (totalCashflow >= 0 ? 'green' : 'red');
        $('#stat-monthly-profit').className = 'stat-value ' + (monthCashflow >= 0 ? 'green' : 'red');
        renderChart(dailyEquity);
        renderOpenPositions(Array.isArray(positions) ? positions : []);
        renderLogs(Array.isArray(logs) ? logs : []);
      });
    }
    refreshAll();
    setInterval(refreshAll, 5000);

    function fmtMaybeScore(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : '--';
    }
  </script>
</body>
</html>`;
}

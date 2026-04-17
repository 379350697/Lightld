export function buildDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lightld Dashboard</title>
  <meta name="description" content="Lightld Trading Engine — Real-time LP portfolio dashboard">
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
      --bg-input: #1e1e1e;
      --border: #2a2a2a;
      --border-subtle: #222222;
      --text-primary: #ffffff;
      --text-secondary: #a0a0a0;
      --text-muted: #666666;
      --text-dim: #444444;
      --green: #22c55e;
      --green-dim: #16a34a;
      --green-bg: rgba(34, 197, 94, 0.12);
      --green-border: rgba(34, 197, 94, 0.25);
      --red: #ef4444;
      --red-bg: rgba(239, 68, 68, 0.12);
      --red-border: rgba(239, 68, 68, 0.25);
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

    /* ─── Header ─── */
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

    .header-left {
      display: flex;
      align-items: center;
      gap: 24px;
    }

    .logo-group {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .logo-icon {
      width: 32px;
      height: 32px;
      background: linear-gradient(135deg, #22c55e, #16a34a);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
    }

    .logo-icon::after {
      content: '';
      width: 14px;
      height: 14px;
      border: 2px solid rgba(255,255,255,0.9);
      border-radius: 3px;
      transform: rotate(45deg);
    }

    .logo-text {
      font-size: 17px;
      font-weight: 700;
      color: var(--text-primary);
      letter-spacing: -0.3px;
    }

    .nav-tabs {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .nav-tab {
      padding: 6px 16px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      color: var(--text-secondary);
      cursor: pointer;
      transition: all 0.2s;
      text-decoration: none;
      user-select: none;
    }

    .nav-tab:hover {
      color: var(--text-primary);
      background: rgba(255,255,255,0.05);
    }

    .nav-tab.active {
      color: var(--text-primary);
      background: rgba(255,255,255,0.08);
    }

    .header-right {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .live-indicator {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 12px;
      border-radius: 6px;
      background: var(--green-bg);
      font-size: 12px;
      font-weight: 600;
      color: var(--green);
    }

    .live-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--green);
      animation: pulse 2s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    .header-wallet {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      border-radius: 8px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      font-size: 13px;
      font-family: var(--font-mono);
      color: var(--text-secondary);
      cursor: pointer;
      transition: border-color 0.2s;
    }

    .header-wallet:hover {
      border-color: var(--text-muted);
    }

    .header-wallet .sol-icon {
      width: 18px;
      height: 18px;
      background: linear-gradient(135deg, #9945FF, #14F195);
      border-radius: 50%;
    }

    /* ─── Main Container ─── */
    .main {
      max-width: 1400px;
      margin: 0 auto;
      padding: 24px;
    }

    /* ─── Wallet Info Bar ─── */
    .wallet-bar {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 8px;
    }

    .wallet-address {
      font-family: var(--font-mono);
      font-size: 14px;
      color: var(--text-primary);
      cursor: pointer;
    }

    .wallet-address:hover {
      text-decoration: underline;
    }

    .copy-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      border-radius: 4px;
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-muted);
      font-size: 11px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .copy-btn:hover {
      border-color: var(--text-secondary);
      color: var(--text-secondary);
    }

    .update-info {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: var(--text-muted);
      margin-bottom: 16px;
    }

    /* ─── Portfolio Section ─── */
    .portfolio-section {
      display: grid;
      grid-template-columns: 340px 1fr;
      gap: 0;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
      margin-bottom: 32px;
    }

    .portfolio-stats {
      padding: 28px;
      border-right: 1px solid var(--border);
    }

    .net-worth-label {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 8px;
    }

    .net-worth-value {
      font-size: 34px;
      font-weight: 800;
      color: var(--text-primary);
      font-family: var(--font-sans);
      letter-spacing: -1px;
      margin-bottom: 24px;
    }

    .net-worth-value .sol-unit {
      font-size: 20px;
      font-weight: 600;
      color: var(--text-secondary);
      margin-left: 6px;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0;
    }

    .stat-item {
      padding: 12px 0;
      border-top: 1px solid var(--border-subtle);
    }

    .stat-item:nth-child(odd) {
      padding-right: 16px;
    }

    .stat-item:nth-child(even) {
      padding-left: 16px;
      border-left: 1px solid var(--border-subtle);
    }

    .stat-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.8px;
      margin-bottom: 4px;
    }

    .stat-value {
      font-size: 18px;
      font-weight: 700;
      color: var(--text-primary);
    }

    .stat-value.green { color: var(--green); }
    .stat-value.red { color: var(--red); }

    .stat-value .sol-sym {
      font-size: 14px;
      color: var(--text-muted);
      margin-left: 2px;
    }

    /* ─── Chart Section ─── */
    .portfolio-chart {
      padding: 28px;
      display: flex;
      flex-direction: column;
    }

    .chart-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 20px;
      flex-wrap: wrap;
      gap: 12px;
    }

    .chart-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .chart-controls {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .chart-filter-group {
      display: flex;
      align-items: center;
      gap: 2px;
      background: var(--bg-surface);
      border-radius: 8px;
      padding: 2px;
    }

    .chart-filter-btn {
      padding: 5px 12px;
      border-radius: 6px;
      border: none;
      background: transparent;
      color: var(--text-muted);
      font-size: 12px;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      transition: all 0.2s;
    }

    .chart-filter-btn:hover {
      color: var(--text-secondary);
    }

    .chart-filter-btn.active {
      background: var(--green);
      color: #000;
    }

    .chart-body {
      flex: 1;
      min-height: 200px;
      display: flex;
      align-items: flex-end;
      gap: 2px;
      position: relative;
      padding-left: 50px;
      padding-bottom: 28px;
    }

    .chart-y-axis {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 28px;
      width: 46px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      align-items: flex-end;
      padding-right: 8px;
    }

    .chart-y-label {
      font-size: 10px;
      font-family: var(--font-mono);
      color: var(--text-dim);
      white-space: nowrap;
    }

    .chart-zero-line {
      position: absolute;
      left: 50px;
      right: 0;
      border-top: 1px solid var(--border-subtle);
    }

    .chart-bar-wrap {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      height: 100%;
      position: relative;
      cursor: pointer;
    }

    .chart-bar-wrap:hover .chart-bar {
      filter: brightness(1.3);
    }

    .chart-bar {
      width: 80%;
      max-width: 16px;
      border-radius: 2px;
      position: absolute;
      transition: height 0.4s ease;
      min-height: 2px;
    }

    .chart-bar.pos {
      background: var(--green);
      bottom: 50%;
    }

    .chart-bar.neg {
      background: var(--red);
      top: 50%;
    }

    .chart-x-label {
      position: absolute;
      bottom: -22px;
      font-size: 9px;
      font-family: var(--font-mono);
      color: var(--text-dim);
      white-space: nowrap;
    }

    .chart-tooltip {
      display: none;
      position: absolute;
      bottom: calc(100% + 8px);
      left: 50%;
      transform: translateX(-50%);
      background: #252525;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 11px;
      font-family: var(--font-mono);
      color: var(--text-primary);
      white-space: nowrap;
      z-index: 10;
      pointer-events: none;
    }

    .chart-bar-wrap:hover .chart-tooltip {
      display: block;
    }

    /* Watermark */
    .chart-watermark {
      position: absolute;
      top: 50%;
      left: 55%;
      transform: translate(-50%, -50%);
      display: flex;
      align-items: center;
      gap: 10px;
      opacity: 0.06;
      pointer-events: none;
    }

    .chart-watermark .wm-icon {
      width: 40px;
      height: 40px;
      background: var(--green);
      border-radius: 50%;
    }

    .chart-watermark .wm-text {
      font-size: 28px;
      font-weight: 800;
      color: var(--text-primary);
    }

    /* ─── Positions Section ─── */
    .positions-section {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
      margin-bottom: 32px;
    }

    .positions-header {
      padding: 20px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 12px;
    }

    .positions-title {
      font-size: 16px;
      font-weight: 700;
      color: var(--text-primary);
    }

    .positions-summary {
      display: flex;
      align-items: center;
      gap: 20px;
      font-size: 13px;
      color: var(--text-secondary);
      flex-wrap: wrap;
    }

    .positions-summary b {
      color: var(--text-primary);
      font-weight: 600;
    }

    .positions-summary .green { color: var(--green); }
    .positions-summary .red { color: var(--red); }

    .view-toggle {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .view-btn {
      padding: 5px 10px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--text-muted);
      font-size: 12px;
      font-weight: 500;
      font-family: inherit;
      cursor: pointer;
      transition: all 0.2s;
    }

    .view-btn.active {
      background: rgba(255,255,255,0.08);
      color: var(--text-primary);
      border-color: var(--text-dim);
    }

    /* ─── Position Table ─── */
    .pos-table {
      width: 100%;
      border-collapse: collapse;
    }

    .pos-table th {
      text-align: left;
      padding: 10px 16px;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
      border-bottom: 1px solid var(--border);
      border-top: 1px solid var(--border);
      background: var(--bg-surface);
      white-space: nowrap;
    }

    .pos-table td {
      padding: 14px 16px;
      border-bottom: 1px solid var(--border-subtle);
      font-size: 13px;
      color: var(--text-secondary);
      vertical-align: middle;
    }

    .pos-table tbody tr {
      transition: background 0.15s;
    }

    .pos-table tbody tr:hover {
      background: var(--bg-card-hover);
    }

    .pos-table tbody tr:last-child td {
      border-bottom: none;
    }

    /* Token Cell */
    .token-cell {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .token-avatar {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      font-weight: 700;
      color: #fff;
      flex-shrink: 0;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
    }

    .token-avatar.av-0 { background: linear-gradient(135deg, #8b5cf6, #a78bfa); }
    .token-avatar.av-1 { background: linear-gradient(135deg, #3b82f6, #60a5fa); }
    .token-avatar.av-2 { background: linear-gradient(135deg, #22c55e, #4ade80); }
    .token-avatar.av-3 { background: linear-gradient(135deg, #f59e0b, #fbbf24); }
    .token-avatar.av-4 { background: linear-gradient(135deg, #ef4444, #f87171); }
    .token-avatar.av-5 { background: linear-gradient(135deg, #ec4899, #f472b6); }
    .token-avatar.av-6 { background: linear-gradient(135deg, #14b8a6, #2dd4bf); }

    .token-info {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .token-name {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .token-meta {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .dlmm-badge {
      display: inline-flex;
      align-items: center;
      padding: 1px 6px;
      border-radius: 4px;
      background: var(--green-bg);
      color: var(--green);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.5px;
    }

    .pool-addr {
      font-size: 11px;
      font-family: var(--font-mono);
      color: var(--text-muted);
    }

    /* Value cells */
    .cell-main {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      font-family: var(--font-mono);
    }

    .cell-sub {
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 2px;
    }

    .cell-green { color: var(--green); }
    .cell-red { color: var(--red); }

    /* Fee cell */
    .fee-cell {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .fee-row {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      font-family: var(--font-mono);
    }

    .fee-claimed { color: var(--text-secondary); }

    .fee-unclaim {
      padding: 2px 8px;
      border-radius: 4px;
      background: var(--green-bg);
      color: var(--green);
      font-size: 12px;
      font-weight: 500;
    }

    /* DPR */
    .dpr-value {
      font-size: 14px;
      font-weight: 600;
      font-family: var(--font-mono);
      color: var(--green);
    }

    /* Range Bar */
    .range-cell {
      min-width: 140px;
    }

    .range-bar {
      display: flex;
      align-items: center;
      gap: 0;
      height: 6px;
      background: var(--border);
      border-radius: 3px;
      overflow: hidden;
      position: relative;
      margin: 4px 0;
    }

    .range-fill {
      height: 100%;
      border-radius: 3px;
    }

    .range-fill.blue { background: var(--blue); }
    .range-fill.yellow { background: var(--yellow); }
    .range-fill.green { background: var(--green); }
    .range-fill.red { background: var(--red); }

    .range-labels {
      display: flex;
      justify-content: space-between;
      font-size: 9px;
      font-family: var(--font-mono);
      color: var(--text-dim);
    }

    /* Action */
    .action-btn {
      width: 28px;
      height: 28px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
      font-size: 14px;
    }

    .action-btn:hover {
      border-color: var(--text-secondary);
      color: var(--text-primary);
      background: rgba(255,255,255,0.05);
    }

    /* ─── Historical Section ─── */
    .historical-section {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
      margin-bottom: 32px;
    }

    .historical-header {
      padding: 20px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .historical-title {
      font-size: 16px;
      font-weight: 700;
      color: var(--text-primary);
    }

    .historical-controls {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    /* ─── Logs Section ─── */
    .logs-section {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
      margin-bottom: 32px;
    }

    .logs-header {
      padding: 16px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--border);
      cursor: pointer;
      user-select: none;
    }

    .logs-header:hover {
      background: var(--bg-card-hover);
    }

    .logs-title {
      font-size: 15px;
      font-weight: 700;
      color: var(--text-primary);
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .logs-count {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 10px;
      background: rgba(255,255,255,0.08);
      color: var(--text-secondary);
      font-family: var(--font-mono);
    }

    .logs-toggle {
      font-size: 12px;
      color: var(--text-muted);
      transition: transform 0.2s;
    }

    .logs-body {
      max-height: 400px;
      overflow-y: auto;
      padding: 0;
    }

    .logs-body.collapsed {
      display: none;
    }

    .log-row {
      display: grid;
      grid-template-columns: 80px 100px 1fr auto;
      gap: 12px;
      padding: 8px 24px;
      font-size: 12px;
      font-family: var(--font-mono);
      border-bottom: 1px solid var(--border-subtle);
      transition: background 0.1s;
      align-items: center;
    }

    .log-row:hover {
      background: var(--bg-card-hover);
    }

    .log-time { color: var(--text-dim); font-size: 11px; }
    .log-action { color: var(--green); font-weight: 600; font-size: 11px; }
    .log-reason { color: var(--text-secondary); font-size: 11px; word-break: break-all; }
    .log-token { color: var(--text-muted); font-size: 11px; }

    .log-action.warn { color: var(--yellow); }
    .log-action.error { color: var(--red); }

    /* ─── Scrollbar ─── */
    ::-webkit-scrollbar { width: 5px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

    /* ─── Empty State ─── */
    .empty-state {
      text-align: center;
      padding: 48px 16px;
      color: var(--text-muted);
      font-size: 14px;
    }

    /* ─── Responsive ─── */
    @media (max-width: 900px) {
      .portfolio-section {
        grid-template-columns: 1fr;
      }
      .portfolio-stats {
        border-right: none;
        border-bottom: 1px solid var(--border);
      }
      .pos-table { font-size: 12px; }
      .header { padding: 0 12px; }
      .main { padding: 16px; }
    }

    /* ─── Animations ─── */
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .portfolio-section,
    .positions-section,
    .historical-section,
    .logs-section {
      animation: fadeIn 0.4s ease both;
    }

    .positions-section { animation-delay: 0.1s; }
    .historical-section { animation-delay: 0.2s; }
    .logs-section { animation-delay: 0.3s; }
  </style>
</head>
<body>

  <!-- ═══ Header ═══ -->
  <header class="header" id="main-header">
    <div class="header-left">
      <div class="logo-group">
        <div class="logo-icon"></div>
        <span class="logo-text">Lightld</span>
      </div>
      <nav class="nav-tabs">
        <a class="nav-tab active" data-section="portfolio">Portfolio</a>
        <a class="nav-tab" data-section="positions">Positions</a>
        <a class="nav-tab" data-section="logs">Logs</a>
      </nav>
    </div>
    <div class="header-right">
      <div class="live-indicator" id="live-indicator">
        <div class="live-dot"></div>
        <span id="live-text">LIVE</span>
      </div>
      <div class="header-wallet" id="header-wallet">
        <div class="sol-icon"></div>
        <span id="header-addr">--</span>
      </div>
    </div>
  </header>

  <!-- ═══ Main Content ═══ -->
  <div class="main">

    <!-- Wallet bar -->
    <div class="wallet-bar">
      <span class="wallet-address" id="wallet-full-addr" title="Click to copy">--</span>
      <button class="copy-btn" id="copy-btn">📋 Copy</button>
    </div>
    <div class="update-info">
      <span>Last updated: <span id="last-update">a few seconds ago</span></span>
    </div>

    <!-- ═══ Portfolio Overview ═══ -->
    <div class="portfolio-section" id="section-portfolio">
      <div class="portfolio-stats">
        <div class="net-worth-label">TOTAL NET WORTH <span style="cursor:help;" title="Total wallet SOL + open position value">&#9432;</span></div>
        <div class="net-worth-value" id="net-worth">
          <span id="net-worth-num">--</span><span class="sol-unit">SOL</span>
        </div>

        <div class="stats-grid" id="stats-grid">
          <div class="stat-item">
            <div class="stat-label">TOTAL CLOSED</div>
            <div class="stat-value" id="stat-closed">--</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">WIN RATE</div>
            <div class="stat-value green" id="stat-winrate">--</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">AVG INVESTED</div>
            <div class="stat-value" id="stat-avg-invested">--</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">FEE EARNED</div>
            <div class="stat-value" id="stat-fee-earned">--</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">TOTAL PROFIT</div>
            <div class="stat-value green" id="stat-total-profit">--</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">AVG MONTHLY PROFIT</div>
            <div class="stat-value" id="stat-monthly-profit">--</div>
          </div>
          <div class="stat-item" style="grid-column: span 2;">
            <div class="stat-label">EXPECTED VALUE <span style="cursor:help;" title="Average expected PnL per position">&#9432;</span></div>
            <div class="stat-value green" id="stat-ev">--</div>
          </div>
        </div>
      </div>

      <div class="portfolio-chart">
        <div class="chart-header">
          <div class="chart-title">PROFIT HISTORY</div>
          <div class="chart-controls">
            <div class="chart-filter-group">
              <button class="chart-filter-btn active">All</button>
              <button class="chart-filter-btn">DLMM</button>
            </div>
            <div class="chart-filter-group">
              <button class="chart-filter-btn active">Day</button>
              <button class="chart-filter-btn">Week</button>
              <button class="chart-filter-btn">Month</button>
            </div>
            <div class="chart-filter-group">
              <button class="chart-filter-btn">7D</button>
              <button class="chart-filter-btn active">1M</button>
              <button class="chart-filter-btn">3M</button>
              <button class="chart-filter-btn">ALL</button>
            </div>
          </div>
        </div>
        <div class="chart-body" id="pnl-chart">
          <div class="chart-watermark">
            <div class="wm-icon"></div>
            <span class="wm-text">Lightld</span>
          </div>
        </div>
      </div>
    </div>

    <!-- ═══ Open Positions ═══ -->
    <div class="positions-section" id="section-positions">
      <div class="positions-header">
        <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
          <div class="positions-title" id="open-title">Open positions (0)</div>
          <div class="positions-summary" id="open-summary"></div>
        </div>
        <div class="view-toggle">
          <button class="view-btn active">&#9638; Table</button>
        </div>
      </div>
      <div style="overflow-x:auto;">
        <table class="pos-table" id="open-table">
          <thead>
            <tr>
              <th style="width:20px;"></th>
              <th>Position/Pool</th>
              <th>Age</th>
              <th>Value</th>
              <th>Claimed | Unclaim Fee</th>
              <th>uPnL</th>
              <th>DPR <span style="cursor:help;" title="Daily Percentage Return">&#9432;</span></th>
              <th>Range</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody id="open-tbody"></tbody>
        </table>
      </div>
    </div>

    <!-- ═══ Historical Positions ═══ -->
    <div class="historical-section" id="section-historical">
      <div class="historical-header">
        <div class="historical-title" id="hist-title">Historical positions</div>
        <div class="historical-controls">
          <button class="view-btn active">&#9638; Table</button>
        </div>
      </div>
      <div style="overflow-x:auto;">
        <table class="pos-table" id="hist-table">
          <thead>
            <tr>
              <th style="width:20px;"></th>
              <th>Position/Pool</th>
              <th>Age</th>
              <th>Invested</th>
              <th>Fee Earned</th>
              <th>PnL</th>
              <th>DPR <span style="cursor:help;" title="Daily Percentage Return">&#9432;</span></th>
              <th>Closed At</th>
            </tr>
          </thead>
          <tbody id="hist-tbody"></tbody>
        </table>
      </div>
    </div>

    <!-- ═══ Decision Logs ═══ -->
    <div class="logs-section" id="section-logs">
      <div class="logs-header" id="logs-header-toggle">
        <div class="logs-title">
          Decision Logs
          <span class="logs-count" id="logs-count">0</span>
        </div>
        <div class="logs-toggle" id="logs-chevron">&#9660;</div>
      </div>
      <div class="logs-body" id="logs-body"></div>
    </div>

  </div>

  <script>
    // ─── Helpers ───
    var $ = function(sel) { return document.querySelector(sel); };

    function escHtml(t) {
      var d = document.createElement('div');
      d.textContent = t;
      return d.innerHTML;
    }

    function truncAddr(a) {
      if (!a || a.length < 12) return a || '--';
      return a.slice(0, 6) + '...' + a.slice(-4);
    }

    function fmtSol(v) {
      if (typeof v !== 'number') return '0.00';
      return v.toFixed(4);
    }

    function fmtSol2(v) {
      if (typeof v !== 'number') return '0.00';
      return v.toFixed(2);
    }

    function fmtPct(v) {
      if (typeof v !== 'number') return '0.00%';
      return v.toFixed(2) + '%';
    }

    function fmtTime(iso) {
      if (!iso) return '--';
      var d = new Date(iso);
      return d.toLocaleTimeString('zh-CN', { hour12: false });
    }

    function timeAgo(iso) {
      if (!iso) return '--';
      var ms = Date.now() - new Date(iso).getTime();
      var min = Math.floor(ms / 60000);
      if (min < 1) return 'just now';
      if (min < 60) return min + ' min ago';
      var hr = Math.floor(min / 60);
      if (hr < 24) return hr + ' hours ago';
      var d = Math.floor(hr / 24);
      return d + ' days ago';
    }

    function ageStr(ms) {
      if (!ms || ms <= 0) return '--';
      var hr = ms / 3600000;
      if (hr < 1) return Math.floor(hr * 60) + ' min';
      if (hr < 24) return hr.toFixed(1) + 'h';
      var d = hr / 24;
      if (d < 2) return 'a day';
      return d.toFixed(1) + ' days';
    }

    // ─── Mock Data ───
    var MOCK_OPEN = [
      { symbol: 'ASTEROID', pool: 'GjpVkg...39L4', ageMs: 6*3600000, value: 40.0673, claimedFee: 0, unclaimFee: 0.008, upnl: 0.07, upnlPct: 0.17, dpr: 0.83, rangeL: 0.2662, rangeR: 0.5299, rangePct: 0.65 },
      { symbol: '114514', pool: '7PFchZ...SyDD', ageMs: 26*3600000, value: 5.0032, claimedFee: 0, unclaimFee: 0.03, upnl: 0.03, upnlPct: 0.66, dpr: 0.72, rangeL: 0.4578, rangeR: 0.1311, rangePct: 0.45 },
      { symbol: 'AIFRUITS', pool: 'ALfqGM...jCkD', ageMs: 30*3600000, value: 4.0029, claimedFee: 0, unclaimFee: 0.008, upnl: 0.01, upnlPct: 0.28, dpr: 0.19, rangeL: 0.1064, rangeR: 0.3055, rangePct: 0.55 },
      { symbol: 'NUERO', pool: '6wzjZH...BCTe', ageMs: 52*3600000, value: 2.9852, claimedFee: 0, unclaimFee: 0.07, upnl: 0.05, upnlPct: 1.68, dpr: 0.68, rangeL: 0.5572, rangeR: 0.1600, rangePct: 0.38 },
      { symbol: 'GAS', pool: '7aBvah...TvZe', ageMs: 72*3600000, value: 2.9957, claimedFee: 0, unclaimFee: 0.04, upnl: 0.03, upnlPct: 1.13, dpr: 0.34, rangeL: 0.7094, rangeR: 0.2031, rangePct: 0.50 },
      { symbol: 'Mythos', pool: '7gGIMW...M9Dh', ageMs: 96*3600000, value: 1.9263, claimedFee: 0, unclaimFee: 0.10, upnl: 0.03, upnlPct: 1.38, dpr: 0.33, rangeL: 0.5355, rangeR: 0.1537, rangePct: 0.42 },
      { symbol: 'SCUBA', pool: 'ERvVNr...8H1h', ageMs: 100*3600000, value: 3.0050, claimedFee: 0, unclaimFee: 0.008, upnl: 0.008, upnlPct: 0.29, dpr: 0.07, rangeL: 0.4074, rangeR: 0.4428, rangePct: 0.60 }
    ];

    var MOCK_HISTORICAL = [
      { symbol: 'ASTEROID', pool: 'GPqmjZ...M96s', age: '1.24h', invested: 40.0, feeEarned: 0.66, feePct: 1.64, pnl: 0.66, pnlPct: 1.64, dpr: 31.72, closedAt: '6 hours ago' },
      { symbol: 'ASTEROID', pool: 'S3uesA...1fZd', age: '0.01h', invested: 30.2158, feeEarned: 0, feePct: 0, pnl: 0.008, pnlPct: 0.01, dpr: 0.01, closedAt: '7 hours ago' },
      { symbol: 'ASTEROID', pool: 'H5pQw2...FVqY', age: '2.21h', invested: 44.0, feeEarned: 0.08, feePct: 0.18, pnl: 0.08, pnlPct: 0.18, dpr: 1.93, closedAt: '7 hours ago' },
      { symbol: 'Downald', pool: 'ASkLC3...4UzQ', age: '3.94 days', invested: 3.0, feeEarned: 0.17, feePct: 5.75, pnl: 0.78, pnlPct: 26.0, dpr: 8.60, closedAt: '7 hours ago' }
    ];

    // Generate mock daily PnL (30 days)
    var MOCK_DAILY = [];
    (function() {
      var now = Date.now();
      for (var i = 29; i >= 0; i--) {
        var d = new Date(now - i * 86400000);
        var dateStr = d.toISOString().slice(0, 10);
        // Generate realistic PnL: mostly positive, some negative
        var val = (Math.random() - 0.22) * 3;
        if (i > 20) val = (Math.random() - 0.3) * 1.5;
        if (i < 5) val = Math.random() * 5 + 1;
        MOCK_DAILY.push({ date: dateStr, pnl: Math.round(val * 10000) / 10000 });
      }
    })();

    var MOCK_STATS = {
      totalNetWorth: 82.20,
      totalClosed: 260,
      winRate: 92.19,
      avgInvested: 4.89,
      feeEarned: 37.40,
      totalProfit: 14.96,
      avgMonthlyProfit: 9.91,
      expectedValue: 0.08
    };

    var MOCK_LOGS = [
      { time: '00:30:12', action: 'scan-pools', reason: 'Scanned 342 DLMM pools, found 12 candidates above threshold', token: '' },
      { time: '00:30:15', action: 'score-token', reason: 'ASTEROID safety=108/120, yield=35/40, total=143/160', token: 'ASTEROID' },
      { time: '00:30:16', action: 'score-token', reason: '114514 safety=95/120, yield=32/40, total=127/160', token: '114514' },
      { time: '00:30:18', action: 'open-position', reason: 'Deploying 40 SOL to ASTEROID/SOL DLMM pool', token: 'ASTEROID' },
      { time: '00:30:22', action: 'add-lp', reason: 'LP position created, bin range 2662-5299', token: 'ASTEROID' },
      { time: '00:25:01', action: 'hold', reason: 'All 7 positions within parameters, no action needed', token: '' },
      { time: '00:20:05', action: 'claim-fee', reason: 'Claimed 0.17 SOL fees from Downald/SOL position', token: 'Downald' },
      { time: '00:15:12', action: 'withdraw-lp', reason: 'Position age 3.94d exceeds 18h hard exit, withdrawing', token: 'Downald' },
      { time: '00:15:15', action: 'dca-out', reason: 'Starting DCA sell of Downald tokens via Jupiter', token: 'Downald' },
      { time: '00:10:30', action: 'hold', reason: 'Position NUERO/SOL healthy, DPR=0.68%, holding', token: 'NUERO' }
    ];

    // ─── Render Portfolio Stats (mock or real) ───
    function renderStats(stats, pnlData) {
      var s = stats || MOCK_STATS;

      $('#net-worth-num').textContent = s.totalNetWorth.toFixed(2) + ' ';
      $('#stat-closed').textContent = s.totalClosed;
      $('#stat-winrate').textContent = s.winRate.toFixed(2) + '%';
      $('#stat-avg-invested').innerHTML = s.avgInvested.toFixed(2) + ' <span class="sol-sym">&#8779;</span>';
      $('#stat-fee-earned').innerHTML = s.feeEarned.toFixed(2) + ' <span class="sol-sym">&#8779;</span>';
      $('#stat-total-profit').innerHTML = s.totalProfit.toFixed(2) + ' <span class="sol-sym">&#8779;</span>';
      $('#stat-monthly-profit').innerHTML = s.avgMonthlyProfit.toFixed(2) + ' <span class="sol-sym">&#8779;</span>';
      $('#stat-ev').innerHTML = s.expectedValue.toFixed(2) + ' <span class="sol-sym">&#8779;</span>';

      // Set profit color
      var profitEl = $('#stat-total-profit');
      profitEl.className = 'stat-value ' + (s.totalProfit >= 0 ? 'green' : 'red');
    }

    // ─── Render Chart ───
    function renderChart(dailyPnl) {
      var data = dailyPnl && dailyPnl.length > 0 ? dailyPnl : MOCK_DAILY;
      var container = $('#pnl-chart');

      // Keep watermark
      var watermark = container.querySelector('.chart-watermark');
      container.innerHTML = '';
      if (watermark) container.appendChild(watermark);

      if (!data.length) return;

      var maxAbs = Math.max.apply(null, data.map(function(d) { return Math.abs(d.pnl); }));
      if (maxAbs < 0.001) maxAbs = 0.001;

      // Y-axis
      var yAxis = document.createElement('div');
      yAxis.className = 'chart-y-axis';
      var yLabels = [maxAbs.toFixed(4), (maxAbs/2).toFixed(4), '0.00', (-maxAbs/2).toFixed(4), (-maxAbs).toFixed(4)];
      yLabels.forEach(function(lbl) {
        var el = document.createElement('div');
        el.className = 'chart-y-label';
        el.textContent = lbl;
        yAxis.appendChild(el);
      });
      container.appendChild(yAxis);

      // Zero line
      var zeroLine = document.createElement('div');
      zeroLine.className = 'chart-zero-line';
      zeroLine.style.top = '50%';
      container.appendChild(zeroLine);

      // Bars
      data.forEach(function(d, i) {
        var pct = (Math.abs(d.pnl) / maxAbs) * 45;
        var wrapper = document.createElement('div');
        wrapper.className = 'chart-bar-wrap';

        var bar = document.createElement('div');
        bar.className = 'chart-bar ' + (d.pnl >= 0 ? 'pos' : 'neg');
        bar.style.height = Math.max(pct, 1) + '%';

        var tooltip = document.createElement('div');
        tooltip.className = 'chart-tooltip';
        tooltip.textContent = d.date + ': ' + (d.pnl >= 0 ? '+' : '') + d.pnl.toFixed(4) + ' SOL';

        wrapper.appendChild(bar);
        wrapper.appendChild(tooltip);

        // X labels every 5th bar
        if (i % 7 === 0 || i === data.length - 1) {
          var xl = document.createElement('div');
          xl.className = 'chart-x-label';
          var dp = d.date.split('-');
          xl.textContent = dp[1] + '/' + dp[2];
          wrapper.appendChild(xl);
        }

        container.appendChild(wrapper);
      });
    }

    // ─── Render Open Positions ───
    function renderOpenPositions(positions) {
      var data = positions && positions.length > 0 ? positions : MOCK_OPEN;
      var tbody = $('#open-tbody');
      var totalValue = 0;
      var totalUpnl = 0;
      var totalUnclaim = 0;

      data.forEach(function(p) {
        totalValue += p.value || 0;
        totalUpnl += p.upnl || 0;
        totalUnclaim += p.unclaimFee || 0;
      });

      // Header
      $('#open-title').textContent = 'Open positions (' + data.length + ')';
      var upnlPct = totalValue > 0 ? (totalUpnl / totalValue * 100) : 0;
      $('#open-summary').innerHTML =
        'Total value <b>' + totalValue.toFixed(2) + ' SOL</b> &nbsp; ' +
        'Total uPnL <b>' + totalUpnl.toFixed(2) + ' SOL</b> <span class="' + (totalUpnl >= 0 ? 'green' : 'red') + '">' + upnlPct.toFixed(2) + '%</span> &nbsp; ' +
        'Total claimed fee <b>0.00 SOL</b> &nbsp; ' +
        'Total unclaim fee <b>' + totalUnclaim.toFixed(2) + ' SOL</b>';

      // Rows
      var html = '';
      data.forEach(function(p, i) {
        var avClass = 'av-' + (i % 7);
        var initial = p.symbol ? p.symbol.charAt(0) : '?';
        var age = p.ageMs ? ageStr(p.ageMs) : (p.age || '--');
        var rangeLeftPct = Math.round((p.rangePct || 0.5) * 100);
        var rangeColor = rangeLeftPct > 50 ? 'blue' : 'yellow';
        var rangeRestColor = rangeLeftPct > 50 ? 'yellow' : 'red';

        html +=
          '<tr>' +
          '<td style="width:20px;color:var(--text-dim);font-size:14px;cursor:pointer;">&#8599;</td>' +
          '<td>' +
            '<div class="token-cell">' +
              '<div class="token-avatar ' + avClass + '">' + escHtml(initial) + '</div>' +
              '<div class="token-info">' +
                '<div class="token-name">' + escHtml(p.symbol) + ' / SOL</div>' +
                '<div class="token-meta">' +
                  '<span class="dlmm-badge">DLMM</span>' +
                  '<span class="pool-addr">' + escHtml(p.pool) + '</span>' +
                '</div>' +
              '</div>' +
            '</div>' +
          '</td>' +
          '<td><span class="cell-main">' + escHtml(age) + '</span></td>' +
          '<td><span class="cell-main">' + p.value.toFixed(4) + '</span> <span class="cell-sub">&#8779;</span></td>' +
          '<td>' +
            '<div class="fee-cell">' +
              '<div class="fee-row">' +
                '<span class="fee-claimed">' + fmtSol2(p.claimedFee) + ' SOL</span>' +
                '<span style="color:var(--text-dim);">|</span>' +
                '<span class="fee-unclaim">' + (p.unclaimFee < 0.01 ? '< 0.01' : fmtSol2(p.unclaimFee)) + ' SOL</span>' +
              '</div>' +
              '<div class="cell-sub">' + fmtPct(p.unclaimFee / p.value * 100) + '</div>' +
            '</div>' +
          '</td>' +
          '<td>' +
            '<div class="cell-main ' + (p.upnl >= 0 ? 'cell-green' : 'cell-red') + '">' + (p.upnl < 0.01 && p.upnl > 0 ? '< 0.01' : fmtSol2(p.upnl)) + ' SOL</div>' +
            '<div class="cell-sub">' + fmtPct(p.upnlPct) + '</div>' +
          '</td>' +
          '<td><span class="dpr-value">' + fmtPct(p.dpr) + '</span></td>' +
          '<td class="range-cell">' +
            '<div class="range-labels"><span>0.0=' + Math.round(p.rangeL * 10000) + '</span><span>0.0=' + Math.round(p.rangeR * 10000) + '</span></div>' +
            '<div class="range-bar">' +
              '<div class="range-fill ' + rangeColor + '" style="width:' + rangeLeftPct + '%;"></div>' +
              '<div class="range-fill ' + rangeRestColor + '" style="width:' + (100 - rangeLeftPct) + '%;"></div>' +
            '</div>' +
          '</td>' +
          '<td><button class="action-btn" title="View details">&#8599;</button></td>' +
          '</tr>';
      });

      tbody.innerHTML = html;
    }

    // ─── Render Historical Positions ───
    function renderHistorical(positions) {
      var data = positions && positions.length > 0 ? positions : MOCK_HISTORICAL;
      var tbody = $('#hist-tbody');

      var html = '';
      data.forEach(function(p, i) {
        var avClass = 'av-' + (i % 7);
        var initial = p.symbol ? p.symbol.charAt(0) : '?';
        var pnlColor = p.pnl >= 0 ? 'cell-green' : 'cell-red';

        html +=
          '<tr>' +
          '<td style="width:20px;color:var(--text-dim);font-size:14px;cursor:pointer;">&#8599;</td>' +
          '<td>' +
            '<div class="token-cell">' +
              '<div class="token-avatar ' + avClass + '">' + escHtml(initial) + '</div>' +
              '<div class="token-info">' +
                '<div class="token-name">' + escHtml(p.symbol) + ' / SOL</div>' +
                '<div class="token-meta">' +
                  '<span class="dlmm-badge">DLMM</span>' +
                  '<span class="pool-addr">' + escHtml(p.pool) + '</span>' +
                '</div>' +
              '</div>' +
            '</div>' +
          '</td>' +
          '<td><span class="cell-main">' + escHtml(p.age) + '</span></td>' +
          '<td><span class="cell-main">' + p.invested.toFixed(4) + '</span> <span class="cell-sub">&#8779;</span></td>' +
          '<td>' +
            '<div class="cell-main ' + pnlColor + '">' + fmtSol2(p.feeEarned) + ' SOL</div>' +
            '<div class="cell-sub">' + fmtPct(p.feePct) + '</div>' +
          '</td>' +
          '<td>' +
            '<div class="cell-main ' + pnlColor + '">' + fmtSol2(p.pnl) + ' SOL</div>' +
            '<div class="cell-sub ' + pnlColor + '">' + fmtPct(p.pnlPct) + '</div>' +
          '</td>' +
          '<td><span class="dpr-value">' + fmtPct(p.dpr) + '</span></td>' +
          '<td><span class="cell-sub">' + escHtml(p.closedAt) + '</span></td>' +
          '</tr>';
      });

      tbody.innerHTML = html;
    }

    // ─── Render Logs ───
    function renderLogs(logs) {
      var data = logs && logs.length > 0 ? logs : MOCK_LOGS;
      var body = $('#logs-body');
      $('#logs-count').textContent = data.length;

      var html = '';
      data.forEach(function(l) {
        var actionClass = '';
        var action = l.action || l.stage || '--';
        if (action === 'withdraw-lp' || action === 'dca-out') actionClass = ' warn';
        if (action === 'error' || action === 'circuit-break') actionClass = ' error';

        var time = l.time || fmtTime(l.recordedAt) || '--';

        html +=
          '<div class="log-row">' +
          '<span class="log-time">' + escHtml(time) + '</span>' +
          '<span class="log-action' + actionClass + '">' + escHtml(action) + '</span>' +
          '<span class="log-reason">' + escHtml(l.reason || '') + '</span>' +
          '<span class="log-token">' + escHtml(l.token || l.tokenSymbol || '') + '</span>' +
          '</div>';
      });

      body.innerHTML = html;
    }

    // ─── Logs Toggle ───
    var logsCollapsed = false;
    $('#logs-header-toggle').addEventListener('click', function() {
      logsCollapsed = !logsCollapsed;
      var body = $('#logs-body');
      var chevron = $('#logs-chevron');
      if (logsCollapsed) {
        body.classList.add('collapsed');
        chevron.innerHTML = '&#9654;';
      } else {
        body.classList.remove('collapsed');
        chevron.innerHTML = '&#9660;';
      }
    });

    // ─── Copy Address ───
    $('#copy-btn').addEventListener('click', function() {
      var addr = $('#wallet-full-addr').dataset.full;
      if (!addr || addr === '--') return;
      navigator.clipboard.writeText(addr).then(function() {
        $('#copy-btn').textContent = '\\u2713 Copied';
        setTimeout(function() { $('#copy-btn').innerHTML = '&#128203; Copy'; }, 1500);
      }).catch(function() {});
    });

    // ─── Fetch & Refresh ───
    function fetchJson(url) {
      return fetch(url).then(function(res) {
        if (!res.ok) return null;
        return res.json();
      }).catch(function() { return null; });
    }

    function refreshAll() {
      Promise.all([
        fetchJson('/api/status'),
        fetchJson('/api/pnl'),
        fetchJson('/api/orders'),
        fetchJson('/api/fills'),
        fetchJson('/api/logs')
      ]).then(function(results) {
        var status = results[0];
        var pnl = results[1];
        var orders = results[2];
        var fills = results[3];
        var logs = results[4];

        // Update header wallet
        if (status) {
          var addr = status.activePoolAddress || '5QZzfEfPeFJfuDwki3xBEkNy3Qhy2yjEcfuHcaDgHTWs';
          $('#wallet-full-addr').textContent = truncAddr(addr);
          $('#wallet-full-addr').dataset.full = addr;
          $('#header-addr').textContent = truncAddr(addr);

          // Live indicator
          var mode = status.mode || 'unknown';
          var indicator = $('#live-indicator');
          var liveText = $('#live-text');
          if (mode === 'healthy') {
            indicator.style.background = 'var(--green-bg)';
            indicator.style.color = 'var(--green)';
            liveText.textContent = 'LIVE';
          } else {
            indicator.style.background = 'var(--yellow-bg)';
            indicator.style.color = 'var(--yellow)';
            liveText.textContent = mode.toUpperCase();
          }
        } else {
          // Use mock
          $('#wallet-full-addr').textContent = truncAddr('5QZzfEfPeFJfuDwki3xBEkNy3Qhy2yjEcfuHcaDgHTWs');
          $('#wallet-full-addr').dataset.full = '5QZzfEfPeFJfuDwki3xBEkNy3Qhy2yjEcfuHcaDgHTWs';
          $('#header-addr').textContent = 'ccQA1o...6ri6';
        }

        // Stats
        var hasRealPnl = pnl && (pnl.totalPnl !== 0 || pnl.todayPnl !== 0);
        if (hasRealPnl) {
          renderStats({
            totalNetWorth: (status && typeof status.walletSol === 'number') ? status.walletSol : MOCK_STATS.totalNetWorth,
            totalClosed: orders ? orders.length : 0,
            winRate: 0,
            avgInvested: 0,
            feeEarned: 0,
            totalProfit: pnl.totalPnl || 0,
            avgMonthlyProfit: pnl.monthPnl || 0,
            expectedValue: 0
          });
          renderChart(pnl.dailyPnl || []);
        } else {
          renderStats(null);
          renderChart(null);
        }

        // Positions
        renderOpenPositions(null); // Always use mock for demo
        renderHistorical(null);

        // Logs
        if (logs && logs.length > 0) {
          renderLogs(logs);
        } else {
          renderLogs(null);
        }

        // Timestamp
        $('#last-update').textContent = 'a few seconds ago';
      });
    }

    // ─── Init ───
    renderStats(null);
    renderChart(null);
    renderOpenPositions(null);
    renderHistorical(null);
    renderLogs(null);

    refreshAll();
    setInterval(refreshAll, 5000);
  </script>
</body>
</html>`;
}

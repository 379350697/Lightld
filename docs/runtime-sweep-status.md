# Runtime Sweep Status

## 已完成并已推送到 `main`

### 1. 开仓重试确认窗口
- Commit: `cf51659`
- 内容:
  - `open_pending` 不再在 5 秒内过早判失败
  - 优先等待 `pendingSubmission.timeoutAt`
  - 如果没有 timeoutAt，至少给 60 秒 reconciliation 窗口
- 作用:
  - 减少重复 `add-lp` attempt
  - 给链上/account-state 真实仓位出现留时间

### 2. 未来 open order identity 保留
- Commit: `245c372`
- 内容:
  - runtime state 保留最新 open order 的 idempotency identity
- 作用:
  - 为后续 `attempt -> chainPositionAddress` 绑定提供锚点

### 3. LP 估值换算修复
- Commit: `d0e5880`
- 内容:
  - 修正 `src/execution/solana/meteora-dlmm-client.ts` 中 token/SOL 价值换算方向
- 作用:
  - 修复近期 `lpCurrentValueSol` 接近 2x entry、误触发 `lp-take-profit` 的核心估值问题

### 4. withdraw 后 residual token sweep
- Commit: `6407508`
- 内容:
  - `withdraw-lp` 确认后，不只卖本次 `intent.tokenMint`
  - 增加多轮钱包 residual token sweep fallback
- 作用:
  - 尽量把退出后残留 token 转回 SOL

### 5. residual token 小额过滤
- Commit: `8acc49c`
- 内容:
  - residual token 卖出前先 quote
  - 低于 `0.1 SOL` 的残留跳过，不 sweep
- 作用:
  - 避免为很小尾仓频繁打 RPC / quote / 交易

---

## 已写但未提交/未推送

### A. residual token sweep cooldown store 底座
- 文件: `src/runtime/residual-token-sweep-store.ts`
- 当前状态:
  - 文件已创建
  - 提供按 mint 记录 `lastAttemptAt` / `cooldownUntil` / `updatedAt` 的持久化 store
- 作用:
  - 为常驻余额巡检式 sweep 提供 mint 级 cooldown state
- 原因未推送:
  - 该 store 还没有真正接入 runtime 周期代码
  - 单独推送会留下未接线的死底座

### B. 两份 429 相关文档
- 文件:
  - `docs/rate-limit-resilience-spec.md`
  - `docs/rate-limit-resilience-implementation-plan.md`
- 当前状态:
  - 文档已在本地存在
- 原因未推送:
  - 当前本地状态里是未跟踪文件
  - 需要确认是否和之前远端对应版本一致，避免重复/混乱提交

---

## 明确未写的关键代码

### 常驻余额巡检式 sweep 的关键接线代码
- 目标:
  - 不依赖平仓触发
  - 在 runtime 周期里定期查询 `walletTokens`
  - 对非 SOL 且估值 `>= 0.1 SOL` 的 token 触发 maintenance sell
  - 带全局巡检间隔 + mint cooldown，避免限流
- 当前状态:
  - **未写**
- 缺的核心内容:
  1. 在 `live-daemon` 中补一条独立于主 strategy 的 maintenance execution path
  2. 复用 signer / broadcaster 发出 maintenance sell intent
  3. 成功/失败后更新 residual token cooldown state
  4. 加全局巡检间隔，避免每 tick 触发

---

## 本地还有的其他改动（非本轮新增）
- `src/history/closed-position-snapshot-sync.ts`
- `src/journals/jsonl-writer.ts`
- 这些文件本地有改动，但不属于这次“估值 + residual sweep”主线交付，不建议混进本次整理提交。

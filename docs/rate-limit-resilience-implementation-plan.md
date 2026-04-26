# Lightld 限流韧性方案实施计划

基于：`docs/rate-limit-resilience-spec.md`

## 成功标准

实施完成后，应满足：

1. 同一 `tokenMint/poolAddress` 在 rate-limit / fetch-failed 后不会继续高频 open 重试。
2. 单次局部 open-path `fetch failed` 不再直接导致 runtime 进入 `circuit_open`。
3. execution 对 429 endpoint 的冷却更保守，连续命中同 host 的概率下降。
4. runtime 恢复后仍可继续 healthy 主循环。

---

## Task 1, 画清现有失败升级路径

### 目标

确认从 execution `fetch failed` 到 runtime `circuit_open` 的精确调用链和条件分支，避免盲改。

### 改什么

- 阅读并标注：
  - `src/runtime/live-daemon.ts`
  - `src/runtime/live-cycle.ts`
  - runtime mode / policy 相关 helper
- 识别：
  - 哪个 reason 会触发 `circuit_open`
  - 哪些字段可用于区分 open-path 局部失败 vs 全局失败

### 不改什么

- 本任务不改行为逻辑
- 只做代码路径确认

### 验证

- 写出简短注释式结论或实现备注
- 能明确回答：
  - `fetch failed` 在哪里升级为 `circuit_open`
  - 是否能拿到 `action/tokenMint/poolAddress`

---

## Task 2, 增加 target-scoped open cooldown 数据结构

### 目标

为 `tokenMint + poolAddress` 建立轻量局部 cooldown 记录。

### 改什么

优先在 runtime 现有 state/store 框架内增加最小状态：

- key: `poolAddress + tokenMint`
- fields:
  - `cooldownUntil`
  - `reason`
  - `lastFailedAt`

建议落点：
- 复用现有 runtime state 文件体系
- 或增加一个极小独立 state 文件（仅在确实更简单时）

### 不改什么

- 不做通用任务调度器
- 不做多层缓存抽象

### 验证

- 单测或最小读写验证：能写入、读取、过期判断

---

## Task 3, 在 open 决策前拦截 cooldown 目标

### 目标

如果某个目标仍在 cooldown，就直接 `hold`，阻止新的 open 尝试。

### 改什么

在 open candidate / order submit 前加入检查：

- 若当前目标在 cooldown：
  - 阻止 `add-lp` / `deploy`
  - 输出 `hold`
  - reason 统一明确，例如：
    - `open-rate-limit-cooldown`

### 不改什么

- 不阻止 LP exit / withdraw / fee claim
- 不阻止其他 token/pool 的观察或决策

### 验证

- 构造 cooldown 状态后跑一轮 cycle
- 确认：
  - 不再生成新的 open order
  - 输出为 `hold`
  - reason 可见

---

## Task 4, 在局部 fetch-failed 时写入 cooldown

### 目标

当 open-path 失败属于 rate-limit/fetch-failed 类型时，自动对目标写 cooldown。

### 改什么

在 open 广播失败处理路径中识别：

- `fetch failed`
- `rate-limited`
- endpoint cooldown / 等价上游限流语义

然后：
- 写入 target cooldown
- 记录 decision / incident 上下文

### 不改什么

- 不把所有失败都写 cooldown
- 仅限可证明是临时依赖限流类失败

### 验证

- 模拟此类失败
- 确认 state 中出现 cooldown
- 下一轮 cycle 不再继续冲同目标 open

---

## Task 5, 调整 runtime 对 fetch-failed 的模式升级规则

### 目标

让局部 open-path 失败不再直接变成 whole-runtime `circuit_open`。

### 改什么

在 runtime mode 计算逻辑里分流：

- 若失败是 open-path rate-limit/fetch-failed
  - 保持 `healthy`（或等价非熔断状态）
  - 由 target cooldown 处理
- 若失败是全局依赖故障
  - 仍可升级 `circuit_open`

### 不改什么

- 不移除 `circuit_open` 机制
- 不放松对真正全局故障的保护

### 验证

- 注入局部失败：runtime 不进入 `circuit_open`
- 注入全局失败：runtime 仍能进入 `circuit_open`

---

## Task 6, 增强 execution 侧 429 endpoint cooldown

### 目标

减少同 host 连续 429 与短时间重复命中。

### 改什么

在现有 endpoint registry / cooldown 逻辑上做最小增强：

- 429 后更长 cooldown
- 对连续 429 可做简单递增 cooldown
- endpoint 选择时优先跳过刚 rate-limited 的 host

### 不改什么

- 不做新的 endpoint 打分系统
- 不做复杂策略路由器

### 验证

- 单测或日志验证：
  - 同 host 连续 429 次数下降
  - cooldown 时间符合预期

---

## Task 7, 统一日志与可观测性

### 目标

让后续判断是否根除更直接，不靠猜。

### 改什么

为以下事件增加统一 reason / log：

- 写入 target cooldown
- cooldown 命中而跳过 open
- 局部 fetch-failed 被降级处理
- execution endpoint 因 429 进入增强 cooldown

### 不改什么

- 不搞大规模日志框架重构
- 仅补必要字段

### 验证

- 日志里能串起完整链路：
  - 429 → endpoint cooldown → target cooldown → open skipped

---

## Task 8, 回归验证

### 目标

确认方案满足 spec，不引入明显副作用。

### 验证清单

1. build 通过
2. 服务可正常启动
3. 复现或半人工触发 rate-limit/fetch-failed 后：
   - 同目标不再高频 open
   - runtime 不直接 `circuit_open`
4. execution 日志里 endpoint cooldown 行为更保守
5. runtime 恢复后仍能保持 healthy 主循环

---

## 推荐实施顺序

1. Task 1
2. Task 2
3. Task 3
4. Task 4
5. Task 5
6. Task 6
7. Task 7
8. Task 8

这个顺序确保先切断重试风暴，再调整模式升级，最后补 execution 防线与验证。

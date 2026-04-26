# Lightld 限流韧性与轻量恢复方案（Spec）

## 目标

在不引入重型队列、复杂状态机重写、额外存储系统的前提下，解决当前由 RPC / DLMM 429 限流引发的三类问题：

1. 429 期间，同一 `tokenMint/poolAddress` 的 open 尝试过于密集，形成重试风暴。
2. execution 侧虽然已有 endpoint cooldown，但 runtime 仍持续发起 open，导致限流恢复前不断重复失败。
3. 一次可恢复的 `fetch failed` 过早把 runtime 打进 `circuit_open`，放大了局部依赖失败的影响范围。

本方案必须保持轻量化，优先通过小范围、可验证、可回滚的改动解决根因。

---

## 现状与证据

### 日志证据

近期生产日志显示明确链路：

- execution 侧多次出现 `429 Too Many Requests`
- 随后出现：
  - `endpoint cooling down kind=dlmm host=solana-mainnet.g.alchemy.com reason=rate-limited`
- 紧接着 broadcast 失败：
  - `result: "failed"`
  - `reason: "fetch failed"`
- runtime 进入：
  - `mode: "circuit_open"`
  - `circuitReason: "fetch failed"`

同时，orders 中可见短时间内同一池/同一 mint 连续产生多个新的 `add-lp` 尝试，说明失败后的 open 重试在业务层缺少局部抑制。

### 根因判断

这不是单点问题，而是三段链路组合后的放大效应：

1. **业务层局部重试缺少冷却**
   - 同一 `tokenMint/poolAddress` 在 open 失败后很快再次触发 open。

2. **execution 侧 endpoint cooldown 只保护 endpoint，不保护 runtime 决策层**
   - endpoint 已知被限流，但 runtime 仍在持续提供新的 open 请求。

3. **runtime 模式升级粒度过粗**
   - 将单次可恢复的 fetch/rate-limit 类失败提升为 whole-runtime `circuit_open`。

---

## 设计原则

1. **局部失败局部隔离**
   - 同一池、同一 mint 的限流失败，不应立即升级为全局 runtime 熔断。

2. **优先削峰，不优先补偿**
   - 先阻止重复 open 风暴，再谈更复杂恢复。

3. **沿用现有状态文件与 runtime 结构**
   - 不新增数据库，不引入新的持久化系统。

4. **429 / fetch-failed 视为“临时依赖退化”**
   - 默认先做 temporary block / hold-only，而不是直接 whole-runtime circuit。

5. **execution 与 runtime 两端都要收口，但都保持最小改动**
   - runtime 负责“别继续冲”
   - execution 负责“同类 endpoint 别马上再用”

---

## 方案总览（采用方案 C 的最小版）

### 方案内容

1. **runtime open 层增加局部冷却**
   - 对 `add-lp` / `deploy` 的 `fetch failed`、`rate-limited`、相关 endpoint cooldown 失败，记录 `tokenMint + poolAddress` 的短时冷却。
   - 冷却期间该目标只允许 `hold`，不再尝试新的 open。

2. **runtime 模式分级更保守**
   - 对 open-path 的局部依赖失败，不直接升 whole-runtime `circuit_open`。
   - 优先进入“healthy + blocked-open-for-target”或等价的局部 hold 行为。

3. **execution endpoint cooldown 略增强**
   - 对 429 endpoint 增加更长冷却时间。
   - 读链 / dlmm endpoint 选择时，尽量避开刚刚 rate-limited 的 host。

---

## 详细设计

## 1. Runtime 侧局部 open cooldown

### 新行为

当 open 类动作出现以下任一失败语义时：

- `fetch failed`
- 明确 `rate-limited`
- endpoint cooldown / temporarily unavailable 且可归因为上游限流

runtime 记录一个 **target-scoped cooldown**：

- key: `poolAddress + tokenMint`
- duration: 初始建议 `2-5 分钟`

### cooldown 期间行为

- 针对同一 key：
  - 不再生成新的 `add-lp` / `deploy`
  - 输出 `hold`
  - 在 decision / incident 中标明是 `open-rate-limit-cooldown`
- 不影响：
  - 其他 token/pool 的观察
  - 已持仓 LP 的退出判断
  - runtime 整体健康运行

### 为什么这样改有理有据

日志证明问题是“同一目标短时间连续 add-lp 失败”。
所以最小有效抑制点就是 open 目标本身，而不是全局暂停整个 runtime。

---

## 2. Runtime 模式升级规则调整

### 当前问题

`fetch failed` 会进入 `circuit_open`，粒度过粗。

### 新规则

将 `fetch failed` 分为两类：

#### A. 局部 open-path 可恢复失败
满足下面条件之一：
- 发生在 open 动作（`add-lp` / `deploy`）
- execution 返回伴随 rate-limit / endpoint cooldown 语义
- 没有证据表明 account-state、state store、mirror、核心逻辑本身损坏

处理方式：
- 不升级 whole-runtime `circuit_open`
- 仅对当前目标进入 cooldown
- runtime 保持 `healthy` 或等价可继续运行状态

#### B. 全局依赖失败
例如：
- account-state 核心读失败持续多周期
- 多类关键依赖共同失败
- 不只是某个 open 目标的广播构建失败，而是 runtime 无法完成正常主循环

处理方式：
- 仍允许进入 `circuit_open`

### 为什么这样改有理有据

open 广播阶段的 rate-limit 失败，本质是“某次动作构建/发送失败”，不是“runtime 整体不可用”。
将其局部化，符合故障边界，也能避免单次外部限流放大全局影响。

---

## 3. Execution 侧 429 endpoint cooldown 增强

### 新行为

对出现 429 的 endpoint：

- 增加 cooldown 时长
- 对连续 429 的同 host，采用更保守冷却
- 在 endpoint 选择时，优先使用未被冷却的其他 endpoint

### 保持轻量化的约束

- 不引入新 registry 子系统
- 不做复杂 endpoint 打分框架
- 只在现有 cooldown / endpoint 轮换逻辑上增强

### 为什么这样改有理有据

已有日志证明：
- endpoint 已识别 rate-limited
- 但恢复后短时间再次触发 429

这说明现有 cooldown 存在但力度不足，增强现有机制即可，不需要重写架构。

---

## 不改什么

以下内容明确不属于本次方案范围：

1. 不重写 execution 状态机
2. 不引入分布式任务队列
3. 不新增数据库或复杂持久化缓存
4. 不改选币 / 策略核心规则
5. 不把所有外部失败都抽象成一个通用调度框架
6. 不做“自适应 AI 路由”这类过度设计

---

## 建议落点

## Runtime

优先查看并改动这些区域：

- `src/runtime/live-daemon.ts`
  - `fetch failed` 与 `circuit_open` 相关分级逻辑
- `src/runtime/live-cycle.ts`
  - open 动作失败后的行为收口点
- 可能需要新增一个极小 helper/state 文件
  - 用于记录 target cooldown
  - 如果现有 state 结构里能容纳，则优先复用

## Execution

优先查看并改动这些区域：

- endpoint cooldown / registry 相关逻辑
- build/broadcast 失败上报路径
- 429 识别与 cooldown 时间计算

---

## 验证标准

### 功能验证

1. 人工复现或模拟 429 / fetch-failed 后：
   - 同一 `tokenMint/poolAddress` 不再每几十秒连续 open

2. runtime 在单次局部限流失败后：
   - 不再直接进入 `circuit_open`
   - 保持 `healthy` + target cooldown/hold 行为

3. execution 日志中：
   - 同 host 连续 429 频率下降
   - endpoint cooldown 更有效

4. 限流恢复后：
   - runtime 无需人工干预即可继续正常主循环
   - 不阻塞其他非失败目标

### 非功能验证

1. 不增加新的重型状态机
2. 不引入新的外部依赖
3. 变更文件数保持小而集中
4. 回滚路径简单清晰

---

## 风险与折中

### 风险 1
局部 cooldown 太短，仍可能形成风暴。

**处理**：
先用保守值（如 5 分钟），后续按日志再缩。

### 风险 2
局部 cooldown 太长，会错过重新开仓机会。

**处理**：
先限定只作用于明确 rate-limit/fetch-failed 类型失败，不泛化到所有 open 失败。

### 风险 3
execution 侧冷却增强不足以覆盖所有限流模式。

**处理**：
runtime 侧局部削峰必须先落地，execution 增强作为第二道防线。

---

## 最终建议

按以下顺序实施：

1. runtime target-scoped open cooldown
2. runtime `fetch failed` 分级，避免局部失败直接 `circuit_open`
3. execution 429 cooldown 增强
4. 回归验证日志、runtime-state、order/incident 输出

这个顺序最轻、最稳，也最符合“有理有据、轻量优先、直击根因”的要求。

# Lightld 执行 / 历史模型重构方案

## 目标

把 Lightld 从“靠 order / fill / decision / incident 互相补洞”的状态，收敛成明确的数据边界：

- `order` 表示意图（intent）
- `fill` 表示已确认事实（confirmed fact）
- `incident` 表示异常和失败上下文
- `decision` 表示策略解释，不承担成交事实职责

后续所有修复都应以此文档为约束，避免继续做局部补丁把语义越修越乱。

---

## 1. 现状错误边界

### 1.1 fill 被污染成“提交占位 + 成交事实”混合物

此前 runtime 会在 submission 未确认时也写入 `live-fills`：

- `status: submitted`
- `filledSol: 0`
- `amount: 0`

这会让 downstream 无法区分：

- 尚未确认
- 真正失败
- 已确认但数值未知
- 真正已成交

这四者语义完全不同，不允许继续混在一个 `fill` 流里。

### 1.2 catchup / mirror 把 intent 数值冒充 fact 数值

此前 catchup 会从：

- `filledSol`
- `amount`
- `requestedPositionSol`

依次兜底。

这会把“请求下多少”洗成“实际成交多少”，直接污染：

- SQLite fills
- dashboard history
- cashflow / pnl

### 1.3 dashboard history 过度承担对账修复职责

当前 history 构建是：

- raw fills
- raw orders
- decision fallback
- chain snapshots

现场拼装。

这会导致 UI 层被迫做交易闭环推理，产生：

- `missing-local`
- `missing-chain`
- 假闭环
- 假异常

UI 不该承担交易事实重建。

### 1.4 系统缺少统一 execution lifecycle 主键

当前系统依赖多套不稳定键去猜同一笔交易：

- `submissionId`
- `idempotencyKey`
- `openIntentId`
- `positionId`
- `chainPositionAddress`
- `tokenMint`
- `recordedAt`

这些字段在不同阶段并不总是齐全，因此“匹配”本质上是猜，不是闭环。

### 1.5 `broadcast-outcome-unknown` 没有进入明确终态

当前 unknown broadcast 会留下：

- pending-submission
- incident
- 某些情况下没有 fill
- 某些情况下历史层还会继续脑补

这说明系统没有明确的执行状态机收敛机制。

---

## 2. 正确的数据模型

## 2.1 Order = intent

`order` 只表达：

- 我尝试发起了一次什么操作
- 我打算下多少
- 当前广播 / 确认状态是什么

`order` 允许处于：

- pending
- submitted
- confirmed
- failed
- unknown

但它不表示成交事实。

### order 必须承载

- `idempotencyKey`
- `submissionId`（如已知）
- `openIntentId`
- `positionId`
- `chainPositionAddress`
- `tokenMint`
- `action`
- `requestedPositionSol`
- `broadcastStatus`
- `confirmationStatus`
- `finality`
- `createdAt`
- `updatedAt`

---

## 2.2 Fill = confirmed fact

`fill` 只在以下条件成立时允许写入：

- execution 已确认成功
- 或系统已通过后续 reconciliation 明确恢复出真实成交事实

### fill 禁止承载

- pending 占位
- submitted 占位
- requestedPositionSol 兜底值
- 不完整但冒充 confirmed 的数据

### fill 必须表达

- 哪一笔执行最终真的成交了
- 成交方向
- 真实金额（哪怕是当前能拿到的最保守 confirmed 值）
- 成交记录时间

如果事实未知，就不要写 fill。

---

## 2.3 Incident = 异常上下文

`incident` 负责表达：

- broadcast unknown
- recovery required
- timeout
- failed
- degraded / circuit transitions

incident 不承担成交或历史闭环职责。

---

## 2.4 Decision = 策略解释

`decision` 负责表达：

- 为什么做这个动作
- 策略估值 / PnL / holdTime / depletion 等解释字段

decision 不是事实成交来源。

它可以做解释 fallback，但不能替代 fill。

---

## 2.5 长期目标：统一 lifecycle 视图

理想状态下应引入统一的 execution lifecycle 记录，最少需要逻辑上具备：

- 一个稳定主键（推荐 `operationId`）
- 意图阶段
- 广播阶段
- 确认阶段
- 成交事实阶段
- 异常 / reconciliation 阶段

当前阶段可先不一次性引入新大表，但后续所有改动应向这个方向收敛。

---

## 3. 各层职责

## 3.1 runtime / live-cycle

职责：

- 生成 order
- 维护 pending submission
- 只在 confirmed success 时生成 fill
- 生成 decision / incident

禁止：

- 用 unresolved submission 生成 fill
- 用 requestedPositionSol 冒充真实成交值

---

## 3.2 journal

职责：

- 原样记录上层已经明确语义的事件

禁止：

- 在 journal 层修语义
- 把 pending 数据写成 fact 类型

---

## 3.3 mirror / catchup / sqlite

职责：

- 保持 journal 语义进入 SQLite
- 不扩大、不推测、不脑补

禁止：

- `filledSol <- requestedPositionSol`
- `amount <- requestedPositionSol`
- 把 unknown / pending 洗成 confirmed fact

SQLite 应成为“稳定投影”，不是“二次猜测器”。

---

## 3.4 dashboard

职责：

- 展示已经分层好的事实 / unresolved / error
- 不承担主要交易闭环重建工作

禁止：

- 用 raw decision 直接伪造 fill
- 把匹配猜测包装成确定历史
- 把事实层和推断层混成一个状态模型

---

## 4. 最小可落地改造路径

## Phase 1，立刻执行，拉正语义边界

### 已执行 / 必须保持

1. `live-cycle.ts`
   - unresolved submission 不再写 fill
2. `mirror-catchup.ts`
   - 不再从 `requestedPositionSol` 推导 fill 数值

### 验证标准

- 新产生的 pending / unknown submission 不再出现在 fills 中
- fills 只包含 confirmed fact
- build 必须通过

---

## Phase 2，收敛 dashboard 历史边界

### 要做

1. history 只把 fills 视为 confirmed fact
2. order fallback 明确归类为：
   - unresolved
   - missing-chain
   - failed
3. decision fallback 只作为解释补充，不再充当成交事实
4. 对 `missing-local` 做更严格约束，避免因 fill 字段残缺导致误判

### 验证标准

- 最新 pending / unknown 不再被误显示成 fake fill lifecycle
- 假 `missing-local` 数量下降
- 历史页状态命名与真实链路一致

---

## Phase 3，增加 execution lifecycle 收敛能力

### 要做

1. 为 order / fill / incident 建立统一 lifecycle 主键映射
2. unknown broadcast 必须进入明确状态机：
   - `unknown_pending_reconciliation`
   - `confirmed`
   - `failed`
   - `manual-review`
3. recovery 必须以“收敛到终态”为目标，而不是只留下 pending 文件

### 验证标准

- `broadcast-outcome-unknown` 不再长期悬空
- pending-submission-timeout 后能进入明确终态
- dashboard 不再需要靠多重猜测复原交易事实

---

## 5. 明确禁止事项

后续修复中，禁止再做以下事情：

1. 为了让 dashboard 看起来有数据，把 pending submission 写成 fill
2. 为了补 PnL，把 `requestedPositionSol` 当成交额写入 fill / sqlite
3. 在 dashboard 层继续叠加“nearest match / fuzzy match / decision pretend fill”这类补丁
4. 把 `missing-local` / `missing-chain` 当成纯 UI 问题修
5. 在没有重新定义语义前，给 fills 增加更多临时状态字段继续混用

---

## 6. 后续实现纪律

后续所有修复必须遵守：

1. 先确认该改动属于哪一层职责
2. 先写明：
   - 改什么
   - 不改什么
   - 如何验证
3. 每次只做最小一刀
4. 如果某个方案需要 dashboard 猜测更多事实，默认说明方向错了

---

## 7. 当前状态说明

截至本文件落地时，Phase 1 的第一批关键改动已开始：

- runtime 不再把 unresolved submission 记为 fill
- mirror catchup 不再把 requestedPositionSol 洗成 fill 数值

后续改动必须严格沿本文件继续推进，不允许回到“为了显示正常，局部补个匹配逻辑”的路径。

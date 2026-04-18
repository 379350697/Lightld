# Sol Pool Distillation × Lightld 自进化系统复核与优化方案

生成时间：2026-04-19  
适用范围：`new-token-v1` 主线，旁路研究与自进化系统  
输入依据：
- `C:\Users\wl\Downloads\analysis_report_sol.md`
- `C:\Users\wl\Downloads\sol_pool_llm_distillation.md`
- 本地代码现状
- 近半年公开一手资料

## 1. 结论先行

当前 `Lightld` 的核心短板，不在“提案、审批、补丁”链路，而在“样本表达力”和“评测强度”。

这意味着下一阶段最值得投入的方向不是继续堆审批层，而是：

1. 把样本从“当前参数能看懂的统计摘要”升级为“接近真实交易问题的机会样本”。
2. 把进化从“观察后给建议”升级为“反事实回放 + 分层评测 + OOS 复核”。
3. 把 LLM 放在研究、归纳、偏好学习、报告压缩的位置，而不是放进 runtime 决策环。

`analysis_report_sol.md` 的总方向是对的，但有两点需要修正：

1. 它低估了你现在已经完成的工程闭环强度。`proposal-engine`、`approval-store`、`patch-draft`、`run-evolution-report` 已经不是概念版，而是可运行的旁路研究流水线。
2. 它高估了“直接上 LLM 研究员”这一步的紧迫性。按当前代码状态，真正的瓶颈仍然是样本和评测，不是模型本身。

## 2. 代码复核结论

### 2.1 已经做得很强的部分

- 安全和过滤主线已经明确分层：
  - [src/ingest/gmgn/token-safety-client.ts](/mnt/d/codex/Lightld/src/ingest/gmgn/token-safety-client.ts)
  - [src/strategy/filtering/hard-gates.ts](/mnt/d/codex/Lightld/src/strategy/filtering/hard-gates.ts)
  - [src/strategy/filtering/dlmm-pool-filter.ts](/mnt/d/codex/Lightld/src/strategy/filtering/dlmm-pool-filter.ts)
- 出场链路已经有明确状态机和参数边界：
  - [src/strategy/engines/new-token-engine.ts](/mnt/d/codex/Lightld/src/strategy/engines/new-token-engine.ts)
- 自进化的旁路闭环已经成立：
  - [src/evolution/filter-analysis.ts](/mnt/d/codex/Lightld/src/evolution/filter-analysis.ts)
  - [src/evolution/outcome-analysis.ts](/mnt/d/codex/Lightld/src/evolution/outcome-analysis.ts)
  - [src/evolution/proposal-engine.ts](/mnt/d/codex/Lightld/src/evolution/proposal-engine.ts)
  - [src/evolution/patch-draft.ts](/mnt/d/codex/Lightld/src/evolution/patch-draft.ts)
  - [src/cli/run-evolution-report.ts](/mnt/d/codex/Lightld/src/cli/run-evolution-report.ts)
- 风险边界也守得住：
  - patch 只碰 allowlist 参数
  - baseline drift 会阻断 patch
  - evidence / coverage / readiness 不够会 fail closed
  - review 已经是 post-approval window，不是混用审批前证据

### 2.2 当前最真实的缺口

#### A. 样本还不够像“池子机会”

[src/evolution/types.ts](/mnt/d/codex/Lightld/src/evolution/types.ts) 里的 `CandidateSampleRecord` 和 `LiveCycleOutcomeRecord` 已经能支撑第一版参数演化，但还不够支撑更强的蒸馏和反事实分析。

现状问题：

- `CandidateSampleRecord` 主要是流动性、持有人、安全分、24h volume、fee/TVL、binStep 这类摘要字段。
- 缺少 `microstructure`、`execution`、`future_path`、`liquidity delta`、`wallet concentration dynamics` 这类直接决定“能不能做”和“能不能出”的信息。
- `filter-analysis` 和 `outcome-analysis` 仍然主要依赖“最新 watchlist 快照 vs 退出点”的轻量比较，而不是结构化 forward path。

#### B. 评测仍偏统计建议，不是严格反事实

[src/evolution/filter-analysis.ts](/mnt/d/codex/Lightld/src/evolution/filter-analysis.ts) 和 [src/evolution/outcome-analysis.ts](/mnt/d/codex/Lightld/src/evolution/outcome-analysis.ts) 当前做的是可靠的一阶分析，但还不是完整反事实。

现状问题：

- 还没有统一的 `counterfactual replay` 层。
- 还没有按 proposal 生成固定的 train/validation/holdout 切片。
- 还没有显式扣除更细的执行成本、成交深度约束和 roundtrip impact。

#### C. 仓位 sizing 仍然过于静态

[src/risk/dynamic-position-sizing.ts](/mnt/d/codex/Lightld/src/risk/dynamic-position-sizing.ts) 现在只有按 TVL 分档。

这在第一版是合理的，但在“池型差异很大”的土狗池场景里明显不够：

- 没有把安全分、微观结构、可执行性、池龄、行为型态纳入 sizing。
- 没有把“预测 alpha”和“卖出可实现性”拆开处理。

#### D. 安全分更多是静态快照，不是动态行为

[src/ingest/gmgn/token-safety-client.ts](/mnt/d/codex/Lightld/src/ingest/gmgn/token-safety-client.ts) 的 120 分体系很实用，但仍以权限和持仓快照为主。

这意味着它更擅长挡显性坏池，不擅长识别：

- deployer 多钱包分散
- wash trading
- 流动性快速撤离前兆
- 持有者增长失真

## 3. 两份文档的最终判断

### 3.1 `sol_pool_llm_distillation.md`

这份文档的核心原则是成立的：

- LLM 做研究员，不做执行器
- 样本单位应该是 `pool-opportunity`
- 训练目标不是预测涨跌，而是筛池、进场、出场、参数优化

这部分建议保留，继续作为顶层原则。

### 3.2 `analysis_report_sol.md`

这份“最终版”里最值得保留的是三件事：

1. 样本必须继续增厚
2. 必须补 `counterfactual` 和 `future_path`
3. 必须把研究和训练建立在 review/approval/evidence 之上

但有两点要下调优先级：

1. “多 Agent 研究员架构”不是下一步第一优先级  
   现在先把样本和评测做强，收益会更高。
2. “尽快做 SFT / DPO / GRPO”也不是下一步第一优先级  
   当前最缺的是高质量标签和稳固的评测切片，不是训练框架本身。

## 4. 近半年一手资料给出的硬约束

以下结论来自最近半年内的一手资料，我只抽取和当前系统强相关的部分。

### 4.1 先把强 teacher 输出蒸馏成小模型，再谈偏好

OpenAI 当前文档对蒸馏路径写得很清楚：先把大模型提示词打磨到通过 eval，再收集高质量输出，用这些输出给小模型做 SFT，之后再继续优化。[OpenAI SFT/Distillation Guide](https://developers.openai.com/api/docs/guides/supervised-fine-tuning#distilling-from-a-larger-model)

对本项目的含义：

- 第一阶段不要直接训练“会思考”的模型。
- 先训练“会稳定输出结构化研究结论和 JSON proposal”的模型。
- teacher 应该是你人工 review 过、且被 validator 接受的 proposal/report，不是原始自由文本。

### 4.2 DPO 适合接在 SFT 之后，而不是替代 SFT

OpenAI 当前 DPO 文档明确建议：先用 preferred responses 做 SFT，再用 preference pairs 做 DPO。[OpenAI DPO Guide](https://developers.openai.com/api/docs/guides/direct-preference-optimization)

对本项目的含义：

- 你的 `approval-store` 和 `outcome-ledger` 是未来的 preference 数据源。
- 但它们更适合做第二阶段 DPO，而不是第一阶段基础训练。
- 第一阶段应先学会稳定格式、术语和可执行提案风格。

### 4.3 RFT 的前提是 grader 要够强，而且要能看分布切片

OpenAI 当前 RFT 文档强调：训练过程中要持续看 grader reward、validation reward，并把训练过程接进 evals，检查模型在哪些 slice 上表现差。[OpenAI RFT Guide](https://developers.openai.com/api/docs/guides/reinforcement-fine-tuning)

对本项目的含义：

- 没有可靠 grader 之前，不要急着做 RFT。
- 本项目的 grader 不能只看“proposal 看起来合理”，必须看：
  - OOS delta
  - slippage-adjusted delta
  - 不同池型切片
  - 不同时间窗切片

### 4.4 自动研究员是可行的，但关键瓶颈会转移到评测

Anthropic 在 2026-04-14 发布的 Automated Alignment Researchers 里展示了：多实例研究员在有明确目标分数时，可以快速提出并试验很多方案，但他们也明确指出瓶颈会转向 evaluation，并且人类检查仍然必要。[Anthropic AAR](https://www.anthropic.com/research/automated-alignment-researchers?curius=1184)

对本项目的含义：

- 你后续完全可以让 LLM 做研究员。
- 但前提不是“先上更多 agent”，而是“先把 objective score 和 holdout eval 做硬”。
- 研究员最容易作弊的地方，也会是你系统最容易产生伪改进的地方。

### 4.5 自动行为评测的价值，在于快、可扩展、可持续更新

Anthropic 2025-12-19 发布 Bloom，核心价值是：针对特定行为自动生成大量评测场景，而且迭代速度远快于手工评测。[Anthropic Bloom](https://www.anthropic.com/research/bloom)

对本项目的含义：

- 你不需要照搬 Bloom。
- 但应该引入 Bloom 风格的“行为评测套件生成”思想：
  - 针对 `误放 / 错杀 / 过早止盈 / 过晚止损 / 低可执行性假盈利`
  - 自动生成统一评测切片
  - 持续跟踪同一类坏行为是否下降

### 4.6 Agent 能力越强，越要把人放在控制位

Anthropic 在 2026-04-09 的 Trustworthy Agents 里强调了五个原则，其中最关键的是 humans in control、transparency、secure interactions。[Anthropic Trustworthy Agents](https://www.anthropic.com/research/trustworthy-agents)

对本项目的含义：

- 不要让 LLM 获得 live config 写权限
- 不要让 LLM 直接参与下单条件判断
- 保持“研究建议 -> validator -> approval -> patch draft -> 人工应用”链路

### 4.7 自进化会受 solver-verifier gap 限制

ICLR 2026 的 `solver-verifier gap` 工作指出，自进化效果取决于 solver 和 verifier 之间的能力差；如果 verifier 太弱，自进化上限会很快出现。[ICLR 2026 Poster](https://iclr.cc/virtual/2026/poster/10010371)

对本项目的含义：

- 这个系统的上限，不由 proposal engine 决定，而由 verifier 决定。
- 你现在的 verifier 还偏“统计建议器”，还不是强 verifier。
- 所以下一阶段最该投资的是 verifier，而不是让 proposer 更花哨。

### 4.8 评测必须刻意设计成“难被模型投机”

Anthropic 在 2026-01 的 AI-resistant evaluations 里强调：现实世界式评测容易被模型记住或投机，后续需要更偏“新问题、长时间、难捷径”的评测设计。[Anthropic AI-resistant Evaluations](https://www.anthropic.com/engineering/AI-resistant-technical-evaluations)

对本项目的含义：

- 你的 evolution eval 不应只复用同一套简单统计阈值。
- 要引入：
  - 时间滚动切片
  - 池型 holdout
  - 执行成本扰动
  - proposal 生效后延迟观察窗

## 5. 推荐优化方案

## 5.1 P0：先补“样本工厂”，不要先补模型

### 目标

把现在的 `candidate scan + watchlist + outcome` 三段式证据，升级成统一的 `pool_decision_sample` 派生层，但不破坏现有存储。

### 推荐做法

新增一个派生样本层，而不是推翻现有 store：

- `src/evolution/pool-decision-sample.ts`
- `src/evolution/pool-decision-sample-builder.ts`
- `src/evolution/pool-decision-sample-store.ts`

样本来源继续复用：

- candidate scans
- watchlist snapshots
- live-cycle outcomes
- sqlite mirror

新增字段至少补这 5 组：

1. `liquidity_path`
   - `liquidityUsd`
   - `liquidityDelta1m`
   - `liquidityDelta5m`
   - `lpRemoveEvents`
2. `microstructure`
   - `buyers1m`
   - `sellers1m`
   - `buySellNotionalRatio1m`
   - `uniqueBuyers5m`
   - `largeBuyCount1m`
   - `topWalletTradeShare`
3. `execution`
   - `buyImpactBpsAt0_5Sol`
   - `sellImpactBpsAt0_5Sol`
   - `roundtripImpactBpsAt1Sol`
   - `maxFillableSol`
4. `future_path`
   - `ret30sFwd`
   - `ret2mFwd`
   - `ret5mFwd`
   - `ret15mFwd`
   - `mfe`
   - `mae`
   - `bestHoldSec`
5. `counterfactual_labels`
   - `ifSelectedPnl`
   - `ifRelaxMinLiquidityPnl`
   - `ifTighterStopLossPnl`
   - `ifLongerTakeProfitPnl`

### 为什么这是第一优先

因为没有这个层，后续无论是：

- archetype 分类
- LLM 报告
- SFT
- DPO
- RFT

都会建立在过薄的证据上。

## 5.2 P1：补强 verifier，不要先补更多 proposer

### 目标

把当前“统计 finding -> proposal”升级成“反事实评测 -> proposal -> OOS review”。

### 推荐做法

新增：

- `src/evolution/counterfactual-analyzer.ts`
- `src/evolution/proposal-validator.ts`
- `src/evolution/eval-slices.ts`

核心能力：

1. 单参数反事实回放
   - `minLiquidityUsd`
   - `minBinStep`
   - `minVolume24hUsd`
   - `minFeeTvlRatio24h`
   - `takeProfitPct`
   - `stopLossPct`
   - `lp takeProfit`
   - `lp stopLoss`
   - `solDepletionExitBins`
2. 分层 OOS
   - 时间滚动窗
   - 池龄分层
   - 低流动性 vs 高流动性
   - 高安全分 vs 低安全分
3. 执行成本扣除
   - roundtrip impact
   - sell impact 上限
   - max fillable depth
4. 结果格式
   - `improvementMedian`
   - `improvementP25/P75`
   - `degradationTail`
   - `passBySlice`

### 设计原则

- proposer 可以弱一点，verifier 必须强
- `proposal-engine` 不必重写，优先给它喂更强的验证结果

## 5.3 P2：把出场信号从三层补到四层

当前 [src/strategy/engines/new-token-engine.ts](/mnt/d/codex/Lightld/src/strategy/engines/new-token-engine.ts) 已经有：

- 价格层
- 时间层
- 部分深度层

下一步要补的是“行为层”和更完整的“深度层”。

### 新增候选信号

1. 深度退化
   - `sellImpactBps` 持续恶化
   - `maxFillableSol` 快速下降
2. 行为耗尽
   - `uniqueBuyers` 增长停滞
   - `largeBuyCount` 消失
   - `buySellNotionalRatio` 转弱
3. 流动性异常
   - `liquidityDelta` 连续转负
   - `lp remove event` 突增

### 落地方式

不要直接进主决策。先做：

- 旁路记录
- evolution report finding
- 达到稳定性后再考虑进入 advisory exits

## 5.4 P3：做条件化 sizing，而不是继续只看 TVL

当前 sizing 文件：

- [src/risk/dynamic-position-sizing.ts](/mnt/d/codex/Lightld/src/risk/dynamic-position-sizing.ts)

建议升级为打分式上限，而不是固定分档：

- base cap from TVL
- safety discount
- execution discount
- archetype discount
- regime bonus/discount

一个保守的第一版公式就够：

`position_cap = tvl_cap * safety_mult * execution_mult * regime_mult`

其中：

- `safety_mult` 取决于安全分和集中度
- `execution_mult` 取决于 sell impact / roundtrip impact
- `regime_mult` 取决于 archetype 和短期 follow-through

注意：

- 先只做 “cap tighter”，不要做 “cap larger than today”
- 先让它做保守收缩器，不要让它做激进放大器

## 5.5 P4：引入 archetype，但先做规则标签，不急着上模型分类器

`analysis_report_sol.md` 里提的 `pool archetype` 是值得做的，但第一版不需要 ML classifier。

先做规则标签即可：

- `young_pool_momentum`
- `thin_liquidity_spike`
- `whale_led_push`
- `retail_fomo_then_dump`
- `slow_grind_then_break`

实现建议：

- `src/evolution/pool-archetype.ts`
- 输出标签和置信度
- 先用于：
  - report 分组
  - verifier slice
  - sizing 折扣

不要一开始就让 archetype 直接改 runtime 决策。

## 5.6 P5：LLM 先做“压缩器”和“研究助理”，不要先做“裁判”

### 第一阶段

让 LLM 只做三件事：

1. 把 evidence snapshot + counterfactual result 压成结构化日报
2. 给出 JSON 格式 research proposal
3. 产出人能看懂的风险解释

### 不要做的事

- 不直接输出 patch
- 不直接决定 approve/reject
- 不直接进 runtime

### 推荐接口

- `src/evolution/llm-researcher.ts`
- 输入：固定 schema evidence bundle
- 输出：固定 JSON proposal
- 下游：`proposal-validator.ts`

这比“多 agent 群聊”更务实，也更容易验证。

## 5.7 P6：训练/蒸馏的节奏建议

### Phase 1：SFT

目标：蒸馏一个稳定输出研究报告和 proposal JSON 的小模型。

数据：

- 人工认可的 evolution report
- 通过 validator 的 proposal
- 经清洗后的 counterfactual summary

模型任务：

- 生成 `finding summary`
- 生成 `proposal rationale`
- 生成 `risk note`

不要让它直接生成 runtime action。

### Phase 2：DPO

目标：让模型学会偏好“更靠谱的提案风格”。

数据：

- `approved` vs `rejected`
- `confirmed` vs `rejected`
- `mixed` / `needs_more_data` 可作为弱负样本

注意：

- pair 要按同一路径、同一类问题构造，不要乱配
- 先做 proposal ranking，不要做直接策略输出

### Phase 3：RFT

只有在以下条件满足后才考虑：

1. verifier 已稳定
2. eval slices 足够多
3. OOS 结果长期稳定
4. 有足够多的 failure cases

如果这四点没满足，RFT 很容易把系统训练成“迎合 grader”的模型。

## 6. 建议的执行顺序

### 第一阶段：4 个最值的任务

1. 建 `pool_decision_sample` 派生层
2. 建 `counterfactual-analyzer`
3. 建 `proposal-validator` 和 OOS eval slices
4. 把 sizing 升级为条件化保守 cap

### 第二阶段：3 个增强任务

1. 做 archetype tagging
2. 做行为层 exit evidence
3. 接入 LLM researcher JSON 报告

### 第三阶段：训练任务

1. SFT 研究报告模型
2. DPO proposal ranking
3. 谨慎评估是否值得做 RFT

## 7. 我最推荐的落地版本

如果只选一条最优路线，我建议：

1. 不改主链路边界
2. 不急着上多 agent
3. 不急着上训练
4. 先把 `sample factory + verifier` 做强
5. 然后再把 LLM 接成研究压缩层

一句话说，就是：

**先让系统更会“证明自己为什么该改参数”，再让模型更会“提出看起来聪明的建议”。**

## 8. 可直接立项的任务清单

### T1 样本工厂

- 新增 `pool_decision_sample` 类型、builder、store
- 目标：统一候选、观察、结果、future path、counterfactual

### T2 反事实回放器

- 针对 allowlist 参数做单参数回放
- 输出切片化验证结果

### T3 强 verifier

- 将 proposal 生成建立在 `validator_result` 上
- 降低纯启发式 finding 的权重

### T4 条件化 sizing

- 先做 conservative cap
- 不做 aggressive size-up

### T5 LLM researcher

- 输入固定 bundle
- 输出固定 JSON
- 不触达 runtime

## 9. 参考资料

- OpenAI Supervised Fine-Tuning / Distillation Guide: [https://developers.openai.com/api/docs/guides/supervised-fine-tuning#distilling-from-a-larger-model](https://developers.openai.com/api/docs/guides/supervised-fine-tuning#distilling-from-a-larger-model)
- OpenAI Direct Preference Optimization Guide: [https://developers.openai.com/api/docs/guides/direct-preference-optimization](https://developers.openai.com/api/docs/guides/direct-preference-optimization)
- OpenAI Reinforcement Fine-Tuning Guide: [https://developers.openai.com/api/docs/guides/reinforcement-fine-tuning](https://developers.openai.com/api/docs/guides/reinforcement-fine-tuning)
- Anthropic Bloom: [https://www.anthropic.com/research/bloom](https://www.anthropic.com/research/bloom)
- Anthropic Trustworthy Agents: [https://www.anthropic.com/research/trustworthy-agents](https://www.anthropic.com/research/trustworthy-agents)
- Anthropic Automated Alignment Researchers: [https://www.anthropic.com/research/automated-alignment-researchers](https://www.anthropic.com/research/automated-alignment-researchers)
- Anthropic AI-resistant Technical Evaluations: [https://www.anthropic.com/engineering/AI-resistant-technical-evaluations](https://www.anthropic.com/engineering/AI-resistant-technical-evaluations)
- ICLR 2026 Poster, Solver-Verifier Gap: [https://iclr.cc/virtual/2026/poster/10010371](https://iclr.cc/virtual/2026/poster/10010371)

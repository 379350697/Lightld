export type DecisionContextSection = Record<string, unknown>;

export type DecisionContextInput = {
  pool?: DecisionContextSection;
  token?: DecisionContextSection;
  trader?: DecisionContextSection;
  route?: DecisionContextSection;
};

export function buildDecisionContext(input: DecisionContextInput) {
  return {
    createdAt: new Date().toISOString(),
    pool: input.pool ?? {},
    token: input.token ?? {},
    trader: input.trader ?? {},
    route: input.route ?? {}
  };
}

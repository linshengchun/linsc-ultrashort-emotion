export type MarketPhase = '混沌期' | '主升期' | '电风扇期' | '主跌期';

export type DataMode = 'demo' | 'snapshot' | 'live';

export interface StockIdentity {
  code: string;
  name: string;
  exchange: 'SH' | 'SZ' | 'BJ';
  board?: 'MAIN' | 'CHINEXT' | 'STAR' | 'BSE';
}

export interface CycleSignals {
  policyCatalyst: number;
  policySuppression: number;
  dominantThemeConcentration: number;
  activeThemeCount: number;
  turnoverTrendPct: number;
  ladderCompleteness: number;
  relayPromotionRate: number;
  highBoardFeedbackPct: number;
  quantRotationIntensity: number;
  leaderBreakdownRate: number;
  trendBreakdownRate: number;
  activeCapital: number;
}

export interface PhaseScore {
  phase: MarketPhase;
  score: number;
}

export interface DataQualityInput {
  mode: DataMode;
  universeExpected: number;
  universeCovered: number;
  limitReasonExpected: number;
  limitReasonCovered: number;
  relayExpected: number;
  relayCovered: number;
  quoteDelaySeconds: number;
  intraday: boolean;
}

export interface DataQualityResult {
  status: 'demo' | 'blocked' | 'complete';
  score: number;
  canConclude: boolean;
  universeCoverage: number;
  limitReasonCoverage: number;
  relayCoverage: number;
  blockers: string[];
}

const clamp = (value: number) => Math.min(100, Math.max(0, value));
const round = (value: number) => Math.round(value);

export function isEligibleStock(stock: StockIdentity): boolean {
  const normalizedName = stock.name.replace(/\s/g, '').toUpperCase();
  const isRiskWarning = normalizedName.includes('ST');
  const isBeijing = stock.exchange === 'BJ' || stock.board === 'BSE';
  const isStar = stock.board === 'STAR' || /^68[89]/.test(stock.code);

  return !isRiskWarning && !isBeijing && !isStar;
}

export function scoreMarketPhases(signals: CycleSignals): PhaseScore[] {
  const relay = clamp(signals.relayPromotionRate * 2);
  const feedback = clamp(50 + signals.highBoardFeedbackPct * 5);
  const turnoverExpansion = clamp(50 + signals.turnoverTrendPct * 5);
  const turnoverContraction = 100 - turnoverExpansion;
  const themeDispersion = 100 - clamp(signals.dominantThemeConcentration);
  const manyThemes = clamp(signals.activeThemeCount * 18);

  const scores: Record<MarketPhase, number> = {
    混沌期:
      (100 - signals.policyCatalyst) * 0.18 +
      themeDispersion * 0.2 +
      (100 - signals.ladderCompleteness) * 0.18 +
      (100 - signals.activeCapital) * 0.18 +
      turnoverContraction * 0.16 +
      (100 - relay) * 0.1,
    主升期:
      signals.policyCatalyst * 0.18 +
      signals.dominantThemeConcentration * 0.22 +
      signals.ladderCompleteness * 0.2 +
      relay * 0.15 +
      feedback * 0.1 +
      signals.activeCapital * 0.15,
    电风扇期:
      manyThemes * 0.2 +
      turnoverExpansion * 0.18 +
      signals.quantRotationIntensity * 0.27 +
      themeDispersion * 0.2 +
      (100 - relay) * 0.15,
    主跌期:
      signals.policySuppression * 0.18 +
      signals.leaderBreakdownRate * 0.25 +
      signals.trendBreakdownRate * 0.2 +
      (100 - signals.activeCapital) * 0.15 +
      (100 - feedback) * 0.12 +
      (100 - relay) * 0.1,
  };

  return (Object.entries(scores) as [MarketPhase, number][])
    .map(([phase, score]) => ({ phase, score: round(clamp(score)) }))
    .sort((a, b) => b.score - a.score);
}

export function evaluateDataQuality(input: DataQualityInput): DataQualityResult {
  const ratio = (covered: number, expected: number) =>
    expected <= 0 ? 1 : Math.min(1, Math.max(0, covered / expected));

  const universeCoverage = ratio(input.universeCovered, input.universeExpected);
  const limitReasonCoverage = ratio(input.limitReasonCovered, input.limitReasonExpected);
  const relayCoverage = ratio(input.relayCovered, input.relayExpected);
  const blockers: string[] = [];

  if (input.mode === 'demo') blockers.push('当前使用演示数据');
  if (universeCoverage < 0.95) blockers.push('股票池行情覆盖率低于 95%');
  if (limitReasonCoverage < 0.9) blockers.push('涨停原因覆盖率低于 90%');
  if (relayCoverage < 0.95) blockers.push('昨日涨停反馈覆盖率低于 95%');
  if (input.intraday && input.quoteDelaySeconds > 60) blockers.push('盘中行情延迟超过 60 秒');

  const score = round(
    (universeCoverage * 0.5 + limitReasonCoverage * 0.2 + relayCoverage * 0.2 +
      (input.quoteDelaySeconds <= (input.intraday ? 60 : 600) ? 1 : 0) * 0.1) *
      100,
  );
  const hasCoverageBlocker = blockers.some((item) => !item.includes('演示数据'));
  const status = input.mode === 'demo' ? 'demo' : hasCoverageBlocker ? 'blocked' : 'complete';

  return {
    status,
    score,
    canConclude: status === 'complete',
    universeCoverage,
    limitReasonCoverage,
    relayCoverage,
    blockers,
  };
}

export function chooseMarketPhase(signals: CycleSignals): PhaseScore {
  return scoreMarketPhases(signals)[0];
}

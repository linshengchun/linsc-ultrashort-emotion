import type { CycleSignals, DataMode } from './emotion-engine';

export type SessionMode = 'intraday' | 'post-close';

export interface ThemeRow {
  name: string;
  role: '主线' | '分支' | '轮动';
  strength: number;
  days: number;
  limitUps: number;
  leader: string;
  core: string;
  change: string;
  nextCondition: string;
}

export interface RelayRow {
  height: number;
  stocks: string[];
  promoted: number;
  attempted: number;
}

export interface AnchorRow {
  name: string;
  role: string;
  state: '强' | '分歧' | '弱';
  feedback: string;
  influence: string;
  invalidation: string;
}

export interface EmotionSnapshot {
  mode: DataMode;
  session: SessionMode;
  label: string;
  asOf: string;
  cycleSubtitle: string;
  signals: CycleSignals;
  quality: {
    universeExpected: number;
    universeCovered: number;
    limitReasonExpected: number;
    limitReasonCovered: number;
    relayExpected: number;
    relayCovered: number;
    quoteDelaySeconds: number;
  };
  market: {
    turnover: string;
    turnoverChange: string;
    advances: number;
    declines: number;
    flat: number;
    limitUp: number;
    limitDown: number;
    brokenBoards: number;
    sealRate: string;
    yesterdayOpen: string;
    yesterdayClose: string;
    relayRate: string;
  };
  themes: ThemeRow[];
  ladder: RelayRow[];
  anchors: AnchorRow[];
  effects: {
    label: string;
    score: number;
    tone: 'profit' | 'loss' | 'neutral';
    detail: string;
  }[];
  evidence: { label: string; value: string; stance: 'positive' | 'negative' | 'neutral' }[];
}

const shared = {
  mode: 'demo' as const,
  label: '样例交易日',
  themes: [
    {
      name: 'AI 应用',
      role: '主线' as const,
      strength: 88,
      days: 6,
      limitUps: 18,
      leader: '核心示例 A',
      core: '容量示例 B',
      change: '高位分歧，低位软件分支补涨',
      nextCondition: '核心 A 不出现负反馈，容量 B 保持红盘承接',
    },
    {
      name: '机器人',
      role: '分支' as const,
      strength: 73,
      days: 3,
      limitUps: 11,
      leader: '核心示例 C',
      core: '容量示例 D',
      change: '首板扩散，梯队开始成形',
      nextCondition: '2进3成功且首板回封率不下降',
    },
    {
      name: '固态电池',
      role: '轮动' as const,
      strength: 61,
      days: 2,
      limitUps: 7,
      leader: '核心示例 E',
      core: '容量示例 F',
      change: '消息驱动，尚未穿越分歧',
      nextCondition: '中军放量上行，不能只剩小票一字',
    },
    {
      name: '消费复苏',
      role: '轮动' as const,
      strength: 42,
      days: 1,
      limitUps: 4,
      leader: '核心示例 G',
      core: '容量示例 H',
      change: '低位试错，资金介入浅',
      nextCondition: '次日竞价超预期且出现容量成交',
    },
  ],
  ladder: [
    { height: 6, stocks: ['核心示例 A'], promoted: 1, attempted: 1 },
    { height: 5, stocks: [], promoted: 0, attempted: 1 },
    { height: 4, stocks: ['核心示例 C', '核心示例 I'], promoted: 2, attempted: 3 },
    { height: 3, stocks: ['补涨示例 J', '补涨示例 K', '补涨示例 L'], promoted: 3, attempted: 6 },
    { height: 2, stocks: ['分支示例 M', '分支示例 N', '分支示例 O', '分支示例 P'], promoted: 4, attempted: 10 },
  ],
  anchors: [
    {
      name: '核心示例 A',
      role: '空间龙 · 主线情绪锚',
      state: '强' as const,
      feedback: '弱转强后换手封板',
      influence: '维持主线高位辨识度，带动低位软件分支补涨',
      invalidation: '竞价低于 -3% 且 10:00 前无主动修复',
    },
    {
      name: '容量示例 B',
      role: '中军 · 题材容量锚',
      state: '分歧' as const,
      feedback: '放量震荡，收盘守住均线',
      influence: '决定大资金是否继续留在主线，而非退回纯小票博弈',
      invalidation: '放量跌破 5 日线且板块成交同步萎缩',
    },
    {
      name: '核心示例 C',
      role: '分支龙 · 梯队锚',
      state: '强' as const,
      feedback: '分歧回封，带出 3 个首板',
      influence: '确认机器人由轮动向分支题材升级',
      invalidation: '断板后无反包，首板次日大面积低开',
    },
  ],
  effects: [
    { label: '连板接力', score: 82, tone: 'profit' as const, detail: '高标与 2进3 反馈最佳' },
    { label: '容量趋势', score: 64, tone: 'profit' as const, detail: '主线中军可低吸，不宜追高' },
    { label: '低价小票', score: 38, tone: 'loss' as const, detail: '后排冲高回落集中' },
    { label: '二波 / 反包', score: 71, tone: 'profit' as const, detail: '辨识度老龙出现修复' },
    { label: '复牌博弈', score: 24, tone: 'loss' as const, detail: '样本少且承接弱' },
  ],
  evidence: [
    { label: '政策与消息', value: '密集，主线催化连续', stance: 'positive' as const },
    { label: '连板梯度', value: '6 / 4 / 3 / 2 板，5板断层', stance: 'positive' as const },
    { label: '高标反馈', value: '+4.2%，暂未出现 A 杀', stance: 'positive' as const },
    { label: '活跃资金', value: '核心席位净买，仓位偏重', stance: 'positive' as const },
    { label: '量化轮动', value: '强度上升，后排持续性下降', stance: 'negative' as const },
    { label: '趋势结构', value: '容量中军仍守关键均线', stance: 'neutral' as const },
  ],
};

export const demoSnapshots: Record<SessionMode, EmotionSnapshot> = {
  'post-close': {
    ...shared,
    session: 'post-close',
    asOf: '15:00 收盘',
    cycleSubtitle: '主线仍在，梯队完整；高位分歧扩大，次日重点观察核心回流。',
    signals: {
      policyCatalyst: 82,
      policySuppression: 10,
      dominantThemeConcentration: 78,
      activeThemeCount: 4,
      turnoverTrendPct: 8,
      ladderCompleteness: 76,
      relayPromotionRate: 55,
      highBoardFeedbackPct: 4.2,
      quantRotationIntensity: 58,
      leaderBreakdownRate: 18,
      trendBreakdownRate: 20,
      activeCapital: 81,
    },
    quality: {
      universeExpected: 4977,
      universeCovered: 4812,
      limitReasonExpected: 72,
      limitReasonCovered: 68,
      relayExpected: 44,
      relayCovered: 44,
      quoteDelaySeconds: 0,
    },
    market: {
      turnover: '18,642 亿',
      turnoverChange: '+8.0%',
      advances: 3286,
      declines: 1691,
      flat: 87,
      limitUp: 72,
      limitDown: 8,
      brokenBoards: 20,
      sealRate: '78%',
      yesterdayOpen: '+1.82%',
      yesterdayClose: '+2.41%',
      relayRate: '55%',
    },
  },
  intraday: {
    ...shared,
    session: 'intraday',
    asOf: '11:26 盘中切片',
    cycleSubtitle: '主线核心仍强，但午前轮动加快；只跟踪已确认锚点，不用盘中局部数据定周期。',
    signals: {
      policyCatalyst: 80,
      policySuppression: 10,
      dominantThemeConcentration: 70,
      activeThemeCount: 5,
      turnoverTrendPct: 11,
      ladderCompleteness: 72,
      relayPromotionRate: 48,
      highBoardFeedbackPct: 2.7,
      quantRotationIntensity: 68,
      leaderBreakdownRate: 23,
      trendBreakdownRate: 25,
      activeCapital: 75,
    },
    quality: {
      universeExpected: 4977,
      universeCovered: 4760,
      limitReasonExpected: 61,
      limitReasonCovered: 54,
      relayExpected: 44,
      relayCovered: 43,
      quoteDelaySeconds: 18,
    },
    market: {
      turnover: '10,286 亿',
      turnoverChange: '+11.0%',
      advances: 3021,
      declines: 1928,
      flat: 115,
      limitUp: 61,
      limitDown: 5,
      brokenBoards: 17,
      sealRate: '78%',
      yesterdayOpen: '+1.82%',
      yesterdayClose: '+1.36%',
      relayRate: '48%',
    },
  },
};

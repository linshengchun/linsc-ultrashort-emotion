export type MarketDay = {
  date: string;
  label: string;
  turnoverYi: number | null;
  up: number | null;
  down: number | null;
  limitUp: number | null;
  limitDown: number | null;
  connected: number | null;
  highestBoard: number | null;
  state: string;
};

export type YesterdayFeedbackDay = {
  date: string;
  label: string;
  sample: number | null;
  redOpen: number | null;
  redOpenRate: number | null;
  averageOpen: number | null;
  redClose: number | null;
  redCloseRate: number | null;
  averageClose: number | null;
  continuedLimit: number | null;
  continuedLimitRate: number | null;
};

export type Theme = {
  name: string;
  strength: string;
  stage: string;
  messages: Array<{ source: string; content: string }>;
  branches: string[];
  limitStocks: string[];
  logic: string;
  expectationSpace: string;
  persistence: string;
  coreStocks: Array<{ name: string; role: string; performance: string }>;
};

export type Report = {
  date: string;
  displayDate: string;
  generatedAt: string;
  title: string;
  conclusion: {
    cycle: string;
    substate: string;
    temperature: number;
    summary: string;
    evidence: string[];
  };
  market: {
    turnoverYi: number;
    turnoverChangeYi: number;
    indexSummary: string;
    up: number;
    down: number;
    limitUp: number;
    limitDown: number;
    connected: number;
    highestBoard: number;
    fiveDays: MarketDay[];
  };
  yesterdayFeedback: {
    sample: number;
    redOpen: number;
    redOpenRate: number;
    averageOpen: number;
    redClose: number;
    redCloseRate: number;
    averageClose: number;
    continuedLimit: number;
    continuedLimitRate: number;
    reading: string;
    fiveDays: YesterdayFeedbackDay[];
  };
  ladder: Array<{ board: number; stocks: string[] }>;
  anchors: Array<{ name: string; board: string; role: string; influence: string }>;
  themes: Theme[];
  themeTimeline: Array<{ theme: string; days: Array<{ date: string; performance: string; leaders: string[] }> }>;
  effects: {
    relayDifficulty: string;
    profit: string[];
    loss: string[];
    styles: Array<{ style: string; result: string; reading: string }>;
  };
  cycle: {
    main: string;
    substate: string;
    signals: string[];
    risk: string;
  };
  oneToTwo: Array<{
    rank: string;
    name: string;
    firstLimitTime: string;
    seal: string;
    theme: string;
    speculationLogic: string;
    forecast: string;
  }>;
  sources: {
    objective: string[];
    themes: string[];
    narratives: string[];
    note: string;
  };
};

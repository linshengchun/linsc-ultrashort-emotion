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

export type Theme = {
  name: string;
  strength: string;
  stage: string;
  message: string;
  logic: string;
  expectation: string;
  imagination: string;
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
  };
  ladder: Array<{ board: number; stocks: string[] }>;
  anchors: Array<{ name: string; board: string; role: string; influence: string }>;
  eventTree: Array<{ theme: string; trigger: string; branches: string[]; limitStocks: string[] }>;
  themes: Theme[];
  themeTimeline: Array<{ theme: string; days: Array<{ date: string; performance: string }> }>;
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
    reason: string;
    forecast: string;
  }>;
  sources: {
    objective: string[];
    themes: string[];
    narratives: string[];
    note: string;
  };
};

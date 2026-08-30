import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const valueOf = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};

const date = valueOf('--date', new Date().toISOString().slice(0, 10));
const input = valueOf('--input', path.join('data', 'reports', `${date}.json`));
const output = valueOf('--output', path.join('data', 'reports', `${date}.md`));
const report = JSON.parse(await readFile(input, 'utf8'));

const fmt = (value, suffix = '') => (value === null || value === undefined ? '—' : `${value}${suffix}`);
const row = (cells) => `| ${cells.map((cell) => String(cell).replaceAll('|', '／').replaceAll('\n', ' ')).join(' | ')} |`;
const bullets = (items) => items.map((item) => `- ${item}`).join('\n');

const lines = [
  `# ${report.title}｜${report.displayDate}`,
  '',
  `> **周期：${report.conclusion.cycle}｜子状态：${report.conclusion.substate}｜情绪温度：${report.conclusion.temperature}/100**`,
  '>',
  `> ${report.conclusion.summary}`,
  '',
  '## 一、当日结论',
  '',
  bullets(report.conclusion.evidence),
  '',
  '## 二、大盘基础行情、近5日与周期定位',
  '',
  `- 成交额：约 **${fmt(report.market.turnoverYi)}亿元**，较前一日 **${report.market.turnoverChangeYi === null || report.market.turnoverChangeYi === undefined ? '—' : `${report.market.turnoverChangeYi > 0 ? '+' : ''}${report.market.turnoverChangeYi}`}亿元**。`,
  `- 股票范围：上涨 **${fmt(report.market.up)}家**，下跌 **${fmt(report.market.down)}家**，涨停 **${fmt(report.market.limitUp)}家**，跌停 **${fmt(report.market.limitDown)}家**。`,
  `- 连板：**${fmt(report.market.connected)}家**，最高 **${fmt(report.market.highestBoard)}板**。`,
  `- 指数：${report.market.indexSummary}`,
  '',
  row(['日期', '成交额(亿)', '上涨', '下跌', '涨停', '跌停', '连板', '最高板', '子状态']),
  row(['---', '---:', '---:', '---:', '---:', '---:', '---:', '---:', '---']),
  ...report.market.fiveDays.map((day) => row([`${day.date} ${day.label}`, fmt(day.turnoverYi), fmt(day.up), fmt(day.down), fmt(day.limitUp), fmt(day.limitDown), fmt(day.connected), fmt(day.highestBoard), day.state])),
  '',
  `**周期定位：** ${report.cycle.main}；${report.cycle.substate}。${report.cycle.risk}`,
  '',
  '## 三、昨日涨停股次日反馈与近5日对比',
  '',
  row(['日期', '样本', '红开', '红开率', '平均开盘', '收红', '收红率', '平均收盘', '晋级涨停', '晋级率']),
  row(['---', '---:', '---:', '---:', '---:', '---:', '---:', '---:', '---:', '---:']),
  ...report.yesterdayFeedback.fiveDays.map((day) => row([
    `${day.date} ${day.label}`,
    fmt(day.sample),
    fmt(day.redOpen),
    fmt(day.redOpenRate, '%'),
    fmt(day.averageOpen, '%'),
    fmt(day.redClose),
    fmt(day.redCloseRate, '%'),
    fmt(day.averageClose, '%'),
    fmt(day.continuedLimit),
    fmt(day.continuedLimitRate, '%'),
  ])),
  '',
  report.yesterdayFeedback.reading,
  '',
  '## 四、连板梯队与接力结构',
  '',
  ...report.ladder.map((level) => `- **${level.board}板：** ${level.stocks.join('、')}`),
  '',
  '## 五、高标、情绪锚与题材影响',
  '',
  row(['个股', '身位', '情绪地位', '对题材与接力的影响']),
  row(['---', '---', '---', '---']),
  ...report.anchors.map((item) => row([item.name, item.board, item.role, item.influence])),
  '',
  '## 六、涨停题材事件树与结构分析',
  '',
  ...report.themes.flatMap((theme) => [
    `### ${theme.name}｜${theme.strength}｜${theme.stage}`,
    '',
    '- **市场触发／消息面：**',
    ...theme.messages.map((item) => `  - **${item.source}：** ${item.content}`),
    `- **扩散路径：** ${theme.branches.join(' → ')}`,
    `- **涨停映射：** ${theme.limitStocks.join('、')}`,
    `- **逻辑面：** ${theme.logic}`,
    `- **预期与想象空间：** ${theme.expectationSpace}`,
    `- **持续情况：** ${theme.persistence}`,
    '',
    row(['核心个股', '角色', '当日表现']),
    row(['---', '---', '---']),
    ...theme.coreStocks.map((stock) => row([stock.name, stock.role, stock.performance])),
    '',
  ]),
  '## 七、近期题材持续情况',
  '',
  ...report.themeTimeline.flatMap((theme) => [
    `### ${theme.theme}`,
    '',
    row(['维度', ...theme.days.map((day) => day.date)]),
    row(['---', ...theme.days.map(() => '---')]),
    row(['发酵表现', ...theme.days.map((day) => day.performance)]),
    row(['领涨核心', ...theme.days.map((day) => day.leaders.length ? day.leaders.join('、') : '—')]),
    '',
  ]),
  '## 八、赚钱效应、亏钱效应与接力难度',
  '',
  `> **接力难度：${report.effects.relayDifficulty}**`,
  '',
  `- **赚钱效应：** ${report.effects.profit.join('；')}。`,
  `- **亏钱效应：** ${report.effects.loss.join('；')}。`,
  '',
  row(['风格', '结果', '判断']),
  row(['---', '---', '---']),
  ...report.effects.styles.map((item) => row([item.style, item.result, item.reading])),
  '',
  '## 九、次日1进2预期标的',
  '',
  '> 本模块是条件预判，不是无条件推荐。竞价、同题材强度与核心反馈必须同时观察。',
  '',
  row(['等级', '标的', '题材', '涨停时间与力度', '异动解析＋帖子吹票逻辑', '接力预判']),
  row(['---', '---', '---', '---', '---', '---']),
  ...report.oneToTwo.map((item) => row([item.rank, item.name, item.theme, `${item.firstLimitTime}；${item.seal}`, item.speculationLogic, item.forecast])),
  '',
  '## 数据来源与使用边界',
  '',
  `- **客观行情：** ${report.sources.objective.join(' → ')}`,
  `- **涨停题材：** ${report.sources.themes.join(' → ')}`,
  `- **题材与个股叙事：** ${report.sources.narratives.join(' → ')}`,
  `- ${report.sources.note}`,
];

await mkdir(path.dirname(output), { recursive: true });
const markdown = `${lines.join('\n')}\n`;
await writeFile(output, markdown, 'utf8');
const publicOutput = path.join('public', 'reports', `${date}.md`);
await mkdir(path.dirname(publicOutput), { recursive: true });
await writeFile(publicOutput, markdown, 'utf8');
await writeFile(path.join('public', 'reports', `${date}.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(output);

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
  '## 二、大盘基础行情与近5日对比',
  '',
  `- 成交额：约 **${report.market.turnoverYi}亿元**，较前一日 **${report.market.turnoverChangeYi > 0 ? '+' : ''}${report.market.turnoverChangeYi}亿元**。`,
  `- 股票范围：上涨 **${report.market.up}家**，下跌 **${report.market.down}家**，涨停 **${report.market.limitUp}家**，跌停 **${report.market.limitDown}家**。`,
  `- 连板：**${report.market.connected}家**，最高 **${report.market.highestBoard}板**。`,
  `- 指数：${report.market.indexSummary}`,
  '',
  row(['日期', '成交额(亿)', '上涨', '下跌', '涨停', '跌停', '连板', '最高板', '子状态']),
  row(['---', '---:', '---:', '---:', '---:', '---:', '---:', '---:', '---']),
  ...report.market.fiveDays.map((day) => row([`${day.date} ${day.label}`, fmt(day.turnoverYi), fmt(day.up), fmt(day.down), fmt(day.limitUp), fmt(day.limitDown), fmt(day.connected), fmt(day.highestBoard), day.state])),
  '',
  '## 三、昨日涨停股次日反馈',
  '',
  row(['样本', '红开', '红开成功率', '平均开盘', '收红', '收红率', '平均收盘', '晋级涨停']),
  row(['---:', '---:', '---:', '---:', '---:', '---:', '---:', '---:']),
  row([report.yesterdayFeedback.sample, report.yesterdayFeedback.redOpen, fmt(report.yesterdayFeedback.redOpenRate, '%'), fmt(report.yesterdayFeedback.averageOpen, '%'), report.yesterdayFeedback.redClose, fmt(report.yesterdayFeedback.redCloseRate, '%'), fmt(report.yesterdayFeedback.averageClose, '%'), `${report.yesterdayFeedback.continuedLimit}（${report.yesterdayFeedback.continuedLimitRate}%）`]),
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
  '## 六、涨停原因与题材事件树',
  '',
  ...report.eventTree.flatMap((item) => [
    `### ${item.theme}`,
    '',
    `- **市场触发：** ${item.trigger}`,
    `- **扩散分支：** ${item.branches.join(' → ')}`,
    `- **涨停映射：** ${item.limitStocks.join('、')}`,
    '',
  ]),
  '## 七、题材结构：消息、逻辑、预期与想象空间',
  '',
  ...report.themes.flatMap((theme) => [
    `### ${theme.name}｜${theme.strength}｜${theme.stage}`,
    '',
    `- **消息面：** ${theme.message}`,
    `- **逻辑面：** ${theme.logic}`,
    `- **预期面：** ${theme.expectation}`,
    `- **想象空间：** ${theme.imagination}`,
    `- **持续情况：** ${theme.persistence}`,
    '',
    row(['核心个股', '角色', '当日表现']),
    row(['---', '---', '---']),
    ...theme.coreStocks.map((stock) => row([stock.name, stock.role, stock.performance])),
    '',
  ]),
  '## 八、近期题材持续情况',
  '',
  ...report.themeTimeline.flatMap((theme) => [
    `### ${theme.theme}`,
    '',
    row(theme.days.map((day) => day.date)),
    row(theme.days.map(() => '---')),
    row(theme.days.map((day) => day.performance)),
    '',
  ]),
  '## 九、赚钱效应、亏钱效应与接力难度',
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
  '## 十、短线情绪周期与当日子状态',
  '',
  `- **主周期：** ${report.cycle.main}`,
  `- **当日子状态：** ${report.cycle.substate}`,
  `- **风险转折：** ${report.cycle.risk}`,
  '',
  bullets(report.cycle.signals),
  '',
  '## 十一、次日1进2预期标的',
  '',
  '> 本模块是条件预判，不是无条件推荐。竞价、同题材强度与核心反馈必须同时观察。',
  '',
  row(['等级', '标的', '题材', '涨停时间与力度', '炒作原因', '接力预判']),
  row(['---', '---', '---', '---', '---', '---']),
  ...report.oneToTwo.map((item) => row([item.rank, item.name, item.theme, `${item.firstLimitTime}；${item.seal}`, item.reason, item.forecast])),
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

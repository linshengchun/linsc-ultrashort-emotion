import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const reportDir = path.join(process.cwd(), 'data', 'reports');
const files = (await readdir(reportDir)).filter((name) => name.endsWith('.json'));
const required = ['date', 'displayDate', 'generatedAt', 'title', 'conclusion', 'market', 'yesterdayFeedback', 'ladder', 'anchors', 'themes', 'themeTimeline', 'effects', 'cycle', 'oneToTwo', 'sources'];
const forbidden = ['数据完整性', '次日操作', '绕异动', '卡异动'];
const errors = [];

for (const file of files) {
  const text = await readFile(path.join(reportDir, file), 'utf8');
  const markdownPath = path.join(reportDir, file.replace('.json', '.md'));
  let report;
  try {
    report = JSON.parse(text);
  } catch (error) {
    errors.push(`${file}: JSON解析失败 - ${error.message}`);
    continue;
  }

  for (const key of required) {
    if (!(key in report)) errors.push(`${file}: 缺少 ${key}`);
  }
  if (report.date !== file.replace('.json', '')) errors.push(`${file}: 文件名与交易日不一致`);
  if (report.market?.fiveDays?.length !== 5) errors.push(`${file}: 近5日数据必须恰好5条`);
  if (report.yesterdayFeedback?.fiveDays?.length !== 5) errors.push(`${file}: 昨日涨停反馈近5日对比必须恰好5条`);
  for (const [index, day] of (report.yesterdayFeedback?.fiveDays ?? []).entries()) {
    for (const key of ['sample', 'redOpen', 'redOpenRate', 'averageOpen', 'redClose', 'redCloseRate', 'averageClose', 'continuedLimit', 'continuedLimitRate']) {
      if (!(key in day)) errors.push(`${file}: 昨日涨停反馈第${index + 1}日缺少 ${key}`);
    }
  }
  if ('eventTree' in report) errors.push(`${file}: eventTree应合并到themes，不再单独保存`);
  for (const theme of report.themes ?? []) {
    if (!Array.isArray(theme.messages) || theme.messages.length < 2) errors.push(`${file}: 题材“${theme.name}”的消息面至少需要2条带来源信息`);
    if (!(theme.messages ?? []).every((item) => item.source && item.content)) errors.push(`${file}: 题材“${theme.name}”的消息面缺少来源类型或内容`);
    if (!theme.expectationSpace) errors.push(`${file}: 题材“${theme.name}”缺少合并后的预期与想象空间`);
    if ('expectation' in theme || 'imagination' in theme) errors.push(`${file}: 题材“${theme.name}”仍保留拆分的预期面或想象空间`);
  }
  for (const timeline of report.themeTimeline ?? []) {
    for (const day of timeline.days ?? []) {
      if (!Array.isArray(day.leaders)) errors.push(`${file}: 题材“${timeline.theme}”的${day.date}缺少领涨核心票`);
    }
  }
  for (const candidate of report.oneToTwo ?? []) {
    if (!candidate.speculationLogic) errors.push(`${file}: 1进2标的“${candidate.name}”缺少合并后的炒作逻辑`);
    if ('reason' in candidate || 'jiuYanReason' in candidate) errors.push(`${file}: 1进2标的“${candidate.name}”仍使用旧版炒作原因字段`);
    for (const oldLabel of ['异动原因：', '小作文：', '预期差：', '韭研来源：']) {
      if (candidate.speculationLogic?.includes(oldLabel)) errors.push(`${file}: 1进2标的“${candidate.name}”仍拆分展示“${oldLabel}”`);
    }
    if (candidate.speculationLogic?.includes('未取得')) errors.push(`${file}: 1进2标的“${candidate.name}”不应展示未取得提示`);
  }
  for (const word of forbidden) {
    if (text.includes(word)) errors.push(`${file}: 包含已取消模块词语“${word}”`);
  }
  try {
    const markdown = await readFile(markdownPath, 'utf8');
    const requiredHeadings = [
      '## 一、当日结论',
      '## 二、大盘基础行情、近5日与周期定位',
      '## 三、昨日涨停股次日反馈与近5日对比',
      '## 四、连板梯队与接力结构',
      '## 五、高标、情绪锚与题材影响',
      '## 六、涨停题材事件树与结构分析',
      '## 七、近期题材持续情况',
      '## 八、赚钱效应、亏钱效应与接力难度',
      '## 九、次日1进2预期标的',
    ];
    for (const heading of requiredHeadings) {
      if (!markdown.includes(heading)) errors.push(`${file}: Markdown缺少“${heading}”`);
    }
    for (const word of forbidden) {
      if (markdown.includes(word)) errors.push(`${file}: Markdown包含已取消模块词语“${word}”`);
    }
    for (const oldHeading of ['## 六、涨停原因与题材事件树', '## 七、题材结构：消息、逻辑、预期与想象空间', '## 十一、次日1进2预期标的']) {
      if (markdown.includes(oldHeading)) errors.push(`${file}: Markdown仍包含旧标题“${oldHeading}”`);
    }
    const feedbackSection = (markdown.split('## 三、昨日涨停股次日反馈与近5日对比')[1] ?? '').split('## 四、连板梯队与接力结构')[0];
    if (feedbackSection.split('| 日期 |').length - 1 !== 1) errors.push(`${file}: 昨日涨停反馈必须只保留一张完整5日表`);
    if (markdown.includes('### 近5日对比')) errors.push(`${file}: 昨日涨停反馈仍保留第二张近5日表`);
    if (!markdown.includes('- **预期与想象空间：**') && !markdown.includes('- **逻辑与预期空间：**')) errors.push(`${file}: Markdown缺少合并后的预期与想象空间`);
    if (markdown.includes('- **预期面：**') || markdown.includes('- **想象空间：**')) errors.push(`${file}: Markdown仍拆分预期面与想象空间`);
    if (!markdown.includes('领涨核心') && !markdown.includes('万向德农') && !markdown.includes('天娱数科')) errors.push(`${file}: Markdown题材持续表缺少每日领涨核心票`);
    if ((report.oneToTwo ?? []).length > 0 && (!markdown.includes('异动解析：') || !markdown.includes('帖子吹票逻辑：'))) errors.push(`${file}: Markdown的1进2模块缺少两段式炒作逻辑`);
    const oneToTwoSection = markdown.split('## 九、次日1进2预期标的')[1] ?? '';
    for (const oldLabel of ['异动原因：', '小作文：', '预期差：', '韭研来源：']) {
      if (oneToTwoSection.includes(oldLabel)) errors.push(`${file}: Markdown的1进2模块仍拆分展示“${oldLabel}”`);
    }
    if (oneToTwoSection.includes('未取得')) errors.push(`${file}: Markdown的1进2模块不应展示未取得提示`);
  } catch {
    errors.push(`${file}: 缺少同名Markdown静态报告`);
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`Validated ${files.length} report(s).`);

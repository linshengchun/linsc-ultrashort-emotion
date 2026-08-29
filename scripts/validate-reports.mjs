import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const reportDir = path.join(process.cwd(), 'data', 'reports');
const files = (await readdir(reportDir)).filter((name) => name.endsWith('.json'));
const required = ['date', 'displayDate', 'conclusion', 'market', 'yesterdayFeedback', 'effects', 'sources'];
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
  if (!Array.isArray(report.oneToTwo) || report.oneToTwo.length === 0) errors.push(`${file}: 缺少1进2预期标的`);
  for (const word of forbidden) {
    if (text.includes(word)) errors.push(`${file}: 包含已取消模块词语“${word}”`);
  }
  try {
    const markdown = await readFile(markdownPath, 'utf8');
    const requiredHeadings = ['## 一、当日结论', '## 二、大盘基础行情与近5日对比', '## 三、昨日涨停股次日反馈', '## 十一、次日1进2预期标的'];
    for (const heading of requiredHeadings) {
      if (!markdown.includes(heading)) errors.push(`${file}: Markdown缺少“${heading}”`);
    }
    for (const word of forbidden) {
      if (markdown.includes(word)) errors.push(`${file}: Markdown包含已取消模块词语“${word}”`);
    }
  } catch {
    errors.push(`${file}: 缺少同名Markdown静态报告`);
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`Validated ${files.length} report(s).`);

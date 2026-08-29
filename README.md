# LINSC超短情绪复盘系统

面向只做多、持股约2—3日的A股超短交易者。项目把每个交易日的复盘固化为标准 Markdown 文件，并在网页中按日期阅读和归档。

## 工作方式

系统仅按需手动生成报告。

1. 在网页选择一个交易日。
2. 已有静态报告时直接打开。
3. 报告缺失时点击“生成本日报告”；已有报告可点击“重新生成”并覆盖同日期文件。
4. 仓库所有者在 GitHub Actions 中确认日期并执行工作流。
5. 工作流取数、生成 Markdown、校验11个模块并提交到仓库；Git历史保留每次覆盖前的版本。
6. 网站从公开仓库读取最新静态报告，无需为新增报告重新发布站点。

报告文件位于：

- `data/reports/YYYY-MM-DD.md`：正式 Markdown 报告。
- `data/reports/YYYY-MM-DD.json`：网页摘要和关键指标。
- `public/reports/index.json`：静态归档索引。

## 数据链路

| 数据 | 主来源 | 后备来源 |
| --- | --- | --- |
| 行情、涨跌分布、涨跌停池、昨日涨停反馈 | FTShare-MCP | AShareHub、东方财富 |
| 涨停原因、题材归类 | 同花顺问财 | 东方财富题材、公开市场资料 |
| 题材和个股小作文 | 韭研公社 | 选股通、财联社、市场公开讨论 |

股票范围固定排除名称含 `ST`、`*ST`、北交所和科创板，保留沪深主板与创业板。

题材消息按市场正在交易的叙事记录，不与公告做一致性核验；报告会区分市场叙事、预期和价格反馈，不把小作文写成已确认事实。

## 报告模块

1. 当日结论
2. 大盘基础行情与近5日对比
3. 昨日涨停股次日反馈（含红开成功率）
4. 连板梯队与接力结构
5. 高标、情绪锚与题材影响
6. 涨停原因与题材事件树
7. 题材的消息面、逻辑面、预期面和想象空间
8. 近期题材持续情况与核心个股表现
9. 赚钱效应、亏钱效应与接力难度
10. 主情绪周期与当日子状态
11. 次日1进2预期标的、炒作原因和条件预判

报告不展示内部数据门槛，不包含异动模块，也不输出泛化的次日操作建议。

## 本地运行

```bash
npm install
npm run dev
```

构建和校验：

```bash
npm run build
```

手动生成指定日期的完整链路：

```bash
npm run data:fetch -- --date 2026-08-28
npm run report:generate -- --date 2026-08-28
npm run report:prepare
```

## GitHub配置

在仓库 `Settings → Secrets and variables → Actions` 中添加：

- Secret `OPENAI_API_KEY`：仅供手动报告工作流使用。
- Variable `OPENAI_MODEL`：可选，默认 `gpt-5.4`。

网页构建使用：

- `NEXT_PUBLIC_REPOSITORY_URL`：GitHub仓库地址。
- `NEXT_PUBLIC_REPORTS_RAW_BASE`：`public/reports` 对应的 raw.githubusercontent.com 地址。

密钥不会进入网页、报告或 Git 记录。

## 当前样例

仓库内已包含 `2026-08-28` 的完整静态复盘，作为报告结构和网页渲染基准。

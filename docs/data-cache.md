# LINSC数据源与统一缓存

## 结论

现有数据层已把收盘终态、61个交易日窗口、确定性指标和重点股竞价/早盘证据纳入统一缓存。仍然存在的真实边界是：历史全市场竞价快照与历史分钟价格不能完整回放，韭研事件卡覆盖率取决于登录态和实际抓到的正文。

## Draft.13数据源覆盖矩阵

| ID | 需要的数据 | 主来源 | 后备来源 | 当前状态 |
|---|---|---|---|---|
| D1 | 交易日历、证券范围、名称、板块、交易状态 | FTShare V1 | 问财、AShareHub、东方财富；a-stock-data字段级补充 | 基本满足；历史证券属性仍须按日期核验；a-stock-data尚未接入本项目采集脚本 |
| D2 | 个股日线、成交额、换手率、历史流通市值、指数 | FTShare V1历史日行情 | 问财、AShareHub、东方财富；a-stock-data字段级补充 | 日线可用；部分证券字段与指数需定向补取；使用聚合工具时须记明实际底层来源 |
| D3 | 涨停、跌停、炸板、连板与失败成员 | FTShare V1涨跌停接口 + 本地历史重算 | 问财、东方财富；a-stock-data字段级补充 | 已形成确定性派生指标；跨源差异单列，不由模型裁决；聚合工具尚未完成口径验收 |
| D4 | 竞价、首次触板、开板/回封、封单采样、分时状态 | 同花顺竞价基准 + FTShare V1涨跌停时点/分钟成交占比 | 当日问财竞价快照 | **部分满足**；历史全市场竞价和历史分钟价格不支持回放，不能从日线反推 |
| D5 | 同范围60个交易日成交额 | FTShare V1逐日日行情本地求和 | 问财逐日查询 | 已实现61日滚动缓存；必须有D日前60个完整交易日才输出MA60 |
| D6 | 涨停原因、题材分类、事件对应个股 | 同花顺金融数据API / 问财 | 东方财富复盘、问财浏览器；a-stock-data内同花顺/东财题材字段（核明实际来源后） | 配置`HITHINK_FINANCE_API_KEY`后自动查询历史涨停原因；当日异动原因可取，历史异动原因接口不支持回放；a-stock-data仅补充字段，不替代问财事件原文 |
| D7 | 异动解析、帖子正文、传播与可知时点、催化卡 | 韭研公社 | 选股通、财联社、公开讨论 | 已接入正文缓存和确定性事件卡提取；覆盖率仍取决于登录态及实际取得的个股/板块正文 |
| D8 | 历史报告、原计划、角色池与题材冻结版本 | 本地报告及版本化缓存 | 用当时原始缓存重建并注明 | 可逐步满足；不能把重建结果冒充事前预测 |
| D9 | 样本、痛感、题材状态、行动条件及验证台账 | D1—D8派生 | 无外部替代 | 客观指标已版本化；痛感权重、预测命中与行动条件仍需后续回测台账 |

## 统一缓存目录

```text
data/cache/
├── ftshare/YYYY-MM-DD/
│   ├── objective.json
│   ├── objective.json.partial
│   └── manifest.json
├── wencai/YYYY-MM-DD/
│   ├── fallback.json
│   └── manifest.json
├── jiuyang/YYYY-MM-DD/
    ├── normalized.json
    ├── manifest.json
    └── raw/
├── intraday/YYYY-MM-DD/
│   ├── evidence.json
│   ├── manifest.json
│   └── raw/
└── derived/YYYY-MM-DD/
    ├── metrics.json
    └── manifest.json
```

每个来源独立保存原始/标准化结果和清单。清单至少记录交易日、来源、采集时间、完整/部分状态及数量。缓存不会提交到Git，也不会保存FTShare密钥或韭研账号密码。

### 补充聚合源：a-stock-data

[a-stock-data](https://github.com/simonlin1212/a-stock-data) 已列为字段级补充与交叉核验来源，但目前**尚未接入本项目自动采集脚本，也未通过字段口径验收**。它聚合多个第三方来源，实际调用时须记录具体底层提供方、交易日、返回时间和口径；不得将聚合工具名称当成唯一数据供应商，或用其结果静默覆盖 FTShare V1。接入本项目时不调用其中的通达信盘后数据路径，也不以它替代韭研公社叙事采集。

## 使用规则

- `npm run data:prepare -- --date YYYY-MM-DD`：准备同日缓存、重点股早盘证据和可用范围内的确定性指标。
- `npm run data:prepare -- --date YYYY-MM-DD --for-report`：正式报告入口。先确保D日前60个交易日与D日共61日FTShare终态缓存，再生成竞价/早盘证据和确定性指标；目标日未到15:10会停止。
- `npm run data:backfill -- --date YYYY-MM-DD --prior-days 60`：单独续传61日历史窗口。每个交易日均可断点续取，已完成日期直接命中。
- `npm run data:derive -- --date YYYY-MM-DD --for-report`：从本地缓存重算成交额、MA60、近5日、连板梯队和昨日涨停反馈，不调用大模型。
- `npm run data:evidence -- --date YYYY-MM-DD`：采集同花顺短线风向标竞价基准、FTShare涨跌停时点和重点股9:30—10:00成交占比。
- `npm run data:prepare -- --date YYYY-MM-DD --refresh`：明确要求重新取数时才强制刷新。
- `npm run data:health -- --date YYYY-MM-DD`：检查本地各来源、派生指标和早盘证据缓存，并对FTShare V1执行轻量在线探针。
- `npm run data:health -- --date YYYY-MM-DD --for-report`：按正式报告门槛检查收盘终态、61日窗口、两张近5日表和关键来源。
- `npm run data:health -- --date YYYY-MM-DD --no-live`：只检查本地缓存。
- 同花顺官方当前推荐变量名为`HITHINK_FINANCE_API_KEY`；本项目同时兼容本机已有的`FUYAO_API_KEY`以及官方旧兼容名`FUYAO_TOKEN`，不要求重复保存Key。问财采集优先使用正式API，不把Key写入缓存或日志。
- 双击`启动盘后数据采集.cmd`：打开专用浏览器；用户完成韭研登录后，程序自动准备当日缓存。未配置问财Key时，问财网页登录作为后备。
- `npm run wencai:collect -- --date YYYY-MM-DD`：只执行问财/同花顺历史涨停原因采集。
- `npm run narratives:extract -- --date YYYY-MM-DD`：不访问网络，只从已经缓存的韭研正文重建事件卡。
- 旧目录`data/raw`、`data/narratives`、`data/fallbacks`和既有`work/report-MMDD-v1`只作一次性导入；不会删除或改写原文件。
- 报告重新生成默认复用缓存。只有缓存缺失、不完整、日期不符或用户明确要求全量重取时，才访问上游。
- `manifest.json`同时记录`status`和`marketPhase`。`complete + intraday`只表示盘中该轮采集完成；正式报告只接受`complete + final`。历史日期自动视为终态；当日15:10后会拒绝复用此前的盘中缓存并重新获取。

## 完整性边界

“缓存完整”只代表该来源本次定义的采集任务完成，不代表Draft.13全部字段齐全。例如问财的一份涨停原因查询可标记为该查询已完整缓存，但不能据此宣称D6全部覆盖；韭研页面抓取成功也不等于全部涨停股已有事件卡。报告生成前仍须按D1—D9做字段级缺口检查。

# 隐私说明

EventLens Local 是纯本地工具。

- Web 服务仅监听 `127.0.0.1`，不对局域网或公网开放。
- 活动配置、排行榜快照和历史趋势保存在本机 `data/` 目录。
- 程序仅访问币安公开公告、公开排行榜和公开行情接口。
- 程序不要求用户登录，不读取或保存币安 Cookie、API Key、资产、订单、钱包私钥或助记词。
- 排行榜详细参与者记录只在一次采集的内存中用于完整性校验和汇总，不写入本地文件；本地仅保存聚合快照。
- 用户可以通过页面删除活动及其本地快照，也可以停止程序后手动删除 `data/campaigns.json`、`data/snapshots.json` 和 `data/snapshot-history.json`。

项目地址：https://github.com/yushengsheng/Trading-Volume-bn

# EventLens Local

币安交易赛排行榜、奖励和买卖价差分析工具。默认在本地运行，也支持部署到 Linux 服务器，通过 IP 和端口访问。活动配置、排行榜快照和历史记录保存在运行程序的电脑或服务器上，不需要浏览器扩展。

## 功能

- 从币安公告链接、公告代码或交易赛页面录入活动；多赛道交易者联赛必须粘贴具体 Round/子赛道排行榜链接。
- 使用本机 Brave/Chrome 读取公开排行榜，并抓取**全部分页**后再计算。
- 统计全部参与人数、总交易量、前 N 名交易量、后段交易量和奖励档位门槛。
- 后段奖励按“新增榜单计入量加入当前后段分母”估算，并应用公告中的单人奖励上限。
- 获取币安公开买一/卖一，优先使用单次批量请求，按“手续费 + 简单买卖价差”估算每千 U、每万 U 榜单计入量成本；活动有 1.2x 等倍数时会折算所需实际成交量。
- 行情不可用时明确显示不可用，不会生成假价格、假盘口或假排行榜。
- 保存最近 500 次成功快照，用于本地趋势和 CSV 导出。
- 可勾选开启或关闭每 30 分钟排行榜自动更新；关闭后保留手动更新，选择会保存到本机并在下次启动时恢复。
- 自动区分源数据时间、本地采集时间和最近检查时间。
- 公告列表和详情统一从 `www.bsmkweb.cc` 获取，跟随导航网站的重定向，不维护固定备用公告域名。公告入口：<https://www.bsmkweb.cc/zh-CN/support/announcement/list/93>。
- 每次抓榜先通过同一导航入口适配当前可用域名，再打开原活动和具体子赛道；已有监控中的旧域名失效也无需手动替换，不再尝试固定旧镜像。

> 排行榜自身的更新频率由币安决定。程序每 30 分钟检查一次，不代表币安排行榜每 30 分钟变化。
>
> 交易者联赛等包含多个独立赛道的综合公告不能仅凭公告代码安全确定目标榜单。请直接粘贴用户实际选择的具体 Round/子赛道 URL，工具会拒绝猜测。

## 系统要求

- Node.js 22 或更高版本
- Brave Browser 或 Google Chrome
- macOS、Windows 或常见 Linux 系统；Linux 服务器无需图形桌面，抓榜使用无界面浏览器

项目不依赖第三方 npm 包，无需运行 `npm install`。

## 启动

### macOS

双击应用（请保留在项目文件夹中）：

```text
双击打开.app
```

后台运行，不需要保留终端窗口。关闭最后一个 EventLens 网页约 10 秒后，服务自动退出；刷新页面或保留其他活动标签页不会退出。若浏览器未打开，服务在约 90 秒后退出。退出后再次双击应用即可启动，监控与快照仍保存在本地。

启动器会检查本项目的运行版本，代码更新后自动替换旧服务。网页、脚本和样式不再缓存，资源地址也带版本，避免浏览器继续显示旧界面。

旧的 `.command` 文件保留兼容入口，但 macOS 仍会为它们短暂打开终端；日常请使用 `.app`。首次从旧版本升级，若原有终端服务占用端口，请先关闭该终端窗口。

如果首次运行被 macOS 拦截，请右键应用并选择“打开”。也可以在终端运行（此模式保持运行，不随页面关闭）：

```bash
./start.sh
```

### Windows

双击：

```text
start.bat
```

### 命令行

```bash
node server.js
```

然后打开：

```text
http://127.0.0.1:3000
```

以上本地启动方式仅监听 `127.0.0.1`，不会接受局域网或公网连接。

### Linux 服务器（IP + 端口访问）

推荐使用一键安装包，上传服务器后执行：

```bash
sudo bash EventLens-Linux-v2.1.2.run 你的服务器公网IPv4 3000 网页用户名
```

随后隐藏输入网页密码；也支持在用户名后增加第四个参数作为密码。脚本自动准备运行环境、浏览器和开机启动，安装成功后通过 `http://你的服务器公网IPv4:3000` 访问。完整上传、安装、端口放行和排错步骤见 [Linux 小白安装教程](LINUX-安装教程.md)。安装包由 `npm run package:linux` 生成，使用本地完整源码，不依赖 GitHub 上是否已同步。

以下是保留的手动启动与部署方式：

在服务器安装 Node.js 22+ 和 Chrome、Brave 或 Chromium，以普通用户进入项目目录运行：

```bash
PORT=3000 npm run start:server
```

也可使用 `PORT=3000 node server.js --server`，或设置 `EVENTLENS_SERVER=1` 后运行 `node server.js`。服务器模式监听 `0.0.0.0`；放行服务器防火墙和云安全组对应的 TCP 端口后，在其他电脑打开 `http://<服务器IP>:3000`。

服务器模式下，关闭网页不会停止服务，桌面自动退出接口也不会启用。原有自动更新开关、采集并发和数据保存规则保持不变。浏览器采集应以普通用户运行，避免 Chromium 拒绝 root 用户启动。

可选设置页面访问密码，用户名默认 `eventlens`，也可通过 `EVENTLENS_ACCESS_USERNAME` 自定义。在 Bash 中输入密码，不把密码写进命令历史：

```bash
read -rsp '设置页面访问密码：' EVENTLENS_ACCESS_PASSWORD
printf '\n'
export EVENTLENS_ACCESS_PASSWORD
export EVENTLENS_ACCESS_USERNAME=webadmin
PORT=3000 npm run start:server
```

密码保护覆盖页面、静态资源和全部 API。不设置时，能连接该端口的人可直接使用页面。公网密码访问请通过 HTTPS 反向代理，避免 HTTP 明文传输。

手动部署需要开机启动和进程退出后自动重启时，可使用 systemd。一键安装包已自动完成此配置，其实际路径见安装教程；以下为手动部署示例，假定项目在 `/opt/eventlens`，已创建普通用户 `eventlens`，该用户对 `data/` 有写权限，Node 位于 `/usr/bin/node`：

```ini
# /etc/systemd/system/eventlens.service
[Unit]
Description=EventLens
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=eventlens
WorkingDirectory=/opt/eventlens
ExecStart=/usr/bin/node /opt/eventlens/server.js --server
Environment=PORT=3000
Environment=NODE_ENV=production
EnvironmentFile=-/etc/eventlens.env
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

如需密码，将 `EVENTLENS_ACCESS_PASSWORD` 保存在仅管理员可读取的 `/etc/eventlens.env` 中。保存服务文件后启用：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now eventlens
```

## 数据位置

运行数据位于：

```text
data/campaigns.json
data/snapshots.json
data/snapshot-history.json
data/settings.json
```

一键安装包使用 `/var/lib/eventlens` 保存这些运行数据，网页账号配置保存在 `/etc/eventlens/eventlens.env`，仅管理员可读。

首次启动时会从以下种子文件建立运行数据：

```text
data/seed-campaigns.json
data/seed-snapshots.json
```

JSON 写入采用串行队列、临时文件和原子替换。发现 JSON 损坏时会保留 `.corrupt-*` 备份并停止覆盖，而不是静默重置数据。

## 排行榜准确性

采集流程：

1. 打开指定活动的主奖池页面。
2. 只接受当前页面实际请求过的 Resource ID。
3. 获取排行榜全部分页。
4. 按公开参与者标识去重，校验首名为 1、展示排名单调不降且交易量单调不升；允许币安真实存在的并列名次。
5. 校验实际记录数与官方分页总数；抓取期间人数变化时从第 1 页完整重试一次。
6. 使用微美元整数单位累计交易量，并与官方聚合总量核对；只允许一美分或逐行微单位精度范围内的微小差异。
7. 完整性校验通过后才覆盖最新快照。

任何分页缺失、参与者重复或人数不一致都会判定为失败，并保留上一次成功快照。

## 成本模型

上榜记录直接视为满足活动资格，不在本地重复校验 500 U 最低交易量。后段奖励卡片模拟从零新增一名参与者，且假设其他人的交易量不变；模拟量达到当前排名奖励门槛时，提示查看阶梯奖励，不再套用后段公式或显示后段净收益。均分奖池按新增一人计算，比例奖池按新增交易量计算；无上限与零上限分别处理。

缺失的门槛和行情显示为未知。不同奖励币分别取价；未识别的分配方式、多主奖池歧义和排名边界并列会暂停收益估算，保留快照与规则供核对。

按用户设定，成本模型保持简单：

- 成交手续费：`交易量 × 基础费率 × (1 - 返佣比例)`
- 买卖价差：使用当前买一和卖一简单估算
- 不模拟多档订单簿和大额订单冲击

因此页面使用“买卖价差成本估算”，不宣称是真实深度滑点。奖励与币对成本统一使用“榜单计入量”口径；顶部基础手续费则明确标为“实际成交量”口径。

## 安全设计

- 默认仅允许回环地址访问，显式开启服务器模式后允许远程访问，可配置访问密码。
- 所有添加、删除、写快照和触发爬虫操作都需要当前页面的随机会话令牌。
- 拒绝跨站写操作。
- 支持 HTTPS 公网域名下的交易赛活动链接，保存原始录入链接；抓榜时通过 `www.bsmkweb.cc` 动态适配域名，保留原活动路径和子赛道，并校验动态目标的公网地址。
- 拒绝本机、内网、IP 地址、带登录信息和异常端口的活动链接；启动抓榜前校验域名解析结果。规则仍从币安公告按活动 ID 匹配，未知规则标为待核对。
- 静态文件访问被限制在 `public/` 目录内。
- 不读取币安账户、API Key、钱包、登录凭据或私人交易记录。

## 测试

默认测试全部使用临时目录和固定 Fixture，不修改个人运行数据：

```bash
npm test
```

真实币安网络与本地浏览器采集测试单独执行：

```bash
npm run test:live
```

## 打包

```bash
npm run package
```

生成：

```text
dist/EventLens-Local-v2.1.2.zip
```

## 数据与风险说明

- 本项目为非官方工具。
- 公告解析结果应以币安原始公告为准。
- 排行榜可能延迟更新或在活动结束后修正。
- 奖励、手续费、返佣和价差均为估算，不构成投资建议。

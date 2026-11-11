# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-11-12

### Changed

- **收紧 helper 的固定等待**：`lib/index.js` 写进 handoff 的 `delayMs` 从 1200ms 降到 300ms；本机回环端口探测超时从 1200ms 降到 600ms；等日志里出现新 URL 的轮询从 400ms 降到 250ms。`WEB_URL_TIMEOUT_MS` 仍是 90 秒——宿主重新加载整组插件要十几秒，这一段不属于插件。
- **README / About 把「重启后自动打开新 token 的链接」提到最前面作为第一卖点**，并说明 web 版的 cookie 在用户浏览器里、插件碰不到也不需要碰（清理 `dsh-auth-*` 是桌面版的职责）。
- README 头部加 npm 版本 / 周下载 / GitHub stars / license 四个 badge 和中英双语 Star 提示。

## [0.1.4] - 2026-11-04

### Changed

- **去掉常驻横幅**（0.1.5 刚加的）：它太吵，而且不是必要手段。改成**按下刷新快捷键的那一刻按需检查**——`Cmd/Ctrl+R`、`F5` 会先比一次 bundle 版本，有变化就弹确认框，没变化照常刷新。这样反而更准：不再有"最多 30 秒"的空窗，也不需要在界面上常驻一条警告。
- `beforeunload` 保留：菜单栏、地址栏、右键菜单触发的刷新接不到 keydown，只能靠它兜底。

## [0.1.3] - 2026-11-04

### Added

- **刷新前先劝你去重启。** 插件的 `client.js` 在应用运行期间被改过时，刷新渲染层会让它加载失败（宿主在**启动时**生成 manifest，每个 bundle 的 revision 记在里面，刷新只重载渲染层、不重算 manifest），症状是一行 `1 entry did not activate` 加一个 `import failed`，只能整应用重开。现在三处一起挡：
  - **常驻横幅**：每 30 秒、以及窗口重新获得焦点时各比一次 bundle 版本，发现漂移就在顶部挂一条「插件代码已变（N 个），刷新会让它们加载失败。请退出应用重开」，带「重启应用」按钮。这是主要手段——看到就不会去刷新了。
  - **快捷键拦截**：漂移时 `Cmd/Ctrl+R`、`F5` 改弹原来的确认框（重启 / 仍然刷新 / 取消），不再静默刷新。
  - **`beforeunload`**：菜单栏、地址栏、右键菜单触发的刷新接不到 keydown，用这道兜底。

## [0.1.2] - 2026-11-03

### Changed

- **`Failed to fetch` 现在会说清是哪一半断了。** 浏览器只在"请求根本没到服务器"时才抛这句话——没有状态码、没有响应体，什么线索都没有。现在失败后会拿同源的 `GET /api/dsh-power-menu-web/health` 再探一次，把结论直接写进提示：
  - GET 通 → 「同源 GET 正常，只有这次 POST 没到服务器：检查浏览器扩展或代理对 POST 的拦截」，并带上页面 origin；
  - GET 也不通 → 「这个页面连不上后端（origin）。它可能不是当前实例打开的——重新打开地址栏里的链接再试」。
- 提示停留时间从 7 秒延长到 12 秒（内容变多了，得留时间读）。

### 背景

实测踩到的情形：页面是从**远程中继**（`<instance>.dsh-market.com`）打开的，而电源接口只挂在本地 web 服务器上，中继上游那台根本没有这些路由——请求在浏览器侧就失败了，插件日志一行都不会有。这种情况下按钮永远点不通（而且 `trusted()` 只认 loopback 的 Host/Origin，本来也拒），提示里那句 origin 就是给人看这个的。

## [0.1.1] - 2026-11-01

### Fixed

- **`enable.sh` 默认 profile 改成 `web`**，并支持 `DSH_PROFILE_ROOT` / 覆盖 `HOME` 定位 profile。原来写死 `$HOME/.dsh/profiles`，而 `dsh web` 的部署常把 `HOME` 指到别处（如 `~/fish2`），脚本会去一个不存在的位置找 `package.json`，报「找不到」却不说该往哪儿找。
- `enable.sh` 的可用 profile 列表之前打印不出来（重定向顺序写成 `2>/dev/null >&2`，stdout 被一起送进 `/dev/null`）。

## [0.1.0] - 2026-11-01

首个版本。从 `dsh-power-menu-mac` 0.1.4 拆出来，去掉桌面版那半边，只做 `dsh web`。

### Added

- **刷新**：只重载渲染层。点之前先比对 profile 里各插件 `exports["./client"]` 的 `mtime:size`（`GET /api/dsh-power-menu-web/bundles`）：有文件变过就弹框列出改动的插件，给「重启 / 仍然刷新 / 取消」三个选择——DSH 的 client bundle 按 revision 发布且不可变，旧 revision 会被直接拒绝，刷新换来的是一整页「请关闭应用并重新安装」。
- **重启**：macOS 走 `launchctl kickstart -k`、Linux 走 `systemctl restart`、没有 supervisor 就自己杀掉再拉起。三条路最后都会把新进程打印的 `dsh web: http://…?token=…` 抓出来并**自动在浏览器打开**——每次启动 token 都会换，不打开就得自己去日志里翻。`DSH_POWER_MENU_NO_OPEN=1` 可关掉。
- **关闭**：macOS `launchctl bootout`、Linux `systemctl stop`、无 supervisor 直接结束进程。前两种是**真关**（不会被 KeepAlive / Restart=always 立刻拉回来）。
- **定时**：居中弹窗，可设「N 分钟后重启」「N 分钟后关闭」；有 supervisor 时「现在关闭，N 分钟后启动」自动收起。排定后按钮下方出现每秒跳的倒计时胶囊，右侧 × 直接取消；等待期间服务被手动关掉或重启过，这条定时按 pid 比对自动作废。
- **配置页**：插件管理页里这一行多了配置控件（`plugins.row.config`，key 为 `dsh-power-menu-web#dsh-power-menu-web`），可改默认分钟数、开关提示词注入、替换提示词正文。
- **系统提示词注入**：告诉模型「DSH 的重启与关闭由用户自己点电源菜单」，不再询问。可在配置页关掉或换掉。
- **跨平台**：`os` 声明 `darwin` / `linux` / `win32`。

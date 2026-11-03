# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

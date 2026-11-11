# dsh-power-menu-web

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-power-menu-web"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-power-menu-web?color=4d6bfe"></a>
  <a href="https://www.npmjs.com/package/dsh-power-menu-web"><img alt="npm downloads" src="https://img.shields.io/npm/dw/dsh-power-menu-web"></a>
  <a href="https://github.com/DDDMUC/dsh-power-menu-web/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/DDDMUC/dsh-power-menu-web?color=eac54f"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/npm/l/dsh-power-menu-web"></a>
</p>

> ⭐ **如果这个项目对你有帮助，欢迎点个 Star 支持一下。**
>
> ⭐ **If you find this project useful, a star is appreciated.**

给 **`dsh web` 部署**加一个右上角电源按钮：**刷新 / 重启 / 定时 / 关闭**。

> 只服务 `dsh web`（浏览器界面）。桌面版请用 [dsh-power-menu-mac](https://github.com/DDDMUC/dsh-power-menu-mac) 或 [dsh-power-menu-win](https://github.com/DDDMUC/dsh-power-menu-win)。

**macOS · Linux · Windows** 都能用 —— 但"重启"的实现各不相同，见下表。

## 为什么需要它

`dsh web` 改完插件/配置要重启宿主，而宿主在后台跑着：没有按钮就只能回终端敲命令。

更要紧的是：**`dsh web` 每次启动都生成一个新的 token**，浏览器拿它换一次签名 cookie 之后就作废。所以"重启"如果只是把进程杀掉再起来，你手上的链接当场失效，只能去日志里翻新的一行。这个插件会把新链接**直接打开**。

## 三个平台怎么重启

| 平台 | 谁负责拉起 | 「重启」 | 「关闭」 |
| --- | --- | --- | --- |
| **macOS** | launchd 作业 | `launchctl kickstart -k`，然后从作业日志里抓新链接 | `launchctl bootout`（真关，不会自己回来） |
| **Linux** | systemd 单元 | `systemctl restart`（单元名从 cgroup 取） | `systemctl stop` |
| **Windows** / 无 supervisor | 没有 | 自己杀掉 → 等端口释放 → 用原 argv 重新 spawn | 结束进程 |

判断"有没有 supervisor"不是看环境变量就完事：

- `XPC_SERVICE_NAME` 会一路继承给子进程（终端里起的 `dsh web` 带的是终端自己的作业名），所以还要回查 `launchctl print` 里那个作业的 pid 是不是本进程；
- Linux 用 `INVOCATION_ID`（systemd 注入）+ `/proc/self/cgroup` 里的单元名。

## 装

```sh
npm i dsh-power-menu-web          # 或在插件管理页里装
node_modules/dsh-power-menu-web/enable.sh web   # 补进 dsh.profile.bundles，然后重启宿主
```

`enable.sh` 只做一件事：把 `dsh-power-menu-web` 补进指定 profile 的 `dsh.profile.bundles`（写之前备份 `package.json`）。少了这一步宿主半不会加载，点按钮就是 404。

**profile 不在 `~/.dsh` 下的话**（部署把 `HOME` 指到别处，比如 `~/fish2`）：

```sh
HOME=~/fish2 node_modules/dsh-power-menu-web/enable.sh web
# 或
DSH_PROFILE_ROOT=~/fish2/.dsh/profiles node_modules/dsh-power-menu-web/enable.sh web
```

## 四项

- **刷新**：只重载这一层页面。**点之前会先比对插件文件**：某个 `client.js` 在你打开页面之后被改过时，刷新会让它加载失败（DSH 的 bundle 按 revision 发布且不可变），这时会弹框列出改动的插件，建议改走重启。
- **重启**：见上表。新链接会自动在浏览器打开。
- **定时**：居中弹窗，填分钟数后可选「N 分钟后重启」「N 分钟后关闭」。有 supervisor 时「现在关闭，N 分钟后启动」会收起（杀掉会被立刻拉回来，自己再 spawn 会抢端口）。排定后按钮下方出现每秒跳的倒计时胶囊。
- **关闭**：见上表。**注意**：没有 supervisor 时，关掉就真的没了，只能手动再起。

## 配置

**在插件管理页里改**：插件列表 → `dsh-power-menu-web` → 组件行右侧的**配置**控件。

也可以直接改 `~/.dsh/dsh-power-menu-web/config.json`（第一次读取时自动生成）：

```json
{
  "delayedRestartMinutes": 10,
  "restartGuidance": true,
  "restartGuidanceText": ""
}
```

| 字段 | 作用 | 合法值 |
| --- | --- | --- |
| `delayedRestartMinutes` | 定时弹窗输入框的默认分钟数 | 1–1440 的整数；其它值一律回落 10 |
| `restartGuidance` | 是否注入系统提示词 | 只有显式 `false` 才关 |
| `restartGuidanceText` | 提示词正文 | 与默认一字不差时存为空串（＝跟随默认）；超过 2000 字截断 |

## 无头部署

设 `DSH_POWER_MENU_NO_OPEN=1` 就不去打开浏览器 —— 重启照常进行，新链接会写在 helper 日志里：

```
$HOME/.dsh/dsh-power-menu-web/helper-restart-*.log
$HOME/.dsh/dsh-power-menu-web/helper-restart-*.web.log   # 自己 spawn 时子进程的输出
```

systemd 部署下输出进 journal，重启后请用 `journalctl -u <单元>` 取新链接。

## 安全

- 所有接口只监听回环地址，并做同源校验（loopback socket + loopback Host + 非跨站 fetch）。
- 没有遥测、没有外部请求。
- 会执行 `launchctl` / `systemctl` / `spawn` —— 这是它存在的理由，请只装在你能信任的机器上。

## 致谢

菜单的视觉与交互沿用 [dsh-power-menu](https://github.com/xichen-62/dsh-power-menu)（MIT）。

## 许可证

MIT

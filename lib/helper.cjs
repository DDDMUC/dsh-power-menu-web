'use strict'

/**
 * dsh-power-menu-web — detached handoff helper.
 *
 * Runs as Electron's Node mode (`ELECTRON_RUN_AS_NODE=1`) on the desktop build,
 * or as the same runtime the host uses elsewhere; either way it is a separate
 * process, which is the whole point: it has to outlive the host it restarts.
 *
 * The host cannot restart itself. It can only hand the job to this file and let
 * the HTTP response go out first, so the browser sees "accepted" instead of a
 * dropped connection.
 *
 * Three deployments, three ways to come back:
 *
 *   macOS   launchd job  → `launchctl kickstart -k` (and `bootout` to really stop)
 *   Linux   systemd unit → `systemctl restart` (and `stop` to really stop)
 *   other   nobody        → kill the host, wait for the port, spawn it again
 *
 * Every restart ends with a fresh `dsh web: http://…?token=…` line — the token
 * changes on each boot — which is opened in the browser so the user does not
 * have to go digging in a log. `DSH_POWER_MENU_NO_OPEN=1` turns that off for
 * headless deployments.
 */

const { execFileSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const MAIN_EXIT_TIMEOUT_MS = 15000
const PORT_FREE_TIMEOUT_MS = 30000
// 重启后等新 URL 的时间：进程要重新加载整组插件，实测十几秒。
const WEB_URL_TIMEOUT_MS = 90000
const MAX_LOG_BYTES = 1000000

let LOG_PATH = path.join(os.tmpdir(), 'dsh-power-menu-web-helper.log')

function rotateLog(file) {
  try {
    if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`)
  } catch {
    /* 不存在就无所谓 */
  }
}

function note(line) {
  const text = `[${new Date().toISOString()}] ${line}\n`
  try {
    rotateLog(LOG_PATH)
    fs.appendFileSync(LOG_PATH, text, 'utf8')
  } catch {
    /* 日志失败不能影响动作 */
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/** SIGTERM, then SIGKILL as a backstop. Works the same on all three platforms. */
function killPid(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 'SIGTERM')
    return true
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
      return true
    } catch {
      return false
    }
  }
}

/** Is anything still listening on this port? */
function listening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    const done = (result) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(1200)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

async function waitFor(predicate, timeoutMs, stepMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(stepMs)
  }
  return false
}

/** 用户看得见的一句提示；没有 GUI 的平台就只写日志。 */
function alertUser(text) {
  note(`alert: ${text.replace(/\n+/gu, ' | ')}`)
  if (process.platform !== 'darwin') return false
  try {
    const script = `display notification ${JSON.stringify(text)} with title "DSH 电源菜单"`
    execFileSync('/usr/bin/osascript', ['-e', script], { stdio: 'ignore', timeout: 5000 })
    return true
  } catch {
    return false
  }
}

/**
 * 打开浏览器。三个平台的命令各不相同，任何一个失败都只记日志 —— 链接本身会
 * 留在日志里，用户还能自己复制。
 */
function openUrl(url) {
  if (typeof url !== 'string' || !/^https?:\/\//u.test(url)) return false
  if (process.env.DSH_POWER_MENU_NO_OPEN === '1') {
    note('web: auto-open disabled by DSH_POWER_MENU_NO_OPEN')
    return false
  }
  const command = process.platform === 'darwin'
    ? ['/usr/bin/open', [url]]
    : process.platform === 'win32'
      ? ['cmd.exe', ['/c', 'start', '', url]]
      : ['xdg-open', [url]]
  try {
    execFileSync(command[0], command[1], { stdio: 'ignore', timeout: 8000 })
    note(`web: opened ${url}`)
    return true
  } catch (error) {
    note(`web: could not open the browser: ${String(error?.message ?? error)}`)
    return false
  }
}

/** launchd 作业的 StandardOutPath；拿不到就返回 null（那就不指望能抓到 URL）。 */
function launchdLogPath(label) {
  if (typeof label !== 'string' || label === '') return null
  const homes = []
  try {
    const real = os.userInfo().homedir
    if (typeof real === 'string' && real !== '') homes.push(real)
  } catch {
    /* 拿不到 passwd 条目就只试 $HOME */
  }
  homes.push(os.homedir())
  for (const home of [...new Set(homes)]) {
    const plist = path.join(home, 'Library', 'LaunchAgents', `${label}.plist`)
    if (!fs.existsSync(plist)) continue
    try {
      const out = execFileSync('/usr/bin/plutil', ['-extract', 'StandardOutPath', 'raw', '-o', '-', plist], {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      if (out !== '') return out
    } catch {
      /* 试下一个家目录 */
    }
  }
  return null
}

/** 从某个偏移开始，等日志里出现新的一行 `dsh web: http…`。 */
async function waitForWebUrl(file, fromOffset, timeoutMs) {
  if (typeof file !== 'string' || file === '') return null
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const size = fs.statSync(file).size
      if (size > fromOffset) {
        const fd = fs.openSync(file, 'r')
        const length = Math.min(size - fromOffset, 256 * 1024)
        const buffer = Buffer.alloc(length)
        fs.readSync(fd, buffer, 0, length, fromOffset)
        fs.closeSync(fd)
        const matches = [...buffer.toString('utf8').matchAll(/dsh web: (https?:\/\/\S+)/gu)]
        if (matches.length > 0) return matches[matches.length - 1][1]
      }
    } catch {
      /* 文件还没出现，继续等 */
    }
    await sleep(400)
  }
  return null
}

function fileSize(file) {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

function launchdDomain() {
  return `gui/${String(typeof process.getuid === 'function' ? process.getuid() : 501)}`
}

/**
 * 关掉服务，并且**不让它被拉回来**。
 *
 * 有 supervisor 就交给它（launchd bootout / systemd stop）；没有就直接结束进程
 * —— 那时没有任何东西会救它，这正是用户点「关闭」时应得的结果。
 */
async function performShutdown(handoff) {
  const supervisor = handoff.supervisor ?? null
  if (supervisor !== null && supervisor.kind === 'launchd') {
    try {
      execFileSync('/bin/launchctl', ['bootout', `${launchdDomain()}/${supervisor.label}`], {
        stdio: 'ignore',
        timeout: 15000,
      })
      note(`shutdown: booted out ${supervisor.label}`)
      return
    } catch (error) {
      note(`shutdown: bootout failed (${String(error?.message ?? error)}); falling back to a signal`)
    }
  }
  if (supervisor !== null && supervisor.kind === 'systemd') {
    for (const args of [['stop', supervisor.label], ['--user', 'stop', supervisor.label]]) {
      try {
        execFileSync('systemctl', args, { stdio: 'ignore', timeout: 20000 })
        note(`shutdown: systemctl ${args.join(' ')} ok`)
        return
      } catch {
        /* 换一种权限再试 */
      }
    }
    note('shutdown: systemctl stop failed; falling back to a signal')
  }
  const killed = killPid(handoff.mainPid)
  note(killed ? `shutdown: ended host ${handoff.mainPid}` : `shutdown: could not end host ${handoff.mainPid}`)
  await waitFor(() => !alive(handoff.mainPid), MAIN_EXIT_TIMEOUT_MS, 200)
}

/**
 * 重启。
 *
 * 有 supervisor 就让它重启（这样进程树、日志、资源限制都保持原样），然后从它
 * 的日志里抓新 token 的 URL；没有就自己杀掉、等端口释放、用原来的 argv 重新
 * spawn，把子进程输出接到一个文件里再抓 URL。
 */
async function performRestart(handoff) {
  const supervisor = handoff.supervisor ?? null

  if (supervisor !== null && supervisor.kind === 'launchd') {
    const logPath = launchdLogPath(supervisor.label)
    const from = fileSize(logPath)
    note(`restart: kickstart ${supervisor.label} (launchd)`)
    try {
      execFileSync('/bin/launchctl', ['kickstart', '-k', `${launchdDomain()}/${supervisor.label}`], {
        stdio: 'ignore',
        timeout: 20000,
      })
    } catch (error) {
      note(`restart: kickstart failed: ${String(error?.message ?? error)}`)
    }
    const url = await waitForWebUrl(logPath, from, WEB_URL_TIMEOUT_MS)
    if (url === null) {
      note('restart: no new URL in the launchd log')
      alertUser(`已重启，但没抓到新链接。请从日志里取：${logPath ?? '(launchd StandardOutPath)'}`)
      return
    }
    openUrl(url)
    note('restart: complete')
    return
  }

  if (supervisor !== null && supervisor.kind === 'systemd') {
    // systemd 把输出接到 journal，抓不到 URL；重启本身交给它，链接让用户去
    // journalctl 里取（提示里给出确切命令）。
    note(`restart: systemctl restart ${supervisor.label} (systemd)`)
    let done = false
    for (const args of [['restart', supervisor.label], ['--user', 'restart', supervisor.label]]) {
      try {
        execFileSync('systemctl', args, { stdio: 'ignore', timeout: 30000 })
        note(`restart: systemctl ${args.join(' ')} ok`)
        done = true
        break
      } catch {
        /* 换一种权限再试 */
      }
    }
    if (!done) {
      note('restart: systemctl restart failed; falling back to a self-respawn')
    } else {
      alertUser(`已重启。新链接在 journalctl -u ${supervisor.label} 的最后一行。`)
      return
    }
  }

  // 没人管，或者 supervisor 没接住：自己来。
  note('restart: ending the host and relaunching it from here')
  killPid(handoff.mainPid)
  await waitFor(() => !alive(handoff.mainPid), MAIN_EXIT_TIMEOUT_MS, 200)
  if (Number.isInteger(handoff.port) && handoff.port > 0) {
    const free = await waitFor(async () => !(await listening(handoff.port)), PORT_FREE_TIMEOUT_MS, 300)
    note(free ? `restart: port ${handoff.port} released` : `restart: port ${handoff.port} still held`)
  }

  const argv = Array.isArray(handoff.argv) ? handoff.argv : []
  if (argv.length === 0 || typeof handoff.exe !== 'string' || handoff.exe === '') {
    note('restart: the handoff carries no argv/exe; cannot relaunch')
    alertUser('重启失败：交接信息里没有完整的启动命令。请手动执行 dsh web。')
    return
  }

  const capturePath = typeof handoff.logPath === 'string' && handoff.logPath !== ''
    ? handoff.logPath.replace(/\.log$/u, '') + '.web.log'
    : path.join(os.tmpdir(), 'dsh-power-menu-web-relaunch.log')
  let fd = null
  try {
    fd = fs.openSync(capturePath, 'a')
  } catch (error) {
    note(`restart: cannot open ${capturePath}: ${String(error?.message ?? error)}`)
  }
  const from = fileSize(capturePath)

  try {
    const child = spawn(handoff.exe, argv, {
      detached: true,
      stdio: fd === null ? 'ignore' : ['ignore', fd, fd],
      cwd: typeof handoff.cwd === 'string' && handoff.cwd !== '' ? handoff.cwd : undefined,
      // ELECTRON_RUN_AS_NODE 必须留着：dsh 的入口就是这个二进制以 node 模式跑。
      env: { ...process.env },
    })
    child.on('error', (error) => note(`restart: spawn error: ${String(error?.message ?? error)}`))
    child.unref()
    note(`restart: relaunched ${handoff.exe} ${argv.join(' ')} as pid ${String(child.pid)}`)
  } catch (error) {
    note(`restart: spawn threw: ${String(error?.stack ?? error)}`)
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        /* already closed */
      }
    }
  }

  const url = await waitForWebUrl(capturePath, from, WEB_URL_TIMEOUT_MS)
  if (url === null) {
    note(`restart: no URL in ${capturePath} after ${String(WEB_URL_TIMEOUT_MS)}ms`)
    alertUser(`已重启，但没抓到新链接。日志：${capturePath}`)
    return
  }
  openUrl(url)
  note('restart: complete')
}

function selfTest() {
  const problems = []
  if (typeof process.execPath !== 'string' || process.execPath === '') problems.push('no execPath')
  if (typeof os.homedir() !== 'string' || os.homedir() === '') problems.push('no home directory')
  for (const problem of problems) console.error(`FAIL ${problem}`)
  if (problems.length === 0) console.log(`ok ${process.platform} ${process.execPath}`)
  return problems.length === 0
}

async function main() {
  if (process.argv[2] === '--selftest') {
    process.exit(selfTest() ? 0 : 1)
  }

  const handoffPath = process.argv[2]
  if (typeof handoffPath !== 'string' || handoffPath === '') process.exit(1)

  let handoff
  try {
    handoff = JSON.parse(fs.readFileSync(handoffPath, 'utf8'))
  } catch {
    process.exit(1)
  }

  LOG_PATH = typeof handoff.logPath === 'string' && handoff.logPath !== ''
    ? handoff.logPath
    : path.join(path.dirname(handoffPath), 'helper.log')

  note(`helper started: helper=${process.pid} host=${String(handoff.mainPid)} mode=${String(handoff.mode)}`)

  try {
    if (!Number.isInteger(handoff.mainPid) || handoff.mainPid <= 1) {
      note('refusing: the handoff carries no usable host pid')
      return
    }

    // 定时动作：先什么都不做，等够时间再动手。等待期间服务可能被手动关掉或重启
    // 过 —— 那时这条定时就已经作废了，绝不能拿一个旧的 pid 去动别的进程。
    const preDelayMs = Number.isFinite(handoff.preDelayMs) && handoff.preDelayMs > 0 ? handoff.preDelayMs : 0
    if (preDelayMs > 0) {
      note(`scheduled: waiting ${Math.round(preDelayMs / 1000)}s before acting`)
      await sleep(preDelayMs)
      if (!alive(handoff.mainPid)) {
        note('scheduled: the host is not running any more; dropping the schedule')
        return
      }
      note('scheduled: delay elapsed, acting now')
    }

    await sleep(Number.isFinite(handoff.delayMs) && handoff.delayMs > 0 ? handoff.delayMs : 1200)

    if (handoff.mode === 'restart') await performRestart(handoff)
    else await performShutdown(handoff)
  } catch (error) {
    note(`helper failed: ${String(error?.stack ?? error)}`)
  } finally {
    try {
      fs.unlinkSync(handoffPath)
    } catch {
      /* already gone */
    }
  }
}

if (require.main === module) {
  main().catch(() => {
    process.exitCode = 0
  })
}

module.exports = { waitForWebUrl, launchdLogPath, launchdDomain, openUrl, selfTest }

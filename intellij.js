'use strict'

const fs = require('fs')
const path = require('path')
const sh = require('shell-exec')
const getSignal = require('./signal')

const isWindows = () => process.platform === 'win32'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// Matching is structural, never a plain substring search of a command line: a
// shell, editor or grep that merely mentions these strings must not match.
//
// Recent IntelliJ IDEA runs as a native launcher (<install>/bin/idea) that
// hosts the JVM itself; older ones run `java ... com.intellij.idea.Main`, a
// class every JetBrains IDE shares, so those are told apart by the config
// selector / vmoptions file passed to the JVM. Other IDEs (PyCharm,
// WebStorm...) are left alone.
const mainClass = /\scom\.intellij\.idea\.Main(\s|$)/
const ideaMarkers = [
  /\s-Didea\.paths\.selector=(IntelliJIdea|IdeaI[CU])/,
  /[\\/]idea(64)?\.vmoptions/
]
const javaExecutable = /^(\S*[\\/])?javaw?(\.exe)?\s/
const nativeLauncher = /^(\/.+)\/bin\/idea(\.sh)?$/
const installDirName = /(intellij-idea|idea-I[CU]|IntelliJ IDEA)/i
// macOS runs the IDE as the app's native launcher; `comm` is its exact path.
const macExecutable = /^(\/.*\/IntelliJ IDEA[^/]*\.app)\/Contents\/MacOS\/idea$/
const windowsImage = /^idea(64)?\.exe$/i

const executable = command => command.split(/\s/)[0]

// An install directory counts only if it says so itself: product-info.json
// names the product, and without one the directory name has to. A stray
// /usr/local/bin/idea must never turn /usr/local into "the IDE".
function isIdeaInstall (dir) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(dir, 'product-info.json'), 'utf8'))
    return /IntelliJ IDEA/i.test(String(info.name))
  } catch (error) {
    if (error.code === 'ENOENT') return installDirName.test(path.basename(dir))
    return false
  }
}

// Directories whose executables belong to the IDE instance behind `command`
// (the launcher, fsnotifier, the JCEF helpers...). Empty if it is not one.
function installDirs (command, platform = process.platform) {
  if (platform === 'darwin') {
    const match = macExecutable.exec(command)
    return match ? [match[1]] : []
  }
  const match = nativeLauncher.exec(executable(command))
  if (!match || !isIdeaInstall(match[1])) return []
  const dirs = [match[1]]
  try {
    const real = fs.realpathSync(match[1])
    if (real !== match[1]) dirs.push(real)
  } catch (error) {}
  return dirs
}

// `command` is the full command line on Linux and the executable path on macOS.
function isIntelliJ (command, platform = process.platform) {
  if (installDirs(command, platform).length > 0) return true
  if (platform === 'darwin') return false
  return javaExecutable.test(command) && mainClass.test(command) &&
    ideaMarkers.some(marker => marker.test(command))
}

function checkResult (res) {
  if (res.error) throw res.error
  if (res.code !== 0) throw new Error(res.stderr || `Command failed: ${res.cmd}`)
  return res.stdout
}

// `knownDirs`: install dirs learned by an earlier scan. They keep helpers
// recognisable after the main process (the only thing naming the install
// dir) has already exited.
async function scan (knownDirs = []) {
  let processes = []
  const dirs = new Set(knownDirs)
  if (isWindows()) {
    const output = checkResult(await sh('tasklist /FO CSV /NH'))
    for (const line of output.split(/\r?\n/)) {
      const match = line.match(/^"([^"]+)","(\d+)"/)
      if (match && windowsImage.test(match[1])) processes.push({ pid: Number(match[2]), command: match[1] })
    }
  } else {
    // -ww: never truncate the command line, or the markers could be cut off.
    const column = process.platform === 'darwin' ? 'comm' : 'args'
    const output = checkResult(await sh(`ps -axww -o pid=,${column}=`))
    const all = []
    for (const line of output.split(/\r?\n/)) {
      const match = line.match(/^\s*(\d+)\s+(.*)$/)
      if (match) all.push({ pid: Number(match[1]), command: match[2] })
    }
    for (const { command } of all) installDirs(command).forEach(dir => dirs.add(dir))
    // The IDE plus the helpers it runs from its own install directory. After
    // the main process dies these keep running and can block a restart.
    const inInstall = command => {
      const exe = executable(command)
      return Array.from(dirs).some(dir => exe.startsWith(dir + '/'))
    }
    processes = all.filter(({ command }) => isIntelliJ(command) || inInstall(command))
  }
  // Never target this very process, whatever its command line looks like.
  return { processes: processes.filter(({ pid }) => pid !== process.pid), dirs: Array.from(dirs) }
}

const find = async () => (await scan()).processes

function send (processes, signal) {
  const failed = []
  for (const { pid } of processes) {
    try {
      process.kill(pid, signal)
    } catch (error) {
      // ESRCH: it already exited, which is the goal anyway.
      if (error.code !== 'ESRCH') failed.push({ pid, error })
    }
  }
  return failed
}

async function waitForExit (pids, dirs, seconds) {
  const deadline = Date.now() + seconds * 1000
  const stillRunning = async () => (await scan(dirs)).processes.filter(({ pid }) => pids.has(pid))
  let alive = await stillRunning()
  while (alive.length > 0 && Date.now() < deadline) {
    await sleep(500)
    alive = await stillRunning()
  }
  return alive
}

// Without an explicit signal: ask politely first (SIGTERM), then force
// (SIGKILL) whatever is still alive after `timeout` seconds. A hung IDE that
// ignores SIGTERM is exactly the case this exists for.
async function killIntelliJ ({ signal, timeout = 5, dryRun = false } = {}) {
  if (!Number.isFinite(timeout) || timeout < 0) throw new Error('Invalid timeout provided')
  if (signal !== undefined) getSignal(signal)

  const { processes: found, dirs } = await scan()
  if (found.length === 0 || dryRun) return { found, signalled: [], forced: [], failed: [] }

  const pids = new Set(found.map(({ pid }) => pid))
  // Windows cannot deliver graceful signals; process.kill terminates there.
  const first = signal || (isWindows() ? 'SIGKILL' : 'SIGTERM')
  let failed = send(found, first)
  const result = { found, signalled: Array.from(pids), forced: [], failed }

  if (signal !== undefined || first === 'SIGKILL') return result

  const survivors = await waitForExit(pids, dirs, timeout)
  if (survivors.length > 0) {
    result.forced = survivors.map(({ pid }) => pid)
    failed = failed.concat(send(survivors, 'SIGKILL'))
    result.failed = failed
    result.remaining = await waitForExit(new Set(result.forced), dirs, 3)
  }
  return result
}

const usage = 'Usage: kill-process intellij [--dry-run] [--signal SIGNAL] [--timeout SECONDS]'

function parseArgs (argv) {
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s)
    const value = () => inline !== undefined ? inline : argv[++i]
    if (flag === '--dry-run') options.dryRun = true
    else if (flag === '--signal') options.signal = value()
    else if (flag === '--timeout') options.timeout = Number(value())
    else throw new Error(`Unknown option ${argv[i]}`)
  }
  return options
}

async function cli (argv) {
  let result
  try {
    const options = parseArgs(argv)
    result = await killIntelliJ(options)
    if (result.found.length === 0) return console.log('No IntelliJ IDEA process is running.')
    if (options.dryRun) {
      console.log('Would kill (dry run):')
      return result.found.forEach(({ pid, command }) => console.log(`  ${pid}  ${command.slice(0, 120)}`))
    }
  } catch (error) {
    console.log(`Could not kill IntelliJ IDEA. ${error.message}.`)
    console.log(usage)
    process.exitCode = 1
    return
  }

  console.log(`Signalled IntelliJ IDEA process(es): ${result.signalled.join(' ')}`)
  if (result.forced.length > 0) console.log(`Still running after the grace period, force killed: ${result.forced.join(' ')}`)
  for (const { pid, error } of result.failed) console.log(`Could not signal PID ${pid}. ${error.message}.`)
  if (result.failed.length > 0 || (result.remaining && result.remaining.length > 0)) process.exitCode = 1
}

module.exports = { cli, killIntelliJ, isIntelliJ, find }

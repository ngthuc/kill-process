'use strict'

const sh = require('shell-exec')
const getSignal = require('./signal')

const isWindows = () => process.platform === 'win32'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// Every JetBrains IDE shares the com.intellij.idea.Main entry point, so the
// IntelliJ IDEA ones are told apart by the config selector / vmoptions file
// their launcher passes to the JVM. Other IDEs (PyCharm, WebStorm...) are left
// alone. Matching is structural, never a plain substring search of the command
// line: a shell, editor or grep that merely mentions these strings must not match.
const mainClass = /\scom\.intellij\.idea\.Main(\s|$)/
const ideaMarkers = [
  /\s-Didea\.paths\.selector=(IntelliJIdea|IdeaI[CU])/,
  /[\\/]idea(64)?\.vmoptions/
]
const javaExecutable = /^(\S*[\\/])?javaw?(\.exe)?\s/
// macOS runs the IDE as the app's native launcher; `comm` is its exact path.
const macExecutable = /^\/.*\/IntelliJ IDEA[^/]*\.app\/Contents\/MacOS\/idea$/
const windowsImage = /^idea(64)?\.exe$/i

// `command` is the full command line on Linux and the executable path on macOS.
function isIntelliJ (command, platform = process.platform) {
  if (platform === 'darwin') return macExecutable.test(command)
  return javaExecutable.test(command) && mainClass.test(command) &&
    ideaMarkers.some(marker => marker.test(command))
}

function checkResult (res) {
  if (res.error) throw res.error
  if (res.code !== 0) throw new Error(res.stderr || `Command failed: ${res.cmd}`)
  return res.stdout
}

async function find () {
  const processes = []
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
    for (const line of output.split(/\r?\n/)) {
      const match = line.match(/^\s*(\d+)\s+(.*)$/)
      if (match && isIntelliJ(match[2])) processes.push({ pid: Number(match[1]), command: match[2] })
    }
  }
  // Never target this very process, whatever its command line looks like.
  return processes.filter(({ pid }) => pid !== process.pid)
}

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

async function waitForExit (pids, seconds) {
  const deadline = Date.now() + seconds * 1000
  let alive = await find()
  alive = alive.filter(({ pid }) => pids.has(pid))
  while (alive.length > 0 && Date.now() < deadline) {
    await sleep(500)
    alive = (await find()).filter(({ pid }) => pids.has(pid))
  }
  return alive
}

// Without an explicit signal: ask politely first (SIGTERM), then force
// (SIGKILL) whatever is still alive after `timeout` seconds. A hung IDE that
// ignores SIGTERM is exactly the case this exists for.
async function killIntelliJ ({ signal, timeout = 5, dryRun = false } = {}) {
  if (!Number.isFinite(timeout) || timeout < 0) throw new Error('Invalid timeout provided')
  if (signal !== undefined) getSignal(signal)

  const found = await find()
  if (found.length === 0 || dryRun) return { found, signalled: [], forced: [], failed: [] }

  const pids = new Set(found.map(({ pid }) => pid))
  // Windows cannot deliver graceful signals; process.kill terminates there.
  const first = signal || (isWindows() ? 'SIGKILL' : 'SIGTERM')
  let failed = send(found, first)
  const result = { found, signalled: Array.from(pids), forced: [], failed }

  if (signal !== undefined || first === 'SIGKILL') return result

  const survivors = await waitForExit(pids, timeout)
  if (survivors.length > 0) {
    result.forced = survivors.map(({ pid }) => pid)
    failed = failed.concat(send(survivors, 'SIGKILL'))
    result.failed = failed
    result.remaining = await waitForExit(new Set(result.forced), 3)
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

/* eslint-env jest */
// Never list or signal real processes in the test suite.
jest.mock('shell-exec', () => jest.fn(), { virtual: true })

const sh = require('shell-exec')
const { isIntelliJ, killIntelliJ, cli } = require('./intellij')
const platform = Object.getOwnPropertyDescriptor(process, 'platform')
const result = stdout => ({ stdout, stderr: '', code: 0 })
const idea = '/opt/idea/jbr/bin/java -classpath /opt/idea/lib/app.jar -Djb.vmOptionsFile=/home/u/.config/JetBrains/IntelliJIdea2024.1/idea64.vmoptions ' +
  '-Didea.paths.selector=IntelliJIdea2024.1 com.intellij.idea.Main'

afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  jest.restoreAllMocks()
})

describe('isIntelliJ', () => {
  test.each([
    idea,
    '/opt/idea/jbr/bin/java -Didea.paths.selector=IdeaIC2023.3 com.intellij.idea.Main',
    'java -Djb.vmOptionsFile=/x/idea64.vmoptions com.intellij.idea.Main',
    'C:\\idea\\jbr\\bin\\javaw.exe -Didea.paths.selector=IntelliJIdea2024.1 com.intellij.idea.Main'
  ])('matches an IntelliJ IDEA JVM: %s', command => {
    expect(isIntelliJ(command, 'linux')).toBe(true)
  })

  test.each([
    // Other JetBrains IDEs share the main class but are not IntelliJ IDEA.
    '/opt/pycharm/jbr/bin/java -Didea.paths.selector=PyCharm2024.1 com.intellij.idea.Main',
    '/opt/webstorm/jbr/bin/java -Djb.vmOptionsFile=/x/webstorm64.vmoptions -Didea.paths.selector=WebStorm2024.1 com.intellij.idea.Main',
    // Commands that merely mention the strings must never match.
    `/bin/bash -c ${idea}`,
    `grep ${idea}`,
    'vim /home/u/notes/intellij.txt',
    'tail -f /home/u/.cache/JetBrains/IntelliJIdea2024.1/log/idea.log',
    'node /usr/bin/kill-process intellij',
    '/usr/bin/java -jar gradle.jar com.intellij.idea.Main',
    ''
  ])('ignores %s', command => {
    expect(isIntelliJ(command, 'linux')).toBe(false)
  })

  test('matches the exact macOS launcher path only', () => {
    expect(isIntelliJ('/Applications/IntelliJ IDEA.app/Contents/MacOS/idea', 'darwin')).toBe(true)
    expect(isIntelliJ('/Applications/IntelliJ IDEA CE.app/Contents/MacOS/idea', 'darwin')).toBe(true)
    expect(isIntelliJ('/Applications/PyCharm.app/Contents/MacOS/pycharm', 'darwin')).toBe(false)
    expect(isIntelliJ('/bin/bash -c /Applications/IntelliJ IDEA.app/Contents/MacOS/idea x', 'darwin')).toBe(false)
  })
})

describe('killIntelliJ', () => {
  let alive
  let signals
  const ps = () => result(alive.map(pid => `${pid} ${idea}`).join('\n') + '\n  900 /bin/bash -c something')

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    alive = [101, 102]
    signals = []
    sh.mockReset()
    sh.mockImplementation(async command => {
      expect(command).toBe('ps -axww -o pid=,args=')
      return ps()
    })
  })

  const spyKill = onSignal => jest.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    signals.push([pid, signal])
    onSignal && onSignal(pid, signal)
  })

  test('reports nothing to do when no IDE is running', async () => {
    alive = []
    const kill = spyKill()
    expect(await killIntelliJ()).toEqual({ found: [], signalled: [], forced: [], failed: [] })
    expect(kill).not.toHaveBeenCalled()
  })

  test('dry run lists the IDE without signalling', async () => {
    const kill = spyKill()
    const { found } = await killIntelliJ({ dryRun: true })
    expect(found.map(p => p.pid)).toEqual([101, 102])
    expect(kill).not.toHaveBeenCalled()
  })

  test('sends only SIGTERM when the IDE exits within the grace period', async () => {
    spyKill(() => { alive = [] })
    const res = await killIntelliJ({ timeout: 1 })
    expect(signals).toEqual([[101, 'SIGTERM'], [102, 'SIGTERM']])
    expect(res.forced).toEqual([])
  })

  test('escalates to SIGKILL only for a process that ignores SIGTERM', async () => {
    // 101 exits on SIGTERM; 102 ignores it and only dies on SIGKILL.
    spyKill((pid, signal) => {
      if (signal === 'SIGKILL' || pid === 101) alive = alive.filter(p => p !== pid)
    })
    const res = await killIntelliJ({ timeout: 0 })
    expect(res.forced).toEqual([102])
    expect(signals).toEqual([[101, 'SIGTERM'], [102, 'SIGTERM'], [102, 'SIGKILL']])
  })

  test('an explicit signal is sent once, with no waiting or escalation', async () => {
    spyKill()
    const res = await killIntelliJ({ signal: 'SIGINT' })
    expect(signals).toEqual([[101, 'SIGINT'], [102, 'SIGINT']])
    expect(res.forced).toEqual([])
  })

  test('uses SIGKILL straight away on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    sh.mockReset()
    sh.mockResolvedValue(result('"idea64.exe","101","Console","1","1 K"\n"notepad.exe","7","Console","1","1 K"'))
    spyKill()
    const res = await killIntelliJ()
    expect(signals).toEqual([[101, 'SIGKILL']])
    expect(res.signalled).toEqual([101])
  })

  test('treats an already-exited process as success and surfaces other errors', async () => {
    spyKill((pid) => {
      const error = new Error(pid === 101 ? 'no such process' : 'operation not permitted')
      error.code = pid === 101 ? 'ESRCH' : 'EPERM'
      throw error
    })
    const res = await killIntelliJ({ signal: 'SIGTERM' })
    expect(res.failed.map(f => f.pid)).toEqual([102])
  })

  test('never targets its own process', async () => {
    alive = [process.pid, 101]
    spyKill()
    const { found } = await killIntelliJ({ dryRun: true })
    expect(found.map(p => p.pid)).toEqual([101])
  })

  test.each([-1, NaN, Infinity])('rejects invalid timeout %p before listing', async timeout => {
    await expect(killIntelliJ({ timeout })).rejects.toThrow('Invalid timeout provided')
    expect(sh).not.toHaveBeenCalled()
  })

  test('rejects an invalid signal before listing', async () => {
    await expect(killIntelliJ({ signal: 'SIGSTOP' })).rejects.toThrow('Invalid signal name provided')
    expect(sh).not.toHaveBeenCalled()
  })

  test('propagates a failed process listing', async () => {
    sh.mockReset()
    sh.mockResolvedValue({ stdout: '', stderr: 'ps: boom', code: 1 })
    await expect(killIntelliJ()).rejects.toThrow('ps: boom')
  })
})

describe('cli', () => {
  let log
  let exitCode
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    log = jest.spyOn(console, 'log').mockImplementation(() => {})
    exitCode = process.exitCode
    sh.mockReset()
    sh.mockResolvedValue(result(`101 ${idea}`))
  })
  afterEach(() => { process.exitCode = exitCode })

  test('prints a dry run without signalling', async () => {
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => {})
    await cli(['--dry-run'])
    expect(kill).not.toHaveBeenCalled()
    expect(log.mock.calls[0]).toEqual(['Would kill (dry run):'])
    expect(process.exitCode).toBe(exitCode)
  })

  test('prints a friendly message when nothing is running', async () => {
    sh.mockResolvedValue(result(''))
    await cli([])
    expect(log).toHaveBeenCalledWith('No IntelliJ IDEA process is running.')
  })

  test.each([['--nope'], ['--signal', 'SIGSTOP'], ['--timeout', 'abc']])('rejects %p with exit code 1', async (...args) => {
    await cli(args.flat())
    expect(process.exitCode).toBe(1)
    expect(sh).not.toHaveBeenCalled()
  })

  test('accepts --signal=NAME and --timeout=N', async () => {
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => {})
    await cli(['--signal=SIGINT', '--timeout=1'])
    expect(kill).toHaveBeenCalledWith(101, 'SIGINT')
  })
})

// @ts-check
/**
 * dsh-desktop — desktop shell for the DeepSeek Harness web GUI.
 *
 * Three dsh sources, chosen at startup (remembered as `dshSource`):
 *   - `builtin`  — @deepseek-ai/dsh@latest bundled into the app at build
 *                  time (builtin-dsh/), runs offline with Electron's Node;
 *   - `latest`   — official latest release resolved at startup (npx
 *                  semantics, but installed once into
 *                  ~/.dsh/desktop-versions/ so launches after the first are
 *                  offline and instant);
 *   - `dir:<path>` — a local git checkout directory the user picks (their
 *                  modified dsh), run from source with a system Node that
 *                  satisfies dsh's engines.
 * Without a remembered choice the startup picker offers all three; the
 * folder picker uses the native dialog. `~/.dsh/desktop-bin/` holds
 * node/npm shims so a Finder-launched app works without Node on PATH.
 *
 * Flags: `--dsh <builtin|latest|dir:<path>>`, `--repo <path>`,
 * `--host <ip>`, `--port <n>`, `--keep-server`, `--devtools`.
 * @module dsh-desktop/main
 */

import { app, BrowserWindow, dialog, Menu, nativeTheme, shell } from 'electron'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const DSH_HOME = process.env.DSH_HOME || path.join(homedir(), '.dsh')
const CONFIG_PATH = path.join(DSH_HOME, 'desktop.json')
const APP_LOG = path.join(DSH_HOME, 'desktop.log')
const SERVER_LOG = path.join(DSH_HOME, 'desktop-server.log')
const DEFAULT_REPO = process.env.DSH_REPO
  || path.join(homedir(), 'Documents', 'GitHub', 'ai-learning', 'deepseek-harness')

const BOOT_TIMEOUT_MS = 90_000
const NPM_BOOT_TIMEOUT_MS = 10 * 60_000 // first `npm exec` downloads the package
const POLL_INTERVAL_MS = 500
const IS_MAC = process.platform === 'darwin'
const IS_WIN = process.platform === 'win32'

const timestamp = () => new Date().toISOString()

/** Append one line to the app log and echo it to stdout (visible with `npm start`). */
function log(message) {
  const line = `[${timestamp()}] ${message}`
  console.log(line)
  appendFileSync(APP_LOG, `${line}\n`)
}

/* ------------------------------ config ------------------------------ */

/** Small CLI parser: `--key value` and bare `--flag`. Returns runtime overrides. */
function parseArgs(argv) {
  /** @type {Record<string, string | true>} */
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next
      i += 1
    } else {
      out[key] = true
    }
  }
  return out
}

function loadConfig() {
  let file = {}
  try {
    if (existsSync(CONFIG_PATH)) file = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch (error) {
    log(`config unreadable (${error.message}), using defaults`)
  }
  const cli = parseArgs(process.argv.slice(2))

  const repo = String(cli.repo || file.repo || DEFAULT_REPO)
  const host = String(cli.host || file.host || '127.0.0.1')
  const port = Number(cli.port || file.port || 3081)
  const keepServerOnQuit = Boolean(cli['keep-server'] || file.keepServerOnQuit)
  // The remembered choice pre-selects the picker instead of skipping it; only
  // an explicit `--dsh` flag skips the picker (automation).
  const dshSourceFromCli = Boolean(cli.dsh)
  const dshSource = cli.dsh || file.dshSource || undefined

  const config = { repo, host, port, keepServerOnQuit, devtools: Boolean(cli.devtools), dshSource, dshSourceFromCli }

  if (!existsSync(CONFIG_PATH)) {
    mkdirSync(DSH_HOME, { recursive: true })
    writeFileSync(
      CONFIG_PATH,
      `${JSON.stringify({ repo, host, port, keepServerOnQuit, dshSource }, null, 2)}\n`,
    )
    log(`wrote default config: ${CONFIG_PATH}`)
  }
  return config
}

/** Persist the chosen source id so the next launch pre-selects it. */
function rememberSourceSelection(id) {
  try {
    const file = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    file.dshSource = id
    delete file.dshSources // legacy key from the multi-source config era
    writeFileSync(CONFIG_PATH, `${JSON.stringify(file, null, 2)}\n`)
  } catch (error) {
    log(`could not remember dsh source selection: ${error.message}`)
  }
}

/* -------------------- tool shims (no PATH reliance) -------------------- */

const NPM_CLI_CANDIDATES = [
  '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js',
  '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
  path.join(homedir(), '.local/lib/node_modules/npm/bin/npm-cli.js'),
]

/** @returns {string | null} an npm-cli path Node can run, or null. */
function resolveNpmCli() {
  if (process.env.DSH_NPM_CLI && existsSync(process.env.DSH_NPM_CLI)) return process.env.DSH_NPM_CLI
  return NPM_CLI_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null
}

/** Whether a `node -v` output satisfies dsh's engines (^22.19.0 || >=24.0.0). */
function nodeVersionSatisfies(version) {
  const match = /^v?(\d+)\.(\d+)\./.exec(version.trim())
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return (major === 22 && minor >= 19) || major >= 24
}

/**
 * The Node to run source-launched dsh under: prefer a system Node satisfying
 * dsh's engines (Electron's bundled Node 24 trips the tsx loader chain), and
 * fall back to Electron's own Node.
 * @returns {string} an absolute path to a usable Node executable.
 */
function resolveSystemNode() {
  if (process.env.DSH_NODE && existsSync(process.env.DSH_NODE)) return process.env.DSH_NODE
  const candidates = [
    path.join(homedir(), '.local/bin/node'),
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ]
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      const result = spawnSync(candidate, ['-v'], { encoding: 'utf8', timeout: 5000 })
      if (result.status === 0 && nodeVersionSatisfies(result.stdout)) return candidate
    } catch {
      /* try the next candidate */
    }
  }
  return process.execPath
}

/** Path of the `node` the shim should forward to (system Node, else Electron). */
function shimNodeExecutable() {
  const system = resolveSystemNode()
  return system === process.execPath
    ? { executable: system, forward: true } // Electron binary itself needs ELECTRON_RUN_AS_NODE
    : { executable: system, forward: false }
}

/**
 * `node` and `npm` shims forwarding to a usable Node, placed in
 * `~/.dsh/desktop-bin/` and prepended to PATH: package scripts invoke
 * `node`/`npm` through `sh` PATH lookups, which fail when the app is launched
 * from Finder (minimal PATH, no Node installed).
 * @returns {string} the shim directory to prepend to PATH ('' on Windows).
 */
let shimDirCache
function ensureNodeShimDir() {
  if (shimDirCache !== undefined) return shimDirCache
  shimDirCache = ''
  if (IS_WIN) return shimDirCache
  const dir = path.join(DSH_HOME, 'desktop-bin')
  const { executable, forward } = shimNodeExecutable()
  const quoted = executable.replace(/'/g, `'\\''`)
  const prelude = forward ? 'export ELECTRON_RUN_AS_NODE=1\n' : ''
  const nodeShim = `#!/bin/sh\n${prelude}exec '${quoted}' "$@"\n`
  const npmCli = resolveNpmCli()
  const npmShim = npmCli
    ? `#!/bin/sh\n${prelude}exec '${quoted}' '${npmCli.replace(/'/g, `'\\''`)}' "$@"\n`
    : null
  try {
    mkdirSync(dir, { recursive: true })
    const shims = [[path.join(dir, 'node'), nodeShim]]
    if (npmShim) shims.push([path.join(dir, 'npm'), npmShim])
    for (const [file, content] of shims) {
      if (!existsSync(file) || readFileSync(file, 'utf8') !== content) {
        writeFileSync(file, content)
        chmodSync(file, 0o755)
      }
    }
    shimDirCache = dir
  } catch (error) {
    log(`could not create tool shims: ${error instanceof Error ? error.message : String(error)}`)
  }
  return shimDirCache
}

/** Env for children: shim PATH first, npm registry mirror, Electron-as-Node. */
function toolEnv(extra = {}) {
  const shimDir = ensureNodeShimDir()
  return {
    ...process.env,
    ...extra,
    ELECTRON_RUN_AS_NODE: '1',
    npm_config_registry: process.env.NPM_CONFIG_REGISTRY || 'https://registry.npmmirror.com',
    ...(shimDir && { PATH: `${shimDir}:${process.env.PATH ?? ''}` }),
  }
}

/**
 * Root of the dsh bundled into the app. The app ships WITHOUT an asar
 * archive (`asar: false`), so builtin-dsh is a real directory on disk —
 * dsh heals `profiles/node_modules` with symlinks into the install, and
 * Node cannot resolve through asar virtual paths.
 */
function builtinRoot() {
  return path.join(app.getAppPath(), 'builtin-dsh')
}

/** Entry of the dsh bundled into the app at build time. */
function builtinBinPath() {
  return path.join(builtinRoot(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

/** @returns {string | null} the exact version of the bundled dsh, or null. */
function builtinDshVersion() {
  try {
    const pkgPath = path.join(builtinRoot(), 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    const data = JSON.parse(readFileSync(pkgPath, 'utf8'))
    return typeof data.version === 'string' ? data.version : null
  } catch {
    return null
  }
}

/** Registry mirror for resolving the official latest version. */
const NPM_REGISTRY = process.env.DSH_NPM_REGISTRY || 'https://registry.npmmirror.com'

/** @returns {Promise<string>} the concrete `latest` version of @deepseek-ai/dsh. */
async function fetchLatestVersion() {
  const response = await fetch(`${NPM_REGISTRY}/@deepseek-ai/dsh`, { signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`npm registry unreachable (HTTP ${response.status})`)
  const data = await response.json()
  const latest = data['dist-tags']?.latest
  if (typeof latest !== 'string' || latest === '') throw new Error('npm registry returned no "latest" tag for @deepseek-ai/dsh')
  return latest
}

/**
 * Install `@deepseek-ai/dsh@<version>` into a managed directory once, then
 * return the path of its bundled CLI entry. Deterministic one-time install —
 * the equivalent of `npx @deepseek-ai/dsh@latest` without re-resolving the
 * ~900-package tree on every launch.
 * @param {string} version - the concrete version to install.
 * @returns {string} absolute path to `@deepseek-ai/dsh/lib/bin.js`.
 */
function ensureNpmDsh(version) {
  const installDir = path.join(DSH_HOME, 'desktop-versions', `dsh-${version}`)
  const bin = path.join(installDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (existsSync(bin)) return bin
  log(`installing @deepseek-ai/dsh@${version} into ${installDir} (first use, may take a few minutes)`)
  mkdirSync(installDir, { recursive: true })
  const npmCli = resolveNpmCli()
  const args = ['install', '--no-save', '--no-audit', '--no-fund', '--loglevel', 'error', '--prefix', installDir, `@deepseek-ai/dsh@${version}`]
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], { env: toolEnv({ FORCE_COLOR: '0' }), stdio: 'inherit', timeout: 10 * 60_000 })
    : spawnSync('npm', args, { env: toolEnv({ FORCE_COLOR: '0' }), stdio: 'inherit', timeout: 10 * 60_000 })
  if (result.error || result.status !== 0 || !existsSync(bin)) {
    throw new Error(
      `installing @deepseek-ai/dsh@${version} failed` +
      `${result.error ? ` (${result.error.message})` : ` (exit ${result.status})`}.`,
    )
  }
  return bin
}

/* --------------------------- server manager --------------------------- */

/** @returns {Promise<boolean>} whether a port can be bound on the host. */
function portBindable(host, port) {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, host, () => {
      probe.close(() => resolve(true))
    })
  })
}

class ServerManager {
  /**
   * @param {{host: string, port: number, keepServerOnQuit: boolean, devtools: boolean}} config
   * @param {{id: string, label: string, kind: 'builtin' | 'latest' | 'dir', dir?: string}} source
   */
  constructor(config, source) {
    this.config = config
    this.source = source
    /** The port the server actually runs on; may differ from the preferred one. */
    this.launchPort = config.port
    /** @type {import('node:child_process').ChildProcess | null} */
    this.child = null
    /** Whether this process spawned the server (vs. attached to a running one). */
    this.owned = false
    /** Ring of recent server output for error dialogs. */
    this.recent = []
    /** Resolved entry path for `latest`/npm sources, set by {@link ensure}. */
    /** @type {string | undefined} */
    this.npmBin = undefined
  }

  get url() {
    return `http://${this.config.host}:${this.launchPort}`
  }

  /** @returns {Promise<boolean>} true when something already answers on the port. */
  async probe() {
    try {
      await fetch(`${this.url}/`, { signal: AbortSignal.timeout(2000) })
      return true
    } catch {
      return false
    }
  }

  /**
   * Decide which port to run on: always the app's own port. Scan from the
   * preferred port upward (+1, +2, … ≤ +100) for the first bindable one —
   * a dsh (or anything else) already listening there is simply skipped.
   * The chosen dsh source is what the window shows, never a silent attach.
   * @returns {Promise<number>} the port to bind.
   */
  async resolveLaunchPort() {
    const preferred = this.config.port
    for (let offset = 0; offset <= 100; offset += 1) {
      const candidate = preferred + offset
      if (await portBindable(this.config.host, candidate)) {
        if (candidate !== preferred) {
          log(`port ${preferred} is taken — using own port ${candidate}`)
        }
        return candidate
      }
    }
    throw new Error(`ports ${preferred}..${preferred + 100} are all busy — nothing to bind`)
  }

  /**
   * Spawn the chosen source on the app's own port: every window always gets
   * its own dsh process — never attached to an existing one.
   * @returns {Promise<'spawned'>}
   */
  async ensure() {
    this.launchPort = await this.resolveLaunchPort()
    if (this.source.kind === 'builtin' && !existsSync(builtinBinPath())) {
      throw new Error(
        `内置版 dsh 未打包进应用：缺少 ${builtinBinPath()}\n\n` +
        `dev 模式下先运行: npm install --prefix builtin-dsh @deepseek-ai/dsh@latest\n` +
        `打包版由 scripts/build.mjs 自动内置。`,
      )
    }
    if (this.source.kind === 'latest') {
      // npx semantics without the per-launch resolver cost: resolve the
      // concrete latest version, install it once, then launch it directly.
      const version = await fetchLatestVersion()
      this.npmBin = ensureNpmDsh(version)
      log(`official latest resolves to @deepseek-ai/dsh@${version}`)
    }
    if (this.source.kind === 'dir' && !existsSync(path.join(this.source.dir, 'apps/cli/src/bin.ts'))) {
      throw new Error(`该目录不是 dsh 源码仓库（缺少 apps/cli/src/bin.ts）:\n${this.source.dir}`)
    }
    this.spawnServer()
    log(`spawned server (pid ${this.child?.pid}), waiting for ${this.url}`)
    await this.waitReady(this.source.kind === 'latest' ? NPM_BOOT_TIMEOUT_MS : BOOT_TIMEOUT_MS)
    return 'spawned'
  }

  /** Spawn the chosen source as `dsh web --host <host> --port <port>`. */
  spawnServer() {
    this.recent = []
    this.owned = true
    const common = {
      detached: !IS_WIN,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
    const host = this.config.host
    const port = String(this.launchPort)

    if (this.source.kind === 'builtin') {
      this.child = spawn(
        process.execPath,
        ['--expose-internals', builtinBinPath(), 'web', '--host', host, '--port', port],
        { ...common, env: toolEnv({ DSH_HOME }) },
      )
    } else if (this.source.kind === 'latest') {
      // The installed latest package's entry, run with Electron's Node like
      // the official DSH Desktop does.
      this.child = spawn(
        process.execPath,
        ['--expose-internals', this.npmBin, 'web', '--host', host, '--port', port],
        { ...common, env: toolEnv({ DSH_HOME }) },
      )
    } else {
      // Local checkout: the exact invocation a terminal uses, under a Node
      // that satisfies dsh's engines.
      const node = resolveSystemNode()
      this.child = spawn(
        node,
        ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--host', host, '--port', port],
        {
          ...common,
          cwd: this.source.dir,
          env: toolEnv({ DSH_HOME, ...(node === process.execPath && { ELECTRON_RUN_AS_NODE: '1' }) }),
        },
      )
    }
    this.attachChild(this.child)
  }

  /** Wire stdout/stderr and exit of a freshly spawned child. */
  attachChild(child) {
    child.stdout?.on('data', (chunk) => this.pipe(chunk))
    child.stderr?.on('data', (chunk) => this.pipe(chunk))
    child.on('exit', (code, signal) => {
      if (this.child && this.child.exitCode === null) log(`server exited (code ${code}, signal ${signal})`)
      this.child = null
    })
  }

  pipe(chunk) {
    const text = chunk.toString()
    appendFileSync(SERVER_LOG, text)
    this.recent.push(text)
    if (this.recent.length > 40) this.recent.shift()
  }

  /** Poll until the server answers, it dies, or the boot timeout passes. */
  async waitReady(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await this.probe()) return
      if (!this.child) {
        throw new Error(
          `dsh web exited during boot.\n\nRecent server output:\n${this.recent.join('') || '(none)'}\n` +
          `Full log: ${SERVER_LOG}`,
        )
      }
      await sleep(POLL_INTERVAL_MS)
    }
    throw new Error(`server did not answer on ${this.url} within ${timeoutMs / 1000}s.\nLog: ${SERVER_LOG}`)
  }

  /** Stop the server, but only the one this process started. */
  stop() {
    if (!this.child || !this.owned || this.config.keepServerOnQuit) return
    const pid = this.child.pid
    if (pid === undefined) return
    log(`stopping server we started (pid ${pid})`)
    if (IS_WIN) {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'])
      return
    }
    // detached:true put the server in its own process group; kill the group,
    // escalating to SIGKILL when it has not exited within 3s.
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      process.kill(pid, 'SIGTERM')
    }
    const deadline = Date.now() + 3000
    const finish = () => {
      if (!isAlive(pid)) return
      if (Date.now() >= deadline) {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          process.kill(pid, 'SIGKILL')
        }
        return
      }
      setTimeout(finish, 200)
    }
    setTimeout(finish, 200)
  }
}

/* --------------------------- source picker --------------------------- */

/**
 * Resolve the dsh source to launch. The picker shows on **every** launch and
 * pre-marks the remembered choice; only an explicit `--dsh` flag skips it.
 * @param {string | undefined} preferred - `builtin`, `latest`, or `dir:<path>`.
 * @param {boolean} skipWhenPreferred - skip the picker when `preferred` is set.
 * @returns {Promise<{id: string, label: string, kind: 'builtin' | 'latest' | 'dir', dir?: string}>}
 */
/** Picker window strings, following the OS language (not the dsh locale). */
const PICKER_L10N = {
  zh: {
    windowTitle: '选择 dsh 版本',
    heading: '选择要启动的 dsh 版本',
    builtin: '内置版本',
    builtinDescWithVersion: (v) => `打包在 App 内 · v${v}`,
    builtinDescBare: '打包在 App 内',
    latest: '官方最新版（latest）',
    latestDesc: '启动时解析 @deepseek-ai/dsh 最新版，首次自动安装',
    dir: '指定目录…',
    dirDescNone: '点击选择 dsh 源码目录',
    lastUsed: '上次使用',
    folderTitle: '选择目录',
    dialogTitle: '选择 dsh 源码目录',
  },
  en: {
    windowTitle: 'Choose dsh Version',
    heading: 'Choose the dsh version to launch',
    builtin: 'Built-in',
    builtinDescWithVersion: (v) => `Bundled in the app · v${v}`,
    builtinDescBare: 'Bundled in the app',
    latest: 'Official Latest',
    latestDesc: 'Resolves @deepseek-ai/dsh latest at launch; auto-installs on first use',
    dir: 'Specify Directory…',
    dirDescNone: 'Click to choose the dsh source directory',
    lastUsed: 'Last used',
    folderTitle: 'Choose directory',
    dialogTitle: 'Choose dsh source directory',
  },
}

/** Picker language = OS language (zh vs everything else). */
function pickerLanguage() {
  return systemLanguage() === 'zh' ? 'zh' : 'en'
}

function pickSource(preferred, skipWhenPreferred) {
  const t = PICKER_L10N[pickerLanguage()]
  if (skipWhenPreferred && preferred === 'builtin') {
    return Promise.resolve({ id: 'builtin', label: '内置版本', kind: 'builtin' })
  }
  if (skipWhenPreferred && preferred === 'latest') {
    return Promise.resolve({ id: 'latest', label: '官方最新版 (latest)', kind: 'latest' })
  }
  if (skipWhenPreferred && preferred?.startsWith('dir:')) {
    const dir = preferred.slice(4)
    return Promise.resolve({ id: `dir:${dir}`, label: `本地目录 ${dir}`, kind: 'dir', dir })
  }
  log(`showing version picker${preferred ? ` (上次使用: ${preferred})` : ''}`)

  return new Promise((resolve, reject) => {
    const badge = (id) => (preferred === id ? `<span class="badge">${t.lastUsed}</span>` : '')
    const hasDir = preferred?.startsWith('dir:')
    const dirDesc = hasDir
      ? escapeHtml(preferred.slice(4))
      : t.dirDescNone
    const builtinVersion = builtinDshVersion()
    const builtinDesc = builtinVersion
      ? t.builtinDescWithVersion(escapeHtml(builtinVersion))
      : t.builtinDescBare
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      body { background:#151517; color:#e8e8ea; font-family:system-ui,-apple-system,sans-serif;
             display:flex; flex-direction:column; align-items:center; justify-content:center;
             height:100vh; margin:0; gap:12px; }
      h1 { font-size:17px; font-weight:600; margin:0 0 4px; }
      .item { width:420px; box-sizing:border-box; display:block; text-decoration:none; color:inherit;
              background:#212124; border:1px solid #2f2f33; border-radius:12px; padding:12px 18px; }
      .item:hover { background:#2a2a2e; border-color:#4d6bfe; }
      .label { font-size:15px; font-weight:600; }
      .desc { font-size:12px; color:#9a9aa2; margin-top:4px; word-break:break-all; }
      .badge { display:inline-block; margin-left:8px; padding:1px 8px; border-radius:999px;
               background:#4d6bfe; color:#fff; font-size:11px; font-weight:500; vertical-align:2px; }
      .dir-item { position:relative; cursor:pointer; }
      .dir-item .desc { padding-right:44px; }
      .folder-btn { position:absolute; right:10px; top:50%; transform:translateY(-50%);
               display:flex; align-items:center; justify-content:center; width:36px; height:36px;
               border-radius:10px; color:#9a9aa2; text-decoration:none; }
      .folder-btn:hover { background:#3a3a40; color:#e8e8ea; }
    </style></head><body>
      <h1>${t.heading}</h1>
      <a class="item" href="dsh-choose://builtin">
        <div class="label">${t.builtin}${badge('builtin')}</div>
        <div class="desc">${builtinDesc}</div>
      </a>
      <a class="item" href="dsh-choose://latest">
        <div class="label">${t.latest}${badge('latest')}</div>
        <div class="desc">${t.latestDesc}</div>
      </a>
      <div class="item dir-item" id="dir-row">
        <div class="label">${t.dir}${hasDir ? `<span class="badge">${t.lastUsed}</span>` : ''}</div>
        <div class="desc">${dirDesc}</div>
        <a class="folder-btn" href="#" id="dir-pick" title="${t.folderTitle}">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>
        </a>
      </div>
      <script>
        document.getElementById('dir-row')?.addEventListener('click', (e) => {
          if (e.target.closest('#dir-pick')) return
          location.href = 'dsh-choose://diruse'
        })
        document.getElementById('dir-pick')?.addEventListener('click', (e) => {
          e.preventDefault()
          e.stopPropagation()
          location.href = 'dsh-choose://pickdir'
        })
      </script>
    </body></html>`

    const win = new BrowserWindow({
      width: 520,
      height: 320,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: t.windowTitle,
      backgroundColor: '#151517',
    })
    let settled = false
    win.webContents.on('will-navigate', async (event, target) => {
      if (!target.startsWith('dsh-choose://')) return
      event.preventDefault()
      const raw = decodeURIComponent(target.slice('dsh-choose://'.length))
      const finish = (choice) => {
        settled = true
        win.close()
        resolve(choice)
      }
      const pickDir = async () => {
        // Native folder picker; keep the picker window when cancelled.
        const result = await dialog.showOpenDialog(win, {
          title: t.dialogTitle,
          properties: ['openDirectory'],
        })
        const dir = result.filePaths[0]
        if (!result.canceled && dir) {
          finish({ id: `dir:${dir}`, label: `本地目录 ${dir}`, kind: 'dir', dir })
        }
      }
      if (raw === 'diruse') {
        // Direct click on the local-directory row: enter with the remembered
        // directory when one exists, otherwise ask for it.
        if (preferred?.startsWith('dir:')) {
          const dir = preferred.slice(4)
          finish({ id: `dir:${dir}`, label: `本地目录 ${dir}`, kind: 'dir', dir })
        } else {
          await pickDir()
        }
        return
      }
      if (raw === 'pickdir') {
        await pickDir()
        return
      }
      settled = true
      win.close()
      if (raw === 'builtin') resolve({ id: 'builtin', label: '内置版本', kind: 'builtin' })
      else if (raw === 'latest') resolve({ id: 'latest', label: '官方最新版 (latest)', kind: 'latest' })
      else if (raw.startsWith('dir:')) {
        const dir = raw.slice(4)
        resolve({ id: `dir:${dir}`, label: `本地目录 ${dir}`, kind: 'dir', dir })
      } else reject(new Error(`unknown picker choice "${raw}"`))
    })
    win.on('closed', () => {
      if (!settled) reject(new Error('no dsh source chosen'))
    })
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  })
}

/* ------------------------------- window ------------------------------- */

/** All open app windows (multi-window like Codex's "new window"). */
const windows = new Set()
/** Window → the dsh process serving it (one process per window). */
const windowServers = new Map()
/** All dsh processes this app currently manages. */
const servers = new Set()
/** The launch configuration and source resolved at boot, reused per window. */
/** @type {ReturnType<typeof loadConfig> | null} */
let launchConfig = null
/** @type {{id: string, label: string, kind: 'builtin' | 'latest' | 'dir', dir?: string} | null} */
let launchSource = null

// The dsh web UI's own theme tokens (body[data-ds-dark-theme] toggles them):
// --dsw-alias-bg-base resolves to #151517 in dark mode and #ffffff in light.
const THEME_DARK_BG = '#151517'
const THEME_LIGHT_BG = '#ffffff'
/** @type {boolean | null} */
let appliedTheme = null

/**
 * Mirror one window's page theme onto the native chrome: the macOS/Windows
 * title bar follows the app appearance driven by `nativeTheme.themeSource`,
 * and the window background matches so no light/dark flash shows while the
 * page paints. The dsh UI toggles `data-ds-dark-theme` on `<body>`, so we
 * poll it and update live when the user switches themes.
 * @param {BrowserWindow} win - the window whose page theme to read.
 */
async function applyPageTheme(win) {
  if (win.isDestroyed()) return
  try {
    const dark = await win.webContents.executeJavaScript(
      'document.body ? document.body.hasAttribute("data-ds-dark-theme") : false',
    )
    const isDark = Boolean(dark)
    nativeTheme.themeSource = isDark ? 'dark' : 'light'
    win.setBackgroundColor(isDark ? THEME_DARK_BG : THEME_LIGHT_BG)
    if (appliedTheme !== isDark) {
      appliedTheme = isDark
      log(`page theme detected: ${isDark ? 'dark' : 'light'} — title bar synced`)
    }
  } catch (error) {
    log(`theme sync skipped: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function errorPage(title, message) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  body { background:#0d1117; color:#c9d1d9; font-family:system-ui,-apple-system,sans-serif;
         display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
  main { max-width:640px; padding:32px; }
  h1 { font-size:20px; color:#f85149; }
  pre { white-space:pre-wrap; background:#161b22; padding:16px; border-radius:8px;
        font-size:12px; line-height:1.5; color:#8b949e; overflow:auto; max-height:50vh; }
</style></head><body><main>
<h1>${escapeHtml(title)}</h1><pre>${escapeHtml(message)}</pre>
</main></body></html>`
}

/**
 * A fixed-size, scrollable error window with working close/log buttons —
 * replaces `dialog.showErrorBox`, which grows to the message height and can
 * push its close button off-screen for long stack traces.
 * @param {string} title - window and heading title.
 * @param {string} message - full diagnostic text (scrollable).
 * @returns {BrowserWindow} the error window.
 */
function showBootError(title, message) {
  const win = new BrowserWindow({
    width: 780,
    height: 560,
    minWidth: 480,
    minHeight: 320,
    title,
    backgroundColor: '#0d1117',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin:0; font-family:system-ui,-apple-system,sans-serif; background:#0d1117; color:#c9d1d9;
           display:flex; flex-direction:column; height:100vh; }
    .head { padding:14px 18px; font-size:16px; font-weight:600; color:#f85149; border-bottom:1px solid #21262d; }
    pre { flex:1; margin:0; padding:16px 18px; overflow:auto; font-size:12px; line-height:1.55;
          color:#8b949e; white-space:pre-wrap; word-break:break-all; }
    .foot { padding:12px 18px; border-top:1px solid #21262d; display:flex; gap:10px; justify-content:flex-end; }
    button { padding:7px 18px; border-radius:8px; border:1px solid #30363d; background:#21262d;
             color:#e8e8ea; font-size:13px; cursor:pointer; }
    button:hover { background:#30363d; }
    .primary { background:#4d6bfe; border-color:#4d6bfe; }
  </style></head><body>
    <div class="head">${escapeHtml(title)}</div>
    <pre>${escapeHtml(message)}</pre>
    <div class="foot">
      <button onclick="location.href='dsh-error://open-log'">打开日志文件</button>
      <button class="primary" onclick="location.href='dsh-error://close'">关闭</button>
    </div>
  </body></html>`
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('dsh-error://')) return
    event.preventDefault()
    if (url === 'dsh-error://close') win.close()
    else if (url === 'dsh-error://open-log') shell.openPath(SERVER_LOG)
  })
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  return win
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

/**
 * macOS: make the window content extend into the title bar area (the page's
 * own background becomes the title bar color) and pad the dsh sidebar top so
 * the traffic lights never cover the brand row. The padding mirrors what the
 * official DSH Desktop patches into the same stylesheet; the hashed CSS-module
 * class names are discovered at runtime from the injected stylesheet.
 * @param {BrowserWindow} win - the window whose page to adjust.
 */
function injectTitlebarSpacing(win) {
  if (!IS_MAC) return
  win.webContents.executeJavaScript(`(() => {
    if (document.getElementById('easydsh-titlebar-spacing')) return
    for (const sheet of document.styleSheets) {
      let rules
      try { rules = sheet.cssRules } catch { continue }
      for (const rule of rules) {
        const text = rule.cssText || ''
        if (!text.includes('dsh-sidebar-inline-padding')) continue
        const root = (text.match(/\\.([\\w-]+_root)\\{/) || [])[1]
        const collapsed = (text.match(/\\.([\\w-]+_collapsed)/) || [])[1]
        if (!root) continue
        const style = document.createElement('style')
        style.id = 'easydsh-titlebar-spacing'
        style.textContent =
          '.' + root + ':not(.' + (collapsed || 'easydsh-none') + '){padding-top:32px}' +
          (collapsed && navigator.userAgent.includes('Macintosh')
            ? '.' + root + '.' + collapsed + '{padding:46px 22px 6px}' : '')
        document.head.appendChild(style)
        return
      }
    }
  })()`).catch((error) => {
    log(`titlebar spacing injection failed: ${error instanceof Error ? error.message : String(error)}`)
  })
}

/**
 * Open one app window onto `url`, served by `owner` (its own dsh process).
 * Closing the window stops that process when nothing else keeps it.
 * @param {string} url - the dsh web UI endpoint.
 * @param {ServerManager} owner - the dsh process serving this window.
 * @returns {BrowserWindow} the created window.
 */
function createWindow(url, owner) {
  // build/icon.png ships in the asar (and sits at the project root in dev),
  // so the DeepSeek mark shows in dev-mode dock/taskbar too.
  const iconPath = path.join(app.getAppPath(), 'build', 'icon.png')
  if (IS_MAC && existsSync(iconPath)) app.dock.setIcon(iconPath)

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 940,
    minHeight: 600,
    title: APP_TITLE,
    backgroundColor: THEME_DARK_BG,
    show: false,
    // macOS: the page background extends into the title bar area so both
    // share one color; the traffic lights float over the padded sidebar top.
    ...(IS_MAC && { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 } }),
    ...(IS_WIN && existsSync(iconPath) && { icon: iconPath }),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  windows.add(win)
  windowServers.set(win, owner)

  // The dsh page sets document.title ("<conversation> - DeepSeek Harness");
  // rewrite it to "<EasyDSH> - <conversation>" instead.
  win.on('page-title-updated', (event) => {
    event.preventDefault()
    win.setTitle(formatWindowTitle(event.title))
  })

  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    windows.delete(win)
    const owned = windowServers.get(win)
    windowServers.delete(win)
    // An isolated window owns its dsh process: closing it stops that process
    // (unless keepServerOnQuit) so nothing leaks.
    if (owned && owned.owned && !owned.config.keepServerOnQuit) {
      owned.stop()
      servers.delete(owned)
    }
  })

  // Keep the native title bar and menu language in step with the dsh UI.
  let themePoll = null
  win.webContents.on('did-finish-load', () => {
    log('page load finished — starting theme sync')
    applyPageTheme(win)
    syncMenuLanguage()
    injectTitlebarSpacing(win)
    if (themePoll === null) {
      themePoll = setInterval(() => {
        applyPageTheme(win)
        syncMenuLanguage()
      }, 2000)
    }
  })
  win.on('closed', () => {
    if (themePoll !== null) clearInterval(themePoll)
  })

  // External links (docs etc.) open in the system browser, not the app window.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target)
    return { action: 'deny' }
  })

  // Right-click clipboard menu (Electron has no built-in context menu).
  win.webContents.on('context-menu', (_event, params) => {
    const template = params.isEditable
      ? [
          { role: 'cut', label: '剪切' },
          { role: 'copy', label: '复制' },
          { role: 'paste', label: '粘贴' },
          { type: 'separator' },
          { role: 'selectAll', label: '全选' },
        ]
      : [{ role: 'copy', label: '复制' }]
    Menu.buildFromTemplate(template).popup({ window: win })
  })

  let retries = 0
  win.webContents.on('did-fail-load', (_event, code, description) => {
    log(`page load failed (${code} ${description})`)
    if (retries < 10) {
      retries += 1
      setTimeout(() => { if (!win.isDestroyed()) win.loadURL(url) }, 1500)
    } else {
      win.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(errorPage('dsh 页面加载失败', `${code} ${description}\n\n${url}\n\n服务日志: ${SERVER_LOG}`))}`,
      )
    }
  })

  win.loadURL(url)
  if (owner?.config.devtools) win.webContents.openDevTools({ mode: 'detach' })
  return win
}

/**
 * Open one more window (⌘N) with its own dsh process and port, sharing the
 * same DSH_HOME — the isolated "new window" model. Falls back to reusing the
 * app's first window server when the boot selection is not known.
 */
async function openNewWindow() {
  if (!launchConfig || !launchSource) {
    log('new window requested before the launch selection resolved')
    return
  }
  log('opening a new isolated window')
  const owned = new ServerManager(launchConfig, launchSource)
  servers.add(owned)
  try {
    await owned.ensure()
    createWindow(owned.url, owned)
  } catch (error) {
    servers.delete(owned)
    owned.stop()
    const message = error instanceof Error ? error.message : String(error)
    log(`new window boot failed: ${message}`)
    showBootError(`${APP_TITLE} 新建窗口失败`, message)
  }
}

/** User-facing product name (window title, menus, error dialogs). */
const APP_TITLE = 'EasyDSH'

/** Rewrite the page title into `EasyDSH - <conversation>` form. */
function formatWindowTitle(pageTitle) {
  const name = String(pageTitle ?? '')
    .replace(/\s*-\s*DeepSeek Harness\s*$/i, '')
    .trim()
  return name ? `${APP_TITLE} - ${name}` : APP_TITLE
}

/** Menu strings for the two dsh UI languages. */
const MENU_L10N = {
  zh: {
    file: '文件', newWindow: '新建窗口',
    edit: '编辑', undo: '撤销', redo: '重做', cut: '剪切', copy: '复制', paste: '粘贴',
    pasteAndMatch: '粘贴并匹配样式', delete: '删除', selectAll: '全选',
    view: '视图', reload: '重新加载', devtools: '开发者工具', actualSize: '实际大小',
    zoomIn: '放大', zoomOut: '缩小', fullscreen: '全屏',
    service: '服务', switchVersion: '切换 dsh 版本…', serverLog: '打开服务端日志', config: '打开配置文件',
    window: '窗口', minimize: '最小化', zoom: '缩放', front: '前置全部窗口',
    about: `关于 ${APP_TITLE}`, hide: `隐藏 ${APP_TITLE}`, hideOthers: '隐藏其他', showAll: '全部显示',
    quit: `退出 ${APP_TITLE}`,
  },
  en: {
    file: 'File', newWindow: 'New Window',
    edit: 'Edit', undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste',
    pasteAndMatch: 'Paste and Match Style', delete: 'Delete', selectAll: 'Select All',
    view: 'View', reload: 'Reload', devtools: 'Toggle Developer Tools', actualSize: 'Actual Size',
    zoomIn: 'Zoom In', zoomOut: 'Zoom Out', fullscreen: 'Toggle Full Screen',
    service: 'Service', switchVersion: 'Switch dsh Version…', serverLog: 'Open Server Log', config: 'Open Config File',
    window: 'Window', minimize: 'Minimize', zoom: 'Zoom', front: 'Bring All to Front',
    about: `About ${APP_TITLE}`, hide: `Hide ${APP_TITLE}`, hideOthers: 'Hide Others', showAll: 'Show All',
    quit: `Quit ${APP_TITLE}`,
  },
}

/** Read the dsh UI language preference from ~/.dsh/settings.yaml (YAML subset). */
function readLocalePreference() {
  try {
    const lines = readFileSync(path.join(DSH_HOME, 'settings.yaml'), 'utf8').split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      if (!/^locale:\s*$/.test(lines[i])) continue
      for (let j = i + 1; j < lines.length; j += 1) {
        const line = lines[j]
        if (/^\S/.test(line)) break // next top-level key
        const match = /^\s+preference:\s*"?([a-z]+)"?\s*$/.exec(line)
        if (match && (match[1] === 'zh' || match[1] === 'en')) return match[1]
      }
    }
  } catch {
    /* no settings file yet */
  }
  return null
}

/** dsh's own default: no explicit preference follows the browser/system language. */
function systemLanguage() {
  return (app.getLocale() ?? 'en').toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/** @type {'zh' | 'en' | null} */
let menuLang = null

/** Rebuild the application menu when the dsh language changed. */
function syncMenuLanguage() {
  const lang = readLocalePreference() ?? systemLanguage()
  if (lang !== menuLang) {
    menuLang = lang
    buildMenu(lang)
    log(`menu language synced: ${lang}`)
  }
}

/**
 * @param {'zh' | 'en'} lang - active menu language.
 */
function buildMenu(lang) {
  const t = MENU_L10N[lang]
  const template = [
    ...(IS_MAC ? [{
      label: app.name,
      submenu: [
        { role: 'about', label: t.about },
        { type: 'separator' },
        { role: 'hide', label: t.hide },
        { role: 'hideOthers', label: t.hideOthers },
        { role: 'unhide', label: t.showAll },
        { type: 'separator' },
        { role: 'quit', label: t.quit },
      ],
    }] : []),
    {
      label: t.file,
      submenu: [
        {
          label: t.newWindow,
          accelerator: 'CmdOrCtrl+N',
          click: () => openNewWindow(),
        },
        ...(IS_MAC ? [] : [{ type: 'separator' }, { role: 'quit', label: t.quit }]),
      ],
    },
    {
      // The Edit menu roles are what make ⌘C/⌘V/⌘X/⌘A work in Electron
      // (accelerators come from the menu on macOS and Windows alike).
      label: t.edit,
      submenu: [
        { role: 'undo', label: t.undo },
        { role: 'redo', label: t.redo },
        { type: 'separator' },
        { role: 'cut', label: t.cut },
        { role: 'copy', label: t.copy },
        { role: 'paste', label: t.paste },
        { role: 'pasteAndMatchStyle', label: t.pasteAndMatch },
        { role: 'delete', label: t.delete },
        { role: 'selectAll', label: t.selectAll },
      ],
    },
    {
      label: t.view,
      submenu: [
        { role: 'reload', label: t.reload },
        { role: 'toggleDevTools', label: t.devtools },
        { type: 'separator' },
        { role: 'resetZoom', label: t.actualSize },
        { role: 'zoomIn', label: t.zoomIn },
        { role: 'zoomOut', label: t.zoomOut },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t.fullscreen },
      ],
    },
    {
      label: t.service,
      submenu: [
        {
          label: t.switchVersion,
          click: () => {
            // Clear the remembered choice and relaunch into the picker.
            try {
              const file = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
              delete file.dshSource
              writeFileSync(CONFIG_PATH, `${JSON.stringify(file, null, 2)}\n`)
            } catch (error) {
              log(`could not clear dshSource: ${error.message}`)
            }
            app.relaunch()
            app.exit()
          },
        },
        {
          label: t.serverLog,
          click: () => { shell.openPath(SERVER_LOG) },
        },
        {
          label: t.config,
          click: () => { shell.openPath(CONFIG_PATH) },
        },
        ...(IS_MAC ? [] : [{ type: 'separator' }, { role: 'quit', label: t.quit }]),
      ],
    },
    {
      label: t.window,
      submenu: [
        { role: 'minimize', label: t.minimize },
        { role: 'zoom', label: t.zoom },
        ...(IS_MAC ? [{ type: 'separator' }, { role: 'front', label: t.front }] : []),
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/* ------------------------------ lifecycle ------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** @returns {boolean} whether a pid currently exists (signal 0 probe). */
const isAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/* ----------------------- bundled plugins seeding ----------------------- */

/** pnpm settings for a profile dir, mirroring dsh's own profile template. */
const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
# Freshly published plugin releases skip pnpm's minimum release age gate.
minimumReleaseAgeExclude:
  - dsh-better-sidebar
  - dsh-file-review
  - '@liustack/modlens'
`

/** The web profile's base bundles (dsh's shipped template). */
const WEB_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

/**
 * Initialize the web profile directory the way dsh itself does (manifest,
 * empty patch layers, pnpm settings), so seeding works on a machine where
 * dsh has never booted yet.
 * @param {string} dir - the profile directory.
 */
function initProfileDir(dir) {
  if (existsSync(path.join(dir, 'package.json'))) return
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'package.json'),
    `${JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...WEB_PROFILE_BUNDLES] } },
    }, null, 2)}\n`,
  )
  writeFileSync(path.join(dir, 'cordis.yml'), '# dsh profile root — an empty entry list.\n[]\n')
  writeFileSync(
    path.join(dir, 'cordis.patch.yml'),
    `# Your patch layer for this dsh profile, applied after every bundle layer.\n[]\n`,
  )
  writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), PROFILE_PNPM_WORKSPACE)
}

/**
 * Run `pnpm <args>` inside the profile directory through `npm exec` (npx
 * semantics) so no global pnpm/corepack installation is required.
 * @param {readonly string[]} args - pnpm arguments.
 * @param {string} cwd - the profile directory.
 * @returns {Promise<void>} resolves when pnpm exits 0.
 */
function runPnpmInProfile(args, cwd) {
  const npmCli = resolveNpmCli()
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [npmCli ?? 'npm', 'exec', '--yes', '--package=pnpm@11.7.0', '--', 'pnpm', ...args],
      {
        cwd,
        env: toolEnv({ FORCE_COLOR: '0' }),
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(IS_WIN && { shell: true }),
      },
    )
    let output = ''
    child.stdout?.on('data', (chunk) => { output += chunk })
    child.stderr?.on('data', (chunk) => { output += chunk })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`pnpm ${args.join(' ')} failed (exit ${code}):\n${output.slice(-2000)}`))
    })
  })
}

/**
 * Seed the shared web profile with the plugins bundled inside the app:
 * `bundled-plugins/manifest.json` lists them (registry versions or bundled
 * tarballs). Each plugin missing from `dsh.profile.bundles` is installed via
 * pnpm into the profile and appended to the bundle layer list when it
 * declares `dsh.bundle`. Already-present plugins are left untouched, so the
 * step is a fast no-op after the first run.
 * @returns {Promise<void>}
 */
async function ensureBundledPlugins() {
  const manifestPath = path.join(app.getAppPath(), 'bundled-plugins', 'manifest.json')
  if (!existsSync(manifestPath)) return
  const profileDir = path.join(DSH_HOME, 'profiles', 'web')
  initProfileDir(profileDir)
  const manifestPathInProfile = path.join(profileDir, 'package.json')

  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    log(`bundled-plugins manifest unreadable: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  const plugins = Array.isArray(manifest.plugins) ? manifest.plugins : []

  for (const entry of plugins) {
    const name = typeof entry?.name === 'string' ? entry.name : null
    if (!name) continue
    const profile = JSON.parse(readFileSync(manifestPathInProfile, 'utf8'))
    const bundles = Array.isArray(profile.dsh?.profile?.bundles) ? profile.dsh.profile.bundles : []
    if (bundles.includes(name)) {
      log(`bundled plugin ${name} already present`)
      continue
    }
    const spec = typeof entry.tarball === 'string'
      ? path.join(app.getAppPath(), 'bundled-plugins', entry.tarball)
      : typeof entry.registry === 'string' ? `${name}@${entry.registry}` : name
    log(`bundled plugin ${name} missing — installing ${spec}`)
    try {
      await runPnpmInProfile(['add', spec], profileDir)
    } catch (error) {
      // pnpm may exit 1 on peer warnings while still installing the package;
      // treat a resolvable install as success and keep going either way.
      const landed = existsSync(path.join(profileDir, 'node_modules', name, 'package.json'))
      log(landed
        ? `bundled plugin ${name} installed despite a pnpm warning (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`
        : `bundled plugin ${name} install failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
      if (!landed) continue
    }
    // Append to the bundle layer list when the package declares a bundle patch.
    const installedManifest = path.join(profileDir, 'node_modules', name, 'package.json')
    try {
      const installed = JSON.parse(readFileSync(installedManifest, 'utf8'))
      if (installed.dsh?.bundle?.patch !== undefined) {
        const after = JSON.parse(readFileSync(manifestPathInProfile, 'utf8'))
        const current = Array.isArray(after.dsh?.profile?.bundles) ? after.dsh.profile.bundles : []
        if (!current.includes(name)) {
          after.dsh.profile.bundles = [...current, name]
          writeFileSync(manifestPathInProfile, `${JSON.stringify(after, null, 2)}\n`)
          log(`bundled plugin ${name} joined the bundle layer`)
        }
      }
    } catch (error) {
      log(`could not reconcile bundle layer for ${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * Seed user-level agent presets bundled inside the app: each preset id in
 * `bundled-plugins/manifest.json` "presets" is copied from
 * `bundled-plugins/presets/<id>/` into `~/.dsh/.agent-presets/<id>/` when
 * missing (existing presets are never overwritten).
 * @returns {Promise<void>}
 */
async function ensureBundledPresets() {
  const manifestPath = path.join(app.getAppPath(), 'bundled-plugins', 'manifest.json')
  if (!existsSync(manifestPath)) return
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return
  }
  const presets = Array.isArray(manifest.presets) ? manifest.presets : []
  const presetRoot = path.join(DSH_HOME, '.agent-presets')
  for (const id of presets) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(id)) continue
    const target = path.join(presetRoot, id)
    if (existsSync(target)) continue
    const source = path.join(app.getAppPath(), 'bundled-plugins', 'presets', id)
    if (!existsSync(source)) continue
    try {
      cpSync(source, target, { recursive: true })
      log(`bundled preset ${id} seeded into ${target}`)
    } catch (error) {
      log(`could not seed preset ${id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

async function boot() {
  mkdirSync(DSH_HOME, { recursive: true })
  const config = loadConfig()
  log(`starting dsh-desktop (${config.host}:${config.port}, dshSource ${config.dshSource ?? 'unset'})`)
  syncMenuLanguage()
  launchConfig = config

  try {
    // Seed bundled plugins while the user decides in the picker; failures
    // never block the app (the plugins are a convenience, not a dependency).
    const seedPromise = ensureBundledPlugins().catch((error) => {
      log(`bundled plugins seeding failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    const presetsPromise = ensureBundledPresets()
    const source = await pickSource(config.dshSource, config.dshSourceFromCli)
    if (source.id !== config.dshSource) rememberSourceSelection(source.id)
    log(`using dsh source: ${source.id}`)
    launchSource = source
    await seedPromise
    await presetsPromise

    const first = new ServerManager(config, source)
    servers.add(first)
    const mode = await first.ensure()
    log(`server ${mode}; opening window on ${first.url}`)
    createWindow(first.url, first)
    // Dev test hook: exercise the ⌘N isolated-window path automatically.
    if (process.env.DSH_DESKTOP_AUTO_NEW_WINDOW) {
      setTimeout(() => void openNewWindow(), 3000)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(`boot failed: ${message}`)
    // Closing the picker is a deliberate cancel, not a failure.
    if (message !== 'no dsh source chosen') {
      // Fixed-size scrollable error window; quits the app when closed.
      showBootError(`${APP_TITLE} 启动失败`, message).on('closed', () => app.quit())
      return
    }
    app.quit()
  }
}

// Single instance: a second launch focuses the existing window instead.
// DSH_DESKTOP_USER_DATA isolates the lock for parallel dev-mode testing.
if (process.env.DSH_DESKTOP_USER_DATA) {
  app.setPath('userData', process.env.DSH_DESKTOP_USER_DATA)
}
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    for (const win of windows) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })

  app.whenReady().then(boot)

  app.on('activate', () => {
    // macOS dock click with no windows left: start a fresh server + window.
    if (windows.size === 0) void openNewWindow()
  })

  // Stop every server this app spawned; attached servers are never touched.
  app.on('before-quit', () => {
    for (const owned of servers) owned.stop()
  })

  app.on('window-all-closed', () => {
    if (!IS_MAC) app.quit()
  })
}

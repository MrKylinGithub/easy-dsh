// @ts-check
/**
 * Packaging entry: pins electron-builder's downloads to npmmirror mirrors and
 * uses a locally cached icons toolset so builds never hang on GitHub from
 * this network. The toolset downloads automatically on first use (verified
 * against its sha256), so a fresh clone builds without manual steps.
 * Works on macOS and Windows (no shell env syntax needed).
 * @module dsh-desktop/scripts/build
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const TOOLSET_VERSION = 'icons@1.1.0'
const TOOLSET_SHA256 = '2241c9501aa5ddd19317956449f50a1bc311df2c34058aae9bf8bfe62081eaec'
const TOOLSET_URL =
  `https://cdn.npmmirror.com/binaries/electron-builder-binaries/${TOOLSET_VERSION}/icons-bundle.tar.gz`
const TOOLSET_DIR = fileURLToPath(new URL('../tools/icons/', import.meta.url))
const BUNDLE_DIR = path.join(TOOLSET_DIR, 'icons-bundle')

async function ensureToolset() {
  if (existsSync(path.join(BUNDLE_DIR, 'icon-tool.js'))) return
  console.log(`icons toolset missing — downloading from ${TOOLSET_URL}`)
  mkdirSync(TOOLSET_DIR, { recursive: true })
  const archive = path.join(TOOLSET_DIR, 'icons-bundle.tar.gz')
  const response = await fetch(TOOLSET_URL)
  if (!response.ok || !response.body) {
    throw new Error(`icons toolset download failed: HTTP ${response.status}`)
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive))
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex')
  if (digest !== TOOLSET_SHA256) {
    rmSync(archive, { force: true })
    throw new Error(`icons toolset checksum mismatch: got ${digest}, want ${TOOLSET_SHA256}`)
  }
  const tar = spawnSync('tar', ['-xzf', archive, '-C', TOOLSET_DIR], { stdio: 'inherit' })
  rmSync(archive, { force: true })
  if (tar.status !== 0) throw new Error('icons toolset extraction failed')
  // The bundle is CommonJS; isolate it from the root "type": "module".
  writeFileSync(path.join(BUNDLE_DIR, 'package.json'), '{\n  "type": "commonjs"\n}\n')
}

await ensureToolset()

// Bundle the built-in dsh source (mode ①): the official latest release
// installed into builtin-dsh/, shipped inside the app for offline first run.
const BUILTIN_DIR = fileURLToPath(new URL('../builtin-dsh/', import.meta.url))
const BUILTIN_BIN = path.join(BUILTIN_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
if (!existsSync(BUILTIN_BIN)) {
  console.log(`bundling built-in dsh: npm install @deepseek-ai/dsh@latest into ${BUILTIN_DIR}`)
  const install = spawnSync(
    'npm',
    ['install', '--no-save', '--no-audit', '--no-fund', '--loglevel', 'error', '--prefix', BUILTIN_DIR, '@deepseek-ai/dsh@latest'],
    {
      stdio: 'inherit',
      env: { ...process.env, npm_config_registry: process.env.NPM_CONFIG_REGISTRY || 'https://registry.npmmirror.com' },
    },
  )
  if (install.status !== 0 || !existsSync(BUILTIN_BIN)) {
    throw new Error('built-in dsh install failed')
  }
} else {
  console.log('built-in dsh already bundled')
}

process.env.ELECTRON_BUILDER_ICONS_TOOLSET_DIR = BUNDLE_DIR
process.env.ELECTRON_BUILDER_BINARIES_MIRROR ??= 'https://npmmirror.com/mirrors/electron-builder-binaries/'
process.env.ELECTRON_MIRROR ??= 'https://npmmirror.com/mirrors/electron/'
process.env.CSC_IDENTITY_AUTO_DISCOVERY ??= 'false'

const result = spawnSync('npx', ['electron-builder', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
})
process.exit(result.status ?? 1)

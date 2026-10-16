#!/usr/bin/env node
// Drives Chromium tabs against the Realtime Database emulator and counts the
// bytes Firebase sends to each tab.
//
//   npm run bench:cost -w lib -- --label baseline [--compare docs/cost/X.json]
//       [--scenarios solo-open,session,late-joiner,large-doc] [--size-kb 200]
//       [--peers 8] [--large-size-kb 5120] [--idle-minutes 0] [--debug]
//
// Results are written to <repo>/docs/cost/<label>.{json,md}.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { CATEGORIES, Meter, diff, sum } from './meter.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')
const NAMESPACE = 'firetap-bench'

const { values: opts } = parseArgs({
  options: {
    label: { type: 'string', default: 'local' },
    compare: { type: 'string' },
    scenarios: { type: 'string', default: 'solo-open,session,late-joiner,large-doc' },
    'size-kb': { type: 'string', default: '200' },
    peers: { type: 'string', default: '8' },
    'large-size-kb': { type: 'string', default: '5120' },
    'idle-minutes': { type: 'string', default: '0' },
    debug: { type: 'boolean', default: false },
  },
})

// Re-run under the emulator when it isn't already running.
if (!process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
  const self = relative(repoRoot, fileURLToPath(import.meta.url))
  const passThrough = process.argv.slice(2).map((a) => JSON.stringify(a)).join(' ')
  const result = spawnSync(
    'firebase',
    ['emulators:exec', '--only', 'database', '--project', 'demo-firetap', `node ${self} ${passThrough}`],
    { cwd: repoRoot, stdio: 'inherit' }
  )
  process.exit(result.status ?? 1)
}

const emulatorHost = process.env.FIREBASE_DATABASE_EMULATOR_HOST
const sizeBytes = Number(opts['size-kb']) * 1024
const largeSizeBytes = Number(opts['large-size-kb']) * 1024
const peers = Number(opts.peers)
const idleMinutes = Number(opts['idle-minutes'])

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const kb = (n) => (n / 1024).toFixed(1)

const esbuild = await import('esbuild')
const outDir = join(here, '.out')
await esbuild.build({
  entryPoints: [join(here, 'page.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  outfile: join(outDir, 'page.js'),
  logLevel: 'warning',
})
const pageJs = readFileSync(join(outDir, 'page.js'))
const server = createServer((req, res) => {
  if (req.url?.startsWith('/page.js')) {
    res.writeHead(200, { 'content-type': 'text/javascript' })
    res.end(pageJs)
  } else {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><meta charset="utf-8"><script type="module" src="/page.js"></script>')
  }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const pageUrl = `http://127.0.0.1:${server.address().port}/?emu=${emulatorHost}&ns=${NAMESPACE}${opts.debug ? '&debug=1' : ''}`

await fetch(`http://${emulatorHost}/.settings/rules.json?ns=${NAMESPACE}`, {
  method: 'PUT',
  headers: { Authorization: 'Bearer owner' },
  body: JSON.stringify({ rules: { '.read': true, '.write': true } }),
})

const { chromium } = await import('playwright')
const browser = await chromium.launch({
  // Use host candidates instead of mDNS names so local tabs can reach each other.
  args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
})

class Client {
  constructor(name, { metered = true } = {}) {
    this.name = name
    this.metered = metered
    this.meters = []
    this.page = null
  }

  async open(openOpts) {
    if (!this.context) this.context = await browser.newContext()
    this.page = await this.context.newPage()
    if (this.metered) {
      this.page.on('websocket', (ws) => {
        if (!ws.url().includes(emulatorHost)) return
        const meter = new Meter()
        this.meters.push(meter)
        ws.on('framesent', ({ payload }) => meter.onSent(payload))
        ws.on('framereceived', ({ payload }) => meter.onReceived(payload))
      })
    }
    this.page.on('pageerror', (e) => console.warn(`[${this.name}] page error:`, e.message))
    this.page.on('console', (msg) => {
      if (opts.debug || msg.type() === 'error' || msg.type() === 'warning') console.warn(`[${this.name}] ${msg.text()}`)
    })
    await this.page.goto(pageUrl)
    await this.page.waitForFunction(() => '__fx' in window)
    this.openOpts = openOpts
    return this.eval((o) => window.__fx.open(o), { ...openOpts, name: this.name })
  }

  eval(fn, arg) {
    return this.page.evaluate(fn, arg)
  }

  async close() {
    if (!this.page) return
    await this.eval(() => window.__fx.close()).catch(() => {})
    await this.page.close()
    this.page = null
  }

  async reload() {
    await this.close()
    await this.open(this.openOpts)
  }

  bytes() {
    return sum(this.meters.map((m) => m.snapshot()))
  }

  async dispose() {
    await this.close()
    await this.context?.close()
  }
}

function totals(clients) {
  return sum(clients.map((c) => c.bytes()))
}

async function waitForMesh(clients, expectedPeers, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let counts = []
  while (Date.now() < deadline) {
    counts = await Promise.all(clients.map((c) => c.eval(() => window.__fx.peerCount())))
    if (counts.every((n) => n >= expectedPeers)) return { ok: true, counts }
    await sleep(500)
  }
  return { ok: false, counts }
}

async function converged(clients) {
  const hashes = await Promise.all(clients.map((c) => c.eval(() => window.__fx.textHash())))
  return { ok: hashes.every((h) => h === hashes[0]), hashes }
}

function freshDoc(label) {
  return {
    docId: `doc-${label}`,
    basePath: `/bench-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  }
}

async function seedDocument(doc, targetBytes) {
  const seeder = new Client('seeder', { metered: false })
  await seeder.open(doc)
  const actual = await seeder.eval((n) => window.__fx.seed(n), targetBytes)
  await seeder.eval(() => window.__fx.save())
  await seeder.dispose()
  return actual
}

const scenarios = {
  /** One user opens a document, then reloads once. */
  async 'solo-open'() {
    const doc = freshDoc('solo')
    const stateBytes = await seedDocument(doc, sizeBytes)
    const c = new Client('solo')
    await c.open(doc)
    await sleep(3000)
    const first = c.bytes()
    await c.reload()
    await sleep(3000)
    const second = diff(c.bytes(), first)
    await c.dispose()
    return { params: { stateBytes }, phases: { 'first open': first, reopen: second } }
  },

  /** N users join, type, and each reloads twice. */
  async session() {
    const doc = freshDoc('session')
    const stateBytes = await seedDocument(doc, sizeBytes)
    const clients = Array.from({ length: peers }, (_, i) => new Client(`user-${i + 1}`))
    const marks = {}
    const t0 = Date.now()

    for (const c of clients) {
      await c.open(doc)
      await sleep(500)
    }
    const mesh = await waitForMesh(clients, peers - 1, 90_000)
    marks.join = totals(clients)

    await Promise.all(clients.map((c, i) => c.eval(([n, ms, s]) => window.__fx.type(n, ms, s), [100, 100, 10 + i])))
    await sleep(4000)
    marks.edit = totals(clients)

    for (let round = 0; round < 2; round++) {
      for (const c of clients) await c.reload()
    }
    const meshAfterReloads = await waitForMesh(clients, peers - 1, 90_000)
    marks.reloads = totals(clients)

    if (idleMinutes > 0) await sleep(idleMinutes * 60_000)
    await sleep(3000)
    marks.idle = totals(clients)
    const convergence = await converged(clients)

    await Promise.all(clients.map((c) => c.dispose()))
    return {
      params: { stateBytes, peers, idleMinutes, durationS: Math.round((Date.now() - t0) / 1000) },
      health: { mesh: mesh.counts, meshAfterReloads: meshAfterReloads.counts, converged: convergence.ok },
      phases: {
        join: marks.join,
        edit: diff(marks.edit, marks.join),
        'reload x2': diff(marks.reloads, marks.edit),
        idle: diff(marks.idle, marks.reloads),
      },
    }
  },

  /** N-1 users are connected; measure what one more joiner costs. */
  async 'late-joiner'() {
    const doc = freshDoc('late')
    const stateBytes = await seedDocument(doc, sizeBytes)
    const present = Array.from({ length: peers - 1 }, (_, i) => new Client(`user-${i + 1}`))
    for (const c of present) {
      await c.open(doc)
      await sleep(500)
    }
    await waitForMesh(present, peers - 2, 90_000)
    const before = totals(present)

    const joiner = new Client('joiner')
    await joiner.open(doc)
    const mesh = await waitForMesh([...present, joiner], peers - 1, 60_000)
    await sleep(3000)

    const result = {
      params: { stateBytes, peers },
      health: { mesh: mesh.counts },
      phases: { joiner: joiner.bytes(), 'others (during join)': diff(totals(present), before) },
    }
    await Promise.all([...present, joiner].map((c) => c.dispose()))
    return result
  },

  /** A large document: one user opens it, then a second user joins. */
  async 'large-doc'() {
    const doc = freshDoc('large')
    const stateBytes = await seedDocument(doc, largeSizeBytes)
    const a = new Client('large-a')
    const b = new Client('large-b')
    await a.open(doc)
    await sleep(2000)
    await b.open(doc)
    const mesh = await waitForMesh([a, b], 1, 60_000)
    await sleep(3000)
    const convergence = await converged([a, b])
    const result = {
      params: { stateBytes },
      health: { mesh: mesh.counts, converged: convergence.ok },
      phases: { 'first open': a.bytes(), 'second open': b.bytes() },
    }
    await a.dispose()
    await b.dispose()
    return result
  },
}

const results = { label: opts.label, date: new Date().toISOString(), emulator: true, scenarios: {} }
for (const name of opts.scenarios.split(',')) {
  if (!scenarios[name]) throw new Error(`Unknown scenario: ${name}`)
  process.stdout.write(`Running ${name}... `)
  const started = Date.now()
  try {
    results.scenarios[name] = await scenarios[name]()
    console.log(`done in ${Math.round((Date.now() - started) / 1000)}s`)
  } catch (error) {
    results.scenarios[name] = { error: String(error?.stack ?? error) }
    console.log('FAILED\n', error)
  }
}

await browser.close()
server.close()

const previous = opts.compare ? JSON.parse(readFileSync(resolve(repoRoot, opts.compare), 'utf8')) : null
const markdown = renderMarkdown(results, previous)
const outBase = join(repoRoot, 'docs', 'cost')
mkdirSync(outBase, { recursive: true })
writeFileSync(join(outBase, `${opts.label}.json`), JSON.stringify(results, null, 2))
writeFileSync(join(outBase, `${opts.label}.md`), markdown)
console.log(`\n${markdown}\nWrote docs/cost/${opts.label}.{json,md}`)

function renderMarkdown(res, prev) {
  const lines = [`# Firebase cost: ${res.label}`, '', `${res.date} · emulator, bytes received by clients (KB)`, '']
  lines.push('Bytes are WebSocket payloads from the emulator. Production adds TLS framing and a handshake per connection.', '')
  for (const [name, s] of Object.entries(res.scenarios)) {
    lines.push(`## ${name}`, '')
    if (s.error) {
      lines.push('```', s.error, '```', '')
      continue
    }
    lines.push(`Params: \`${JSON.stringify(s.params)}\``)
    if (s.health) lines.push(`Health: \`${JSON.stringify(s.health)}\``)
    lines.push('')
    const cols = ['phase', ...CATEGORIES, 'total']
    if (prev) cols.push('prev total', 'change')
    lines.push(`| ${cols.join(' | ')} |`, `|${cols.map(() => '---').join('|')}|`)
    for (const [phase, b] of Object.entries(s.phases)) {
      const row = [phase, ...CATEGORIES.map((c) => kb(b.received[c])), `**${kb(b.total)}**`]
      if (prev) {
        const p = prev.scenarios?.[name]?.phases?.[phase]
        row.push(p ? kb(p.total) : '–', p && p.total ? `${(((b.total - p.total) / p.total) * 100).toFixed(0)}%` : '–')
      }
      lines.push(`| ${row.join(' | ')} |`)
    }
    const all = sum(Object.values(s.phases))
    const allRow = ['**all**', ...CATEGORIES.map((c) => kb(all.received[c])), `**${kb(all.total)}**`]
    if (prev && prev.scenarios?.[name]?.phases) {
      const p = sum(Object.values(prev.scenarios[name].phases))
      allRow.push(kb(p.total), p.total ? `${(((all.total - p.total) / p.total) * 100).toFixed(0)}%` : '–')
    }
    lines.push(`| ${allRow.join(' | ')} |`, '')
  }
  return lines.join('\n')
}

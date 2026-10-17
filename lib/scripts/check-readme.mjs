// Typechecks every ```ts block in README.md against the library source.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const lib = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(lib, '.readme-check')
const blocks = [...readFileSync(join(lib, 'README.md'), 'utf8').matchAll(/```ts\n([\s\S]*?)```/g)]

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir)
blocks.forEach(([, code], i) => writeFileSync(join(outDir, `snippet-${i + 1}.ts`), `${code}\nexport {}\n`))
writeFileSync(
  join(outDir, 'tsconfig.json'),
  JSON.stringify({
    extends: '../tsconfig.json',
    compilerOptions: { noEmit: true, target: 'ES2022', module: 'ESNext', paths: { firetap: ['../index.ts'], 'firetap/server': ['../server.ts'] } },
    include: ['*.ts'],
  })
)

try {
  execFileSync(join(lib, '../node_modules/.bin/tsc'), ['-p', join(outDir, 'tsconfig.json')], { stdio: 'inherit' })
  console.log(`README: ${blocks.length} TypeScript snippets typecheck.`)
} catch {
  process.exitCode = 1
}

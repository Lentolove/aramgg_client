// 打包并运行 collect.ts / report.ts（esbuild，electron 替换为本地桩）
import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const here = dirname(fileURLToPath(import.meta.url))
const name = process.argv[2] || 'report'
const outfile = join(here, `.${name}.bundle.mjs`)
await build({ entryPoints: [join(here, `${name}.ts`)], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile, alias: { electron: join(here, 'electron-stub.mjs') }, logLevel: 'warning' })
await import(pathToFileURL(outfile).href)

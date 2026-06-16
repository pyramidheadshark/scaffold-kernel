#!/usr/bin/env bun
/**
 * CI build script for scaffold-kernel.
 * Uses @opentui/solid bun plugin for correct SolidJS JSX transform.
 * Usage: bun run script/ci-build.ts <bun-target> <outfile>
 */
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { $ } from "bun"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

const bunTarget = process.argv[2]
const outfile = process.argv[3]

if (!bunTarget || !outfile) {
  console.error("Usage: bun run ci-build.ts <bun-target> <outfile>")
  console.error("  e.g. bun run ci-build.ts bun-linux-x64 ../../dist/scaffold-linux-x64")
  process.exit(1)
}

process.chdir(dir)

// Step 1: generate models snapshot
console.log("Generating models snapshot...")
await import("./generate.ts")

// Step 2: load migrations
const migrationBaseDir = path.join(dir, "migration")
const migrationDirs = (
  await fs.promises.readdir(migrationBaseDir, { withFileTypes: true })
)
  .filter((e) => e.isDirectory() && /^\d{14}/.test(e.name))
  .map((e) => e.name)
  .sort()

const migrations = await Promise.all(
  migrationDirs.map(async (name) => {
    const file = path.join(migrationBaseDir, name, "migration.sql")
    const sql = await Bun.file(file).text()
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(name)
    const timestamp = match
      ? Date.UTC(
          Number(match[1]),
          Number(match[2]) - 1,
          Number(match[3]),
          Number(match[4]),
          Number(match[5]),
          Number(match[6]),
        )
      : 0
    return { sql, timestamp, name }
  }),
)
console.log(`Loaded ${migrations.length} migrations`)

// Step 3: resolve parser worker and TUI worker
const localParserPath = path.resolve(dir, "node_modules/@opentui/core/parser.worker.js")
const rootParserPath = path.resolve(dir, "../../node_modules/@opentui/core/parser.worker.js")
const parserWorker = fs.realpathSync(
  fs.existsSync(localParserPath) ? localParserPath : rootParserPath,
)
const workerPath = "./src/cli/cmd/tui/worker.ts"

// Step 4: install cross-platform optional deps (needed for embedded native modules)
const pkg = await Bun.file(path.join(dir, "package.json")).json()
await $`bun install --os="*" --cpu="*" @opentui/core@${pkg.dependencies["@opentui/core"]}`
await $`bun install --os="*" --cpu="*" @parcel/watcher@${pkg.dependencies["@parcel/watcher"]}`

// Step 5: build with SolidJS plugin
const isWindows = bunTarget.includes("windows")
const bunfsRoot = isWindows ? "B:/~BUN/root/" : "/$bunfs/root/"
const workerRelativePath = path.relative(dir, parserWorker).replaceAll("\\", "/")
const isLinux = bunTarget.includes("linux")
const isMusl = bunTarget.includes("musl")

const plugin = createSolidTransformPlugin()
const version = pkg.version

console.log(`Building ${bunTarget} → ${outfile}`)

const result = await Bun.build({
  conditions: ["browser"],
  tsconfig: "./tsconfig.json",
  plugins: [plugin],
  external: ["node-gyp"],
  format: "esm",
  minify: true,
  splitting: true,
  compile: {
    autoloadBunfig: false,
    autoloadDotenv: false,
    autoloadTsconfig: true,
    autoloadPackageJson: true,
    target: bunTarget as Parameters<typeof Bun.build>[0]["compile"] extends infer C
      ? C extends { target?: infer T }
        ? T
        : never
      : never,
    outfile,
    execArgv: [`--user-agent=scaffold/${version}`, "--use-system-ca", "--"],
    windows: {},
  },
  entrypoints: ["./src/index.ts", parserWorker, workerPath],
  define: {
    MIMOCODE_VERSION: `'${version}'`,
    OPENCODE_MIGRATIONS: JSON.stringify(migrations),
    OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + workerRelativePath,
    OPENCODE_WORKER_PATH: workerPath,
    MIMOCODE_CHANNEL: `'stable'`,
    OPENCODE_LIBC: isLinux ? `'${isMusl ? "musl" : "glibc"}'` : `''`,
  },
})

if (!result.success) {
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}

console.log(`Done: ${outfile}`)

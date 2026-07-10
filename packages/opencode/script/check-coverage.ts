#!/usr/bin/env bun

type QualityGates = {
  coverage?: {
    functions?: number
    lines?: number
    branches?: number
    include?: string[]
    lcov?: string
  }
  stages?: Record<
    string,
    {
      coverage?: {
        functions?: number
        lines?: number
        branches?: number
        include?: string[]
        lcov?: string
      }
    }
  >
}

type Counter = {
  hit: number
  found: number
}

const gates: QualityGates = await Bun.file(new URL("../../../.quality-gates.json", import.meta.url)).json()
const args = Bun.argv.slice(2)
const stageFlag = args.findIndex((arg) => arg === "--stage")
const stageName = stageFlag >= 0 ? args[stageFlag + 1] : undefined
if (stageFlag >= 0 && !stageName) {
  console.error("coverage gate: --stage requires a stage name")
  process.exit(1)
}

const selected = stageName ? gates.stages?.[stageName]?.coverage : gates.coverage
if (stageName && !selected) {
  console.error(`coverage gate: unknown coverage stage ${stageName}`)
  process.exit(1)
}

const lcovPath = selected?.lcov ?? "coverage/lcov.info"
const file = Bun.file(new URL(`../${lcovPath}`, import.meta.url))
if (!(await file.exists())) {
  console.error(`coverage gate: ${lcovPath} not found`)
  process.exit(1)
}

function globToRegExp(pattern: string) {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
  const regex = escaped.replace(/\*\*/g, "::DOUBLE_STAR::").replace(/\*/g, "[^/]*").replace(/::DOUBLE_STAR::/g, ".*")
  return new RegExp(`^${regex}$`)
}

const includes = (selected?.include ?? []).map(globToRegExp)
const shouldCount = (sourceFile: string) => {
  if (includes.length === 0) return true
  return includes.some((pattern) => pattern.test(sourceFile))
}

const totals = {
  functions: { hit: 0, found: 0 },
  lines: { hit: 0, found: 0 },
  branches: { hit: 0, found: 0 },
}

let active = includes.length === 0
let matchedFiles = 0

for (const raw of (await file.text()).split("\n")) {
  if (raw.startsWith("SF:")) {
    const sourceFile = raw.slice(3)
    active = shouldCount(sourceFile)
    if (active) matchedFiles += 1
    continue
  }

  if (!active) continue
  if (raw.startsWith("FNF:")) totals.functions.found += Number(raw.slice(4))
  else if (raw.startsWith("FNH:")) totals.functions.hit += Number(raw.slice(4))
  else if (raw.startsWith("LF:")) totals.lines.found += Number(raw.slice(3))
  else if (raw.startsWith("LH:")) totals.lines.hit += Number(raw.slice(3))
  else if (raw.startsWith("BRF:")) totals.branches.found += Number(raw.slice(4))
  else if (raw.startsWith("BRH:")) totals.branches.hit += Number(raw.slice(4))
}

if (includes.length > 0 && matchedFiles === 0) {
  console.error("coverage gate: no files matched configured include scope")
  process.exit(1)
}

const percent = (counter: Counter) => (counter.found === 0 ? 100 : Number(((counter.hit / counter.found) * 100).toFixed(2)))
const metrics = {
  functions: percent(totals.functions),
  lines: percent(totals.lines),
  branches: percent(totals.branches),
}

console.log(`coverage gate: functions=${metrics.functions}% lines=${metrics.lines}% branches=${metrics.branches}%`)
if (includes.length > 0) {
  console.log(`coverage gate: scoped include=${selected?.include?.join(", ")}`)
}

const thresholds = {
  functions: selected?.functions ?? 90,
  lines: selected?.lines ?? 90,
  branches: selected?.branches ?? 90,
}
const metricKeys: Array<keyof typeof thresholds> = ["functions", "lines", "branches"]
const failures = metricKeys.filter((name) => metrics[name] < thresholds[name])

if (failures.length > 0) {
  for (const name of failures) {
    console.error(`coverage gate: ${name} ${metrics[name]}% is below ${thresholds[name]}%`)
  }
  process.exit(1)
}

console.log(stageName ? `coverage gate: thresholds satisfied for ${stageName}` : "coverage gate: thresholds satisfied")

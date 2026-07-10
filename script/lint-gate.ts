#!/usr/bin/env bun

import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

type QualityGates = {
  lint?: {
    warningBaseline?: number
    scope?: string[]
  }
  stages?: Record<
    string,
    {
      lint?: {
        warningBaseline?: number
        scope?: string[]
      }
    }
  >
}

const gates: QualityGates = await Bun.file(new URL("../.quality-gates.json", import.meta.url)).json()
const args = Bun.argv.slice(2)
const stageFlag = args.findIndex((arg) => arg === "--stage")
const stageName = stageFlag >= 0 ? args[stageFlag + 1] : undefined
if (stageFlag >= 0 && !stageName) {
  console.error("quality-gate: --stage requires a stage name")
  process.exit(1)
}

const selected = stageName ? gates.stages?.[stageName]?.lint : gates.lint
if (stageName && !selected) {
  console.error(`quality-gate: unknown lint stage ${stageName}`)
  process.exit(1)
}

const baseline = selected?.warningBaseline ?? 0
const scope = selected?.scope ?? []

function globToRegExp(pattern: string) {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
  const regex = escaped.replace(/\*\*/g, "::DOUBLE_STAR::").replace(/\*/g, "[^/]*").replace(/::DOUBLE_STAR::/g, ".*")
  return new RegExp(`^${regex}$`)
}

function hasScopedMatch(output: string, patterns: string[]) {
  const matchers = patterns.map(globToRegExp)
  return output
    .split("\n")
    .some((line) => line.includes(",-[") && matchers.some((matcher) => matcher.test(line.split(",-[")[1]?.split(":")[0] ?? "")))
}

const strictArgs = [
  "--deny-warnings",
  ...scope,
]

const proc = spawnSync("oxlint", strictArgs, {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  encoding: "utf8",
})

const stdout = proc.stdout ?? ""
const stderr = proc.stderr ?? ""
const exitCode = proc.status ?? 1
const output = [stdout, stderr].filter(Boolean).join("\n")
if (output.trim()) process.stdout.write(output)

const match = output.match(/Found\s+(\d+)\s+warnings\s+and\s+(\d+)\s+errors\./)
if (!match) {
  process.exit(exitCode)
}

const warnings = Number(match[1])
const errors = Number(match[2])
if (errors > 0) {
  console.error(`\nquality-gate: oxlint reported ${errors} errors`)
  process.exit(1)
}
if (scope.length > 0) {
  if (warnings > 0 || hasScopedMatch(output, scope)) {
    console.error(`\nquality-gate: scoped strict lint failed for ${scope.join(", ")}`)
    process.exit(1)
  }

  console.log(`\nquality-gate: zero-warning scoped lint passed for ${scope.join(", ")}`)
  process.exit(0)
}
if (warnings > baseline) {
  console.error(`\nquality-gate: warnings regressed from baseline ${baseline} to ${warnings}`)
  process.exit(1)
}
if (warnings > 0) {
  console.error(`\nquality-gate: warning baseline preserved (${warnings}/${baseline}). Reduce debt before enabling zero-warning mode.`)
  process.exit(0)
}

console.log(stageName ? `\nquality-gate: zero-warning strict lint passed for ${stageName}` : "\nquality-gate: zero-warning strict lint passed")

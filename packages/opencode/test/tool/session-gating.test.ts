import { describe, test, expect } from "bun:test"
import path from "path"

// [S6]: the `session` tool (peer-spawn with cwd/worktree isolation) is gated
// by agent NAME to orchestrator/prime, independent of the experimental
// MIMOCODE_EXPERIMENTAL_ORCHESTRATOR flag that gates the native `orchestrator`
// agent identity itself (agent/agent.ts) — session is unconditionally in the
// tool registry's master list (tool/registry.ts), then filtered downstream.
//
// This CANNOT be an ordinary in-suite test: test/preload.ts force-sets
// MIMOCODE_EXPERIMENTAL_ORCHESTRATOR=true for the whole suite (needed by the
// orchestrator agent's own test suites), and Flag reads env once at import
// time. An in-suite assertion would silently pass under the forced flag while
// the REAL default (flag OFF, as documented in preload.ts: "default OFF in
// prod") stayed broken — this is exactly what happened once already: a first
// version of this gate was verified only in-suite, reported "closed", and
// turned out to be dead code in the actual release (session never made it
// into the master tool list without the flag). Every assertion here runs in a
// fresh subprocess with no preload, mirroring test/agent/orchestrator.test.ts.
describe("ToolRegistry.tools: session tool gating (fresh subprocess, no forced flag)", () => {
  test("prime sees session tool without MIMOCODE_EXPERIMENTAL_ORCHESTRATOR", () => {
    const env = { MIMOCODE_EXPERIMENTAL_ORCHESTRATOR: "", MIMOCODE_EXPERIMENTAL: "" }
    const result = Bun.spawnSync({
      cmd: [process.execPath, path.join(import.meta.dir, "fixtures", "session-tool-probe.ts")],
      cwd: process.cwd(),
      env: { ...(process.env as Record<string, string>), ...env, MIMOCODE_DB: ":memory:", MIMOCODE_DISABLE_DEFAULT_PLUGINS: "true" },
    })
    const out = result.stdout.toString() + result.stderr.toString()
    expect(result.exitCode, `probe failed:\n${out}`).toBe(0)
    const m = out.match(/IDS=(\[.*\])/)
    expect(m, `probe produced no IDS line:\n${out}`).not.toBeNull()
    const ids = JSON.parse(m![1]) as string[]
    expect(ids).toContain("session")
    // full-capability sanity: prime still gets the normal editing/exec tools
    expect(ids).toContain("edit")
    expect(ids).toContain("bash")
  })

  test("build/plan/compose do NOT see session, orchestrator agent stays unregistered", () => {
    const env = { MIMOCODE_EXPERIMENTAL_ORCHESTRATOR: "", MIMOCODE_EXPERIMENTAL: "" }
    const result = Bun.spawnSync({
      cmd: [process.execPath, path.join(import.meta.dir, "fixtures", "session-tool-negative-probe.ts")],
      cwd: process.cwd(),
      env: { ...(process.env as Record<string, string>), ...env, MIMOCODE_DB: ":memory:", MIMOCODE_DISABLE_DEFAULT_PLUGINS: "true" },
    })
    const out = result.stdout.toString() + result.stderr.toString()
    expect(result.exitCode, `probe failed:\n${out}`).toBe(0)
    const m = out.match(/RESULT=(\{.*\})/)
    expect(m, `probe produced no RESULT line:\n${out}`).not.toBeNull()
    const r = JSON.parse(m![1])
    // Not resurrecting the native orchestrator agent identity (TUI mode-cycle,
    // agent dialog) — that stays behind the experimental flag, untouched.
    expect(r.orchestratorAgentExists).toBe(false)
    expect(r.build).toBe(false)
    expect(r.plan).toBe(false)
    expect(r.compose).toBe(false)
  })
})

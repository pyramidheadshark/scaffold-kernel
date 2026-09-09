import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ToolRegistry } from "../../src/tool"
import { Agent } from "../../src/agent/agent"
import { ProviderID, ModelID } from "../../src/provider/schema"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { testEffect } from "../lib/effect"
import { provideTmpdirInstance } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"

const it = testEffect(
  Layer.mergeAll(ToolRegistry.defaultLayer, Agent.defaultLayer, CrossSpawnSpawner.defaultLayer),
)

afterEach(async () => {
  await Instance.disposeAll()
})

// [S6]: the `session` tool is orchestrator-only, gated by agent NAME in
// ToolRegistry.tools (orchestrator is a full-capability agent with no
// toolAllowlist). build/plan/compose and all subagents must not see it. These
// assertions pin both halves of that gate, plus that orchestrator still
// receives the full builtin toolset (edit/bash), i.e. it is not restricted.
describe("ToolRegistry.tools: session tool orchestrator gating", () => {
  it.live("orchestrator sees the session tool AND the full toolset", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* ToolRegistry.Service
        const agents = yield* Agent.Service
        const orchestrator = yield* agents.get("orchestrator")
        if (!orchestrator) throw new Error("no orchestrator agent")
        const tools = yield* reg.tools({
          providerID: ProviderID.opencode,
          modelID: ModelID.make("opencode/claude-sonnet-4-6"),
          agent: orchestrator,
        })
        const ids = tools.map((t) => t.id)
        expect(ids).toContain("session")
        // full-capability: it also gets the normal editing/exec tools
        expect(ids).toContain("edit")
        expect(ids).toContain("bash")
      }),
    ),
  )

  it.live("build does NOT see the session tool", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* ToolRegistry.Service
        const agents = yield* Agent.Service
        const build = yield* agents.get("build")
        if (!build) throw new Error("no build agent")
        const tools = yield* reg.tools({
          providerID: ProviderID.opencode,
          modelID: ModelID.make("opencode/claude-sonnet-4-6"),
          agent: build,
        })
        expect(tools.map((t) => t.id)).not.toContain("session")
      }),
    ),
  )

  // Scaffold's `prime` role is a config-defined `mode: "all"` agent (no native
  // entry) that legitimately coordinates peer-spawned reviewers via `session`
  // create+cwd (peer+worktree isolation, imperative-weaving-wand.md Часть 54).
  // Pinned by NAME alongside orchestrator, same as the gate itself.
  it.live("config-defined agent named 'prime' sees the session tool", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const reg = yield* ToolRegistry.Service
          const agents = yield* Agent.Service
          const prime = yield* agents.get("prime")
          if (!prime) throw new Error("no prime agent")
          const tools = yield* reg.tools({
            providerID: ProviderID.opencode,
            modelID: ModelID.make("opencode/claude-sonnet-4-6"),
            agent: prime,
          })
          expect(tools.map((t) => t.id)).toContain("session")
        }),
      { config: { agent: { prime: { description: "Scaffold strategic driver" } } } },
    ),
  )

  // НЕГАТИВ: имя решает, не mode — агент с mode:"all" под ДРУГИМ именем
  // по-прежнему не видит session. Иначе гейт был бы неотличим от «любой
  // full-capability агент», а не от явного allowlist по имени.
  it.live("config-defined mode:'all' agent NOT named prime/orchestrator does NOT see session", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const reg = yield* ToolRegistry.Service
          const agents = yield* Agent.Service
          const other = yield* agents.get("some_other_full_agent")
          if (!other) throw new Error("no custom agent")
          expect(other.mode).toBe("all")
          const tools = yield* reg.tools({
            providerID: ProviderID.opencode,
            modelID: ModelID.make("opencode/claude-sonnet-4-6"),
            agent: other,
          })
          expect(tools.map((t) => t.id)).not.toContain("session")
        }),
      { config: { agent: { some_other_full_agent: { description: "not prime" } } } },
    ),
  )
})

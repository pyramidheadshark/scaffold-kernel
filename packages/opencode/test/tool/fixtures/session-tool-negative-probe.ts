// Companion negative probe for session-tool-probe.ts — checks that build/plan/
// compose (mode:"subagent") do NOT see `session`, and that the native
// `orchestrator` agent stays unregistered, all WITHOUT test/preload.ts's forced
// MIMOCODE_EXPERIMENTAL_ORCHESTRATOR=true. Prints RESULT=<json>.
import { Effect, Layer } from "effect"
import { provideInstance, tmpdir } from "../../fixture/fixture"
import { Instance } from "../../../src/project/instance"
import { Agent } from "../../../src/agent/agent"
import { ToolRegistry } from "../../../src/tool"
import { ProviderID, ModelID } from "../../../src/provider/schema"
import * as CrossSpawnSpawner from "../../../src/effect/cross-spawn-spawner"

function load<A>(dir: string, fn: () => Effect.Effect<A>) {
  return Effect.runPromise(
    provideInstance(dir)(fn()).pipe(
      Effect.provide(Layer.mergeAll(ToolRegistry.defaultLayer, Agent.defaultLayer, CrossSpawnSpawner.defaultLayer)),
    ),
  )
}

const tmp = await tmpdir({
  config: { agent: { prime: { description: "Scaffold strategic driver" }, review: { description: "Scaffold reviewer", mode: "subagent" } } },
})
const result = await Instance.provide({
  directory: tmp.path,
  fn: () =>
    load(tmp.path, () =>
      Effect.gen(function* () {
        const reg = yield* ToolRegistry.Service
        const agents = yield* Agent.Service
        const out: Record<string, boolean | string> = {}
        const orchestrator = yield* agents.get("orchestrator")
        out.orchestratorAgentExists = !!orchestrator
        for (const name of ["build", "review", "plan", "compose"]) {
          const a = yield* agents.get(name)
          if (!a) {
            out[name] = "NO_AGENT"
            continue
          }
          const tools = yield* reg.tools({
            providerID: ProviderID.opencode,
            modelID: ModelID.make("opencode/claude-sonnet-4-6"),
            agent: a,
          })
          out[name] = tools.map((t) => t.id).includes("session")
        }
        return out
      }),
    ),
})
process.stdout.write("RESULT=" + JSON.stringify(result) + "\n")
await Instance.disposeAll()
process.exit(0)

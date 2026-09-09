// Probe helper — verifies whether "prime" sees the `session` tool WITHOUT
// test/preload.ts's forced MIMOCODE_EXPERIMENTAL_ORCHESTRATOR=true. Run as a
// fresh subprocess (no preload) — mirrors test/agent/fixtures/list-agents-probe.ts.
// Prints IDS=<json array of tool ids>.
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

const tmp = await tmpdir({ config: { agent: { prime: { description: "Scaffold strategic driver" } } } })
const ids = (await Instance.provide({
  directory: tmp.path,
  fn: () =>
    load(tmp.path, () =>
      Effect.gen(function* () {
        const reg = yield* ToolRegistry.Service
        const agents = yield* Agent.Service
        const prime = yield* agents.get("prime")
        if (!prime) return ["NO_PRIME_AGENT"]
        const tools = yield* reg.tools({
          providerID: ProviderID.opencode,
          modelID: ModelID.make("opencode/claude-sonnet-4-6"),
          agent: prime,
        })
        return tools.map((t) => t.id)
      }),
    ),
})) as string[]
process.stdout.write("IDS=" + JSON.stringify(ids) + "\n")
await Instance.disposeAll()
process.exit(0)

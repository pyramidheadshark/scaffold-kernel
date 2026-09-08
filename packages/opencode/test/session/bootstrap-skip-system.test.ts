import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import * as fs from "fs/promises"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Memory } from "../../src/memory"
import { ActorRegistry } from "../../src/actor/registry"
import type { Actor } from "../../src/actor/schema"
import { Actor as ActorSpawn, type AgentOutcome, type SpawnInput } from "../../src/actor/spawn"
import { spawnRef } from "../../src/actor/spawn-ref"
import { TaskRegistry } from "../../src/task/registry"
import { SessionCheckpoint } from "../../src/session/checkpoint"
import { Log } from "../../src/util"
import { provideTmpdirInstance } from "../fixture/fixture"
import { Session as SessionNs } from "../../src/session"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { checkpointPath } from "../../src/session/checkpoint-paths"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

void Log.init({ print: false })

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const stubActorRegistry = Layer.succeed(
  ActorRegistry.Service,
  ActorRegistry.Service.of({
    register: () => Effect.die("not used"),
    updateStatus: () => Effect.void,
    updateTurn: () => Effect.void,
    updateAgent: () => Effect.void,
    get: () => Effect.succeed(undefined),
    liveness: () => Effect.succeed(undefined),
    // ⚠ Found 2026-09-08: tryStartCheckpointWriter no longer calls
    // `isSystemSpawned("main")` (that call was a tautology — see checkpoint.ts).
    // The real guard now asks `listBySession` what's registered for the
    // session, so THIS stub — not `isSystemSpawned` — is what forces the skip
    // path to fire. A fake actor row with an agent in SYSTEM_SPAWNED_AGENT_TYPES
    // is enough; the other fields are irrelevant to the guard.
    listBySession: () =>
      Effect.succeed([
        {
          sessionID: "fake-session" as SessionID,
          actorID: "checkpoint-writer-1",
          mode: "subagent",
          agent: "checkpoint-writer",
          description: "stub",
          contextMode: "full",
          background: true,
          lifecycle: "ephemeral",
          status: "running",
          lastTurnTime: 0,
          turnCount: 0,
          time: { created: Date.now() },
        } as unknown as Actor,
      ]),
    listActive: () => Effect.succeed([]),
    listByParent: () => Effect.succeed([]),
    listPeerChildren: () => Effect.succeed([]),
    renderForAgent: () => Effect.succeed(""),
    agentTypeFor: () => Effect.succeed("main"),
    // No longer read by tryStartCheckpointWriter (see checkpoint.ts) — kept only
    // because the Service interface still declares it; other consumers may.
    isSystemSpawned: () => Effect.succeed(true),
    // System actor → does not serve checkpoint (mirrors isSystemSpawned=true here).
    servesCheckpoint: () => Effect.succeed(false),
    allocateActorID: () => Effect.die("not used"),
  }),
)

// The system-spawn guard short-circuits before Actor.spawn is reached, so this
// stub never gets called — but we still need to satisfy the SessionCheckpoint
// layer's Actor.Service requirement at construction time.
const stubActor = Layer.succeed(
  ActorSpawn.Service,
  ActorSpawn.Service.of({
    spawn: () => Effect.die("Actor.spawn unexpectedly called in system-spawn skip path"),
    cancel: () => Effect.die("Actor.cancel unexpectedly called in system-spawn skip path"),
    getForkContext: () => Effect.succeed(undefined),
  }),
)

const deps = Layer.mergeAll(
  Bus.layer,
  Config.defaultLayer,
  Memory.defaultLayer,
  TaskRegistry.defaultLayer,
  stubActorRegistry,
  stubActor,
)

const env = Layer.mergeAll(
  SessionNs.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  SessionCheckpoint.layer.pipe(Layer.provide(SessionNs.defaultLayer), Layer.provideMerge(deps)),
)

describe("SessionCheckpoint.tryStartCheckpointWriter — system-spawn skip", () => {
  test("returns 'skipped' and does NOT bootstrap checkpoint.md when isSystemSpawned=true", async () => {
    await Effect.runPromise(
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const svc = yield* SessionCheckpoint.Service
          const ssn = yield* SessionNs.Service
          const info = yield* ssn.create({})

          // Seed enough state that the empty-message guard would not fire — so
          // we know it's the system-spawn guard short-circuiting the bootstrap.
          const user = yield* ssn.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: info.id,
            agent: "build",
            model: ref,
            time: { created: Date.now() },
          })
          yield* ssn.updatePart({
            id: PartID.ascending(),
            messageID: user.id,
            sessionID: info.id,
            type: "text",
            text: "seed",
          })

          const outcome = yield* svc.tryStartCheckpointWriter({
            sessionID: info.id,
            model: { providerID: "test", modelID: "test-model" },
            promptOps: {} as any,
          })
          expect(outcome).toBe("skipped")

          // Bootstrap helpers (ensureCheckpointTemplate / ensureMemoryTemplate)
          // run AFTER the system-spawn guard. With the guard active, no
          // checkpoint.md should appear on disk.
          const cpPath = checkpointPath(info.id)
          const exists = yield* Effect.promise(() =>
            fs.stat(cpPath).then(() => true).catch(() => false),
          )
          expect(exists).toBe(false)

          // Sanity: the writer table should not have been updated either.
          const running = yield* svc.isWriterRunning(info.id)
          expect(running).toBe(false)
        }),
      ).pipe(Effect.scoped, Effect.provide(env)),
    )
  })
})

describe("SessionCheckpoint.tryStartCheckpointWriter — real ActorRegistry, not a stub", () => {
  // ⚠ The test above proves the CONSUMER reacts correctly to "system-spawned" —
  // but its registry is a stub that ignores the arguments entirely, so it could
  // never have caught the tautology in the real `ActorRegistry.isSystemSpawned`
  // (its first line was `if (actorID === "main") return false`, always false,
  // regardless of what — if anything — was registered). This test exercises the
  // REAL registry (`ActorRegistry.defaultLayer`) end to end: register an actor
  // row exactly the way `Actor.spawnSubagent` does for a real checkpoint-writer
  // session, then confirm `tryStartCheckpointWriter` actually finds it and skips.
  test("real registry: a session with a registered checkpoint-writer actor is skipped", async () => {
    const dieOnSpawn = Layer.succeed(
      ActorSpawn.Service,
      ActorSpawn.Service.of({
        spawn: () => Effect.die("Actor.spawn unexpectedly called — real-registry guard did not fire"),
        cancel: () => Effect.die("not used"),
        getForkContext: () => Effect.succeed(undefined),
      }),
    )
    const realDeps = Layer.mergeAll(
      Bus.layer,
      Config.defaultLayer,
      Memory.defaultLayer,
      TaskRegistry.defaultLayer,
      ActorRegistry.defaultLayer,
      dieOnSpawn,
    )
    const realEnv = Layer.mergeAll(
      SessionNs.defaultLayer,
      CrossSpawnSpawner.defaultLayer,
      SessionCheckpoint.layer.pipe(Layer.provide(SessionNs.defaultLayer), Layer.provideMerge(realDeps)),
    )

    await Effect.runPromise(
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const svc = yield* SessionCheckpoint.Service
          const ssn = yield* SessionNs.Service
          const reg = yield* ActorRegistry.Service

          // A writer's own child session, registered the same way
          // `Actor.spawnSubagent` registers any subagent: actorID is an
          // allocated string, NEVER the literal "main".
          const writerSession = yield* ssn.create({})
          yield* reg.register({
            sessionID: writerSession.id,
            actorID: "checkpoint-writer-1",
            mode: "subagent",
            agent: "checkpoint-writer",
            description: "checkpoint writer for some parent",
            contextMode: "full",
            background: true,
            lifecycle: "ephemeral",
          })

          const outcome = yield* svc.tryStartCheckpointWriter({
            sessionID: writerSession.id,
            model: { providerID: "test", modelID: "test-model" },
            promptOps: {} as any,
          })
          expect(outcome).toBe("skipped")
        }),
      ).pipe(Effect.scoped, Effect.provide(realEnv)),
    )
  })

  test("НЕГАТИВНЫЙ: real registry with a non-system agent registered — guard does not fire", async () => {
    const captured: { called: boolean } = { called: false }
    // tryStartCheckpointWriter resolves the spawner via the module-local
    // `spawnRef` (not DI — see spawn-ref.ts, layer-cycle workaround), so a
    // plain `Layer.succeed(ActorSpawn.Service, ...)` is never read by it.
    // Mirror the wiring `checkpoint-main-slice.test.ts` uses: a `Layer.effect`
    // that assigns `spawnRef.current` as a side effect, restored on scope exit.
    const recordingActor = Layer.effect(
      ActorSpawn.Service,
      Effect.gen(function* () {
        const prev = spawnRef.current
        const impl = ActorSpawn.Service.of({
          spawn: (input: SpawnInput) =>
            Effect.gen(function* () {
              captured.called = true
              const outcome = yield* Deferred.make<AgentOutcome>()
              return { actorID: `${input.agentType}-1`, sessionID: input.sessionID, outcome }
            }),
          cancel: () => Effect.void,
          getForkContext: () => Effect.succeed(undefined),
        })
        spawnRef.current = impl
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (spawnRef.current === impl) spawnRef.current = prev
          }),
        )
        return impl
      }),
    )
    const realDeps = Layer.mergeAll(
      Bus.layer,
      Config.defaultLayer,
      Memory.defaultLayer,
      TaskRegistry.defaultLayer,
      ActorRegistry.defaultLayer,
      recordingActor,
    )
    const realEnv = Layer.mergeAll(
      SessionNs.defaultLayer,
      CrossSpawnSpawner.defaultLayer,
      SessionCheckpoint.layer.pipe(Layer.provide(SessionNs.defaultLayer), Layer.provideMerge(realDeps)),
    )

    await Effect.runPromise(
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const ssn = yield* SessionNs.Service
          const reg = yield* ActorRegistry.Service
          const svc = yield* SessionCheckpoint.Service

          const buildSession = yield* ssn.create({})
          // A ROOT session running a "build" subagent (not system-spawned) —
          // the guard must NOT mistake this for a system-spawned session.
          yield* reg.register({
            sessionID: buildSession.id,
            actorID: "build-1",
            mode: "subagent",
            agent: "build",
            description: "an ordinary delegated task",
            contextMode: "full",
            background: true,
            lifecycle: "ephemeral",
          })

          const user = yield* ssn.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: buildSession.id,
            agentID: "main",
            agent: "build",
            model: ref,
            time: { created: Date.now() },
          })
          yield* ssn.updatePart({
            id: PartID.ascending(),
            messageID: user.id,
            sessionID: buildSession.id,
            type: "text",
            text: "seed",
          })

          // We only care whether the system-spawn guard let execution reach
          // Actor.spawn — expressed as "spawn was attempted", not as the
          // eventual outcome (which the stub deliberately never resolves).
          yield* svc
            .tryStartCheckpointWriter({
              sessionID: buildSession.id,
              model: { providerID: "test", modelID: "test-model" },
              promptOps: {} as any,
            })
            .pipe(Effect.catch(() => Effect.succeed("caught" as const)))

          expect(captured.called).toBe(true)
        }),
      ).pipe(Effect.scoped, Effect.provide(realEnv)),
    )
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Exit, Cause } from "effect"
import { Log } from "../../src/util"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import type { SessionID } from "../../src/session/schema"
import { WorkflowPersistence } from "../../src/workflow/persistence"
import type { Interface as WorkflowRuntimeInterface } from "../../src/workflow/runtime"
import { workflowRef } from "../../src/workflow/runtime-ref"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

async function withWorkflowRuntimeUnset<T>(fn: () => Promise<T>) {
  const token = workflowRef.install(undefined)
  try {
    return await fn()
  } finally {
    workflowRef.release(token)
  }
}

describe("workflows routes", () => {
  test("GET /workflows returns [] when the workflow runtime is not running", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => withWorkflowRuntimeUnset(async () => {
        // #given the workflow runtime layer is not running (late-bound ref unset)
        // #when — a valid session-shaped sessionID (now REQUIRED) is supplied
        const app = Server.Default().app
        const response = await app.request("/workflows?sessionID=ses_16ec185f2ffexEGkbWeMqWSucv", { method: "GET" })

        // #then — runtime absent short-circuits to [] (the session passes validation)
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual([])
      }),
    })
  })

  test("POST /workflows/:runID/resume returns { resumed: false } when the runtime is not running", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => withWorkflowRuntimeUnset(async () => {
        // #given the workflow runtime layer is not running
        // #when — a real minted-shape runID (wf_ + 26 base62) with no persisted run
        const app = Server.Default().app
        const response = await app.request("/workflows/wf_16ec185f2ffexEGkbWeMqWSucv/resume", { method: "POST" })

        // #then
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ runID: "wf_16ec185f2ffexEGkbWeMqWSucv", resumed: false })
      }),
    })
  })

  // ── P0 (MR104 #3): path traversal via unvalidated runID ──────────────────
  // resume(runID) → readScript(runID) → scriptPath = join(scriptDir, runID + ".js").
  // A traversal runID escapes scriptDir, so the route MUST reject any runID that
  // is not exactly `wf_` + base62. The proof is that the request is REFUSED at the
  // route's param validator (400) — it never reaches the runtime/launch, so no file
  // outside scriptDir is ever opened.
  for (const evil of [
    "../../../etc/passwd",
    "../../foo",
    "/etc/passwd",
    "wf_../../../etc/passwd", // defeats a prefix-only (startsWith "wf") check
    "wf_..", // bare dot-dot after a legit prefix
  ]) {
    test(`POST /workflows/:runID/resume REJECTS traversal runID ${JSON.stringify(evil)}`, async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => withWorkflowRuntimeUnset(async () => {
          // #given the runtime is absent — so if validation let this through it would
          // hit the early `{ resumed: false }`; the only way to a 400 is param rejection.
          // #when
          const app = Server.Default().app
          const response = await app.request(`/workflows/${encodeURIComponent(evil)}/resume`, { method: "POST" })

          // #then — rejected by the param validator before any path.join / file read.
          expect(response.status).toBe(400)
        }),
      })
    })
  }

  // ── P0 (MR104 #3): GET /workflows must NOT leak all-session runs ──────────
  test("GET /workflows with NO sessionID returns 400 (does not list all runs)", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => withWorkflowRuntimeUnset(async () => {
        // #given a live-enough runtime is irrelevant: the missing required query param
        // is rejected at the validator. (Keep it unset so a regression that drops the
        // requirement would surface as a 200 [] rather than passing by accident.)
        // #when — omit sessionID entirely
        const app = Server.Default().app
        const response = await app.request("/workflows", { method: "GET" })

        // #then — rejected, NOT a 200 with the unfiltered all-runs branch.
        expect(response.status).toBe(400)
      }),
    })
  })

  test("GET /workflows with a non-session-shaped sessionID returns 400", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => withWorkflowRuntimeUnset(async () => {
        const app = Server.Default().app
        const response = await app.request("/workflows?sessionID=not-a-session", { method: "GET" })
        expect(response.status).toBe(400)
      }),
    })
  })

  // ── P0 (MR104 #3): defense-in-depth at the persistence layer ──────────────
  // readScript / journal IO are reachable from the tool + TUI, not only the HTTP
  // route, so the persistence path functions must themselves refuse a traversal
  // runID. A direct readScript("../../../etc/passwd") must FAIL (the guard throws,
  // surfacing as an Effect defect) rather than open a file outside scriptDir.
  test("WorkflowPersistence.readScript fails safely on a traversal runID (no out-of-dir read)", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const exit = await Effect.runPromiseExit(WorkflowPersistence.readScript("../../../etc/passwd"))
        // #then — the GUARD must reject it. Asserting only Exit.isFailure would
        // also pass against unguarded code (ENOENT on `…/etc/passwd.js`), so assert
        // the failure carries the guard's message — this fails closed if safeRunID
        // is ever removed.
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("invalid workflow runID")
        }
      },
    })
  })

  test("WorkflowPersistence.readScript still reads a legit wf_ runID", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // #given a normally-minted runID with a persisted script
        const runID = "wf_16ec185f2ffexEGkbWeMqWSucv"
        await Effect.runPromise(WorkflowPersistence.writeScript(runID, "export const meta = {}\n"))
        // #then — the guard does NOT break the legit path
        const body = await Effect.runPromise(WorkflowPersistence.readScript(runID))
        expect(body).toContain("export const meta")
      },
    })
  })
})

function withWorkflowRuntimeStub<T>(runtime: Pick<WorkflowRuntimeInterface, "list" | "resume">, fn: () => Promise<T>) {
  const token = workflowRef.install(runtime as WorkflowRuntimeInterface)
  return Promise.resolve()
    .then(fn)
    .finally(() => workflowRef.release(token))
}

describe("workflows routes — live runtime bridge", () => {
  test("POST /workflows/:runID/resume forwards to the live runtime", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        withWorkflowRuntimeStub(
          {
            list: () => Effect.die("list not used in resume bridge test"),
            resume: ({ runID }) => Effect.succeed({ runID, resumed: false }),
          },
          async () => {
            const response = await Server.Default().app.request(`/workflows/wf_00000000000000000000000000/resume`, {
              method: "POST",
            })

            expect(response.status).toBe(200)
            expect(await response.json()).toEqual({
              runID: "wf_00000000000000000000000000",
              resumed: false,
            })
          },
        ),
    })
  })

  test("GET /workflows forwards session-scoped rows from the live runtime", async () => {
    await using tmp = await tmpdir({ git: true })
    const sessionID = "ses_16ec185f2ffexEGkbWeMqWSucv" as SessionID
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        withWorkflowRuntimeStub(
          {
            resume: () => Effect.die("resume not used in list bridge test"),
            list: (input) =>
              Effect.succeed([
                {
                  runID: "wf_00000000000000000000000000",
                  sessionID: input?.sessionID ?? sessionID,
                  name: "wf route live",
                  status: "completed",
                  running: 0,
                  succeeded: 0,
                  failed: 0,
                  createdAt: 1,
                  updatedAt: 1,
                },
              ]),
          },
          async () => {
            const response = await Server.Default().app.request(`/workflows?sessionID=${sessionID}`, {
              method: "GET",
            })
            expect(response.status).toBe(200)
            expect(await response.json()).toEqual([
              {
                runID: "wf_00000000000000000000000000",
                sessionID,
                name: "wf route live",
                status: "completed",
                running: 0,
                succeeded: 0,
                failed: 0,
                createdAt: 1,
                updatedAt: 1,
              },
            ])
          },
        ),
    })
  })
})

import { afterEach, describe, expect } from "bun:test"
import { Cause, Effect, Layer } from "effect"
import { Bus } from "../../src/bus"
import { Session } from "../../src/session"
import { TaskRegistry } from "../../src/task/registry"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { isRecoverableError } from "../../src/tool/recoverable"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

afterEach(async () => {
  await Instance.disposeAll()
})

const env = Layer.mergeAll(
  CrossSpawnSpawner.defaultLayer,
  Bus.defaultLayer,
  Session.defaultLayer,
  TaskRegistry.defaultLayer,
)

const it = testEffect(env)

const seedSession = Effect.fn("Test.seedSession")(function* () {
  const session = yield* Session.Service
  return yield* session.create({ title: "Test" })
})

describe("TaskRegistry.create", () => {
  it.live("creates a top-level task with id T1", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()

        const task = yield* reg.create({
          session_id: sess.id,
          summary: "Refactor auth",
        })
        expect(task.id).toBe("T1")
        expect(task.status).toBe("open")
        expect(task.parent_task_id).toBeUndefined()
      }),
    ),
  )

  it.live("creates sequential top-level ids T1, T2, T3", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()

        const t1 = yield* reg.create({ session_id: sess.id, summary: "a" })
        const t2 = yield* reg.create({ session_id: sess.id, summary: "b" })
        const t3 = yield* reg.create({ session_id: sess.id, summary: "c" })
        expect(t1.id).toBe("T1")
        expect(t2.id).toBe("T2")
        expect(t3.id).toBe("T3")
      }),
    ),
  )

  it.live("creates subtask T1.1 under T1", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()

        const t1 = yield* reg.create({ session_id: sess.id, summary: "parent" })
        const sub = yield* reg.create({ session_id: sess.id, summary: "child", parent_id: t1.id })
        expect(sub.id).toBe("T1.1")
        expect(sub.parent_task_id).toBe("T1")
      }),
    ),
  )

  it.live("emits 'created' task_event on create", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()
        const t = yield* reg.create({ session_id: sess.id, summary: "x" })
        const events = yield* reg.events({ session_id: sess.id, task_id: t.id })
        expect(events.length).toBe(1)
        expect(events[0].kind).toBe("created")
      }),
    ),
  )

  it.live("two sessions can each have a T1 without colliding", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const a = yield* seedSession()
        const b = yield* seedSession()

        const ta = yield* reg.create({ session_id: a.id, summary: "in A" })
        const tb = yield* reg.create({ session_id: b.id, summary: "in B" })
        expect(ta.id).toBe("T1")
        expect(tb.id).toBe("T1")
        expect(ta.session_id).toBe(a.id)
        expect(tb.session_id).toBe(b.id)
      }),
    ),
  )
})

describe("TaskRegistry not-found is agent-recoverable", () => {
  it.live("start on a nonexistent id dies with an actionable RecoverableError", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()

        const exit = yield* Effect.exit(reg.start({ session_id: sess.id, id: "T99" }))
        expect(exit._tag).toBe("Failure")
        if (exit._tag !== "Failure") return
        const err = Cause.squash(exit.cause)
        expect(isRecoverableError(err)).toBe(true)
        expect((err as Error).message).toContain("task list")
      }),
    ),
  )
})

describe("TaskRegistry.list", () => {
  it.live("lists active tasks for a session by default", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()
        yield* reg.create({ session_id: sess.id, summary: "a" })
        yield* reg.create({ session_id: sess.id, summary: "b" })

        const list = yield* reg.list({ session_id: sess.id })
        expect(list.length).toBe(2)
      }),
    ),
  )

  it.live("excludes terminal tasks by default", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()
        const t1 = yield* reg.create({ session_id: sess.id, summary: "a" })
        yield* reg.done({ session_id: sess.id, id: t1.id })
        yield* reg.create({ session_id: sess.id, summary: "b" })

        const list = yield* reg.list({ session_id: sess.id })
        expect(list.length).toBe(1)
        expect(list[0].summary).toBe("b")
      }),
    ),
  )

  it.live("includes terminal when include_terminal=true", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()
        const t1 = yield* reg.create({ session_id: sess.id, summary: "a" })
        yield* reg.done({ session_id: sess.id, id: t1.id })

        const list = yield* reg.list({ session_id: sess.id, include_terminal: true })
        expect(list.length).toBe(1)
      }),
    ),
  )
})

// Session.fork копирует message/part через idMap, но НЕ доску задач — форкнутая сессия
// видела "Task T1 not found" на любую ссылку из старого Mission Brief. copySession
// переносит задачи и события КАК ЕСТЬ (тот же ID, тот же статус) в новую сессию.
describe("TaskRegistry.copySession", () => {
  it.live("переносит задачу с исходным ID в целевую сессию", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const source = yield* seedSession()
        const target = yield* seedSession()
        yield* reg.create({ session_id: source.id, summary: "Разобраться с багом" })

        const copied = yield* reg.copySession({ source_session_id: source.id, target_session_id: target.id })
        expect(copied).toBe(1)

        const task = yield* reg.get({ session_id: target.id, id: "T1" })
        expect(task).toBeDefined()
        expect(task?.summary).toBe("Разобраться с багом")
        expect(task?.status).toBe("open")

        // Источник остаётся нетронутым — это копия, не перенос.
        const stillInSource = yield* reg.get({ session_id: source.id, id: "T1" })
        expect(stillInSource).toBeDefined()
      }),
    ),
  )

  it.live("переносит вложенные задачи и историю событий", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const source = yield* seedSession()
        const target = yield* seedSession()
        const parent = yield* reg.create({ session_id: source.id, summary: "Родительская" })
        yield* reg.create({ session_id: source.id, summary: "Дочерняя", parent_id: parent.id })
        yield* reg.start({ session_id: source.id, id: parent.id, owner: "build" })

        yield* reg.copySession({ source_session_id: source.id, target_session_id: target.id })

        const child = yield* reg.get({ session_id: target.id, id: "T1.1" })
        expect(child).toBeDefined()
        expect(child?.parent_task_id).toBe("T1")

        const events = yield* reg.events({ session_id: target.id, task_id: parent.id })
        // "created" + "started" — обе записи истории должны были переехать.
        expect(events.length).toBe(2)
      }),
    ),
  )

  it.live("НЕГАТИВНЫЙ: закрытая задача не переоткрывается копией", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const source = yield* seedSession()
        const target = yield* seedSession()
        const t1 = yield* reg.create({ session_id: source.id, summary: "Уже сделано" })
        yield* reg.done({ session_id: source.id, id: t1.id })

        yield* reg.copySession({ source_session_id: source.id, target_session_id: target.id })

        const copied = yield* reg.get({ session_id: target.id, id: t1.id })
        expect(copied?.status).toBe("done")
      }),
    ),
  )

  it.live("НЕГАТИВНЫЙ: источник без задач не выдумывает несуществующие", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const source = yield* seedSession()
        const target = yield* seedSession()

        const copied = yield* reg.copySession({ source_session_id: source.id, target_session_id: target.id })
        expect(copied).toBe(0)

        const list = yield* reg.list({ session_id: target.id, include_terminal: true })
        expect(list.length).toBe(0)
      }),
    ),
  )
})

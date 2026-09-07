import { afterEach, describe, expect, test } from "bun:test"
import { Layer, ManagedRuntime } from "effect"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { ActorRegistry } from "../../src/actor/registry"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

const testLayer = Layer.mergeAll(Session.defaultLayer, ActorRegistry.defaultLayer)

afterEach(async () => {
  await Instance.disposeAll()
})

async function withServices(
  directory: string,
  fn: (rt: ManagedRuntime.ManagedRuntime<Session.Service | ActorRegistry.Service, never>) => Promise<void>,
) {
  return Instance.provide({
    directory,
    fn: async () => {
      const rt = ManagedRuntime.make(testLayer)
      try {
        await fn(rt)
      } finally {
        await rt.dispose()
      }
    },
  })
}

// `Session.fork` copied every message into a new session and recorded NO link back to the
// source: neither parentID, nor contextFrom, nor anything else. Continuing yesterday's work
// was therefore indistinguishable from starting from scratch — not "rare", but unobservable
// by construction. Any measurement of "did the second day continue the first" read a field
// that could not answer it.
describe("Session.fork записывает провенанс", () => {
  test("forkedFrom указывает на исходную сессию", async () => {
    await using tmp = await tmpdir({ git: true })
    await withServices(tmp.path, async (rt) => {
      const origin = await rt.runPromise(Session.Service.use((svc) => svc.create()))
      const forked = await rt.runPromise(Session.Service.use((svc) => svc.fork({ sessionID: origin.id })))

      expect(forked.id).not.toBe(origin.id)
      expect(forked.forkedFrom).toBe(origin.id)

      // Пережило чтение из БД, а не только возврат создающей функции: иначе поле «есть»
      // ровно до перезапуска, и прибор снова считает по пустому столбцу.
      const reread = await rt.runPromise(Session.Service.use((svc) => svc.get(forked.id)))
      expect(reread.forkedFrom).toBe(origin.id)
    })
  })

  test("НЕГАТИВНЫЙ: обычная сессия провенанса не получает", async () => {
    await using tmp = await tmpdir({ git: true })
    await withServices(tmp.path, async (rt) => {
      const fresh = await rt.runPromise(Session.Service.use((svc) => svc.create()))
      expect(fresh.forkedFrom).toBeUndefined()
    })
  })

  test("НЕГАТИВНЫЙ: провенанс не подменяет parentID и contextFrom", async () => {
    // parentID означает порождение субагента (сотни записей), contextFrom меняет ПОВЕДЕНИЕ —
    // по нему `message-v2.stream` подмешал бы сообщения источника поверх уже скопированных.
    // Если форк начнёт заполнять любое из них, оба смысла смешаются молча.
    await using tmp = await tmpdir({ git: true })
    await withServices(tmp.path, async (rt) => {
      const origin = await rt.runPromise(Session.Service.use((svc) => svc.create()))
      const forked = await rt.runPromise(Session.Service.use((svc) => svc.fork({ sessionID: origin.id })))
      expect(forked.parentID).toBeUndefined()
      expect(forked.contextFrom).toBeUndefined()
    })
  })
})

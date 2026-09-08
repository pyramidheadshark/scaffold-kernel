import { afterEach, describe, expect, test } from "bun:test"
import { Layer, ManagedRuntime } from "effect"
import { Database, eq } from "../../src/storage"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { ActorRegistry } from "../../src/actor/registry"
import { SessionTable } from "../../src/session/session.sql"
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

// Ребилд-лестница чекпоинтов форкнутой сессии стартует с чистого листа независимо от
// того, сколько порогов уже прошёл источник — второй "день" немедленно повторяет самый
// дорогой (первый) прогон checkpoint-writer вместо продолжения с уже пройденного места.
describe("Session.fork переносит last_checkpoint_message_id", () => {
  test("якорь чекпоинта источника — на СКОПИРОВАННОЕ сообщение, не на исходный ID", async () => {
    await using tmp = await tmpdir({ git: true })
    await withServices(tmp.path, async (rt) => {
      const origin = await rt.runPromise(Session.Service.use((svc) => svc.create()))

      const ids: string[] = []
      for (let i = 0; i < 3; i++) {
        const id = `msg_${i}` as never
        ids.push(id)
        await rt.runPromise(
          Session.Service.use((svc) =>
            svc.updateMessage({
              id,
              sessionID: origin.id,
              role: i % 2 === 0 ? "user" : "assistant",
              time: { created: Date.now() + i },
              agent: "build",
              model: { providerID: "test", modelID: "test" },
              tools: {},
              mode: "",
            } as never),
          ),
        )
      }

      // Отмечаем ВТОРОЕ сообщение (индекс 1) как последний чекпоинт источника — той же
      // прямой записью в БД, что использует сам writer (checkpoint.ts:1090).
      await Database.use((db) =>
        db.update(SessionTable).set({ last_checkpoint_message_id: ids[1] }).where(eq(SessionTable.id, origin.id)).run(),
      )

      const forked = await rt.runPromise(Session.Service.use((svc) => svc.fork({ sessionID: origin.id })))
      const rerow = await Database.use((db) =>
        db.select({ last: SessionTable.last_checkpoint_message_id }).from(SessionTable).where(eq(SessionTable.id, forked.id)).get(),
      )

      // Якорь ОБЯЗАН перевестись в НОВЫЙ ID — старый ID из ids[1] в новой сессии не
      // существует вовсе (idMap меняет id на каждое скопированное сообщение).
      expect(rerow?.last).toBeDefined();
      expect(rerow?.last).not.toBe(ids[1])
    })
  })

  test("НЕГАТИВНЫЙ: у источника нет чекпоинта — форк не выдумывает якорь", async () => {
    await using tmp = await tmpdir({ git: true })
    await withServices(tmp.path, async (rt) => {
      const origin = await rt.runPromise(Session.Service.use((svc) => svc.create()))
      const forked = await rt.runPromise(Session.Service.use((svc) => svc.fork({ sessionID: origin.id })))
      const rerow = await Database.use((db) =>
        db.select({ last: SessionTable.last_checkpoint_message_id }).from(SessionTable).where(eq(SessionTable.id, forked.id)).get(),
      )
      expect(rerow?.last).toBeFalsy()
    })
  })
})

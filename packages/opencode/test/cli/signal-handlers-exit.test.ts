import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * Обработчик сигнала обязан ЗАВЕРШАТЬ процесс.
 *
 * Навешивание `process.on`/`once` на SIGTERM отменяет дефолтное поведение — завершение.
 * Первая редакция патча про восстановление состояния этого не учла, и замер показал:
 *
 *   без обработчика      SIGTERM → процесс мёртв
 *   обработчик без exit  SIGTERM → процесс ЖИВ
 *   обработчик с exit    SIGTERM → процесс мёртв
 *
 * Следствие было хуже суммы частей: ядро переусыновлялось на systemd вместо смерти, а
 * после SIGHUP жило уже БЕЗ never-ask — и первый же `question` вешал его навсегда. Два
 * патча одного релиза складывались в тот самый вечный висяк, который релиз закрывал.
 *
 * Проверяется поведением на живом процессе, а не чтением исходника: именно поведение
 * рантайма тут и было неверно понято.
 */
describe("обработчики сигналов в run", () => {
  const fixture = path.resolve(import.meta.dir, "signal-fixture.ts")

  async function survivesSigterm(mode: string): Promise<boolean> {
    const child = Bun.spawn(["bun", fixture, mode], { stdout: "ignore", stderr: "ignore" })
    await Bun.sleep(700)
    child.kill("SIGTERM")
    for (let i = 0; i < 20; i++) {
      await Bun.sleep(100)
      if (child.killed || child.exitCode !== null || child.signalCode !== null) return false
    }
    child.kill("SIGKILL")
    return true
  }

  it("обработчик БЕЗ выхода оставляет процесс живым — это и была регрессия", async () => {
    expect(await survivesSigterm("without-exit")).toBe(true)
  }, 30_000)

  it("обработчик С выходом завершает процесс", async () => {
    expect(await survivesSigterm("with-exit")).toBe(false)
  }, 30_000)

  it("в run.ts обработчик действительно завершает процесс", () => {
    const src = readFileSync(path.resolve(import.meta.dir, "../../src/cli/cmd/run.ts"), "utf8").replace(
      /^\s*\/\/.*$/gm,
      "",
    )
    const i = src.indexOf("process.once(sig")
    expect(i, "обработчиков сигналов в run.ts нет вовсе").toBeGreaterThan(-1)
    // Выход обязан быть в теле того же обработчика, а не где-то в файле.
    expect(src.slice(i, i + 400)).toContain("process.exit(code)")
  })
})

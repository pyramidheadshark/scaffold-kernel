import path from "path"
import { pathToFileURL } from "url"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import { startScriptedLLMServer, textStopResponse, toolCallResponse } from "../lib/scripted-llm-server"

void Log.init({ print: false })

/**
 * Регрессия PI-134 (scaffold-форк): вложенные вызовы инструментов внутри `exec` обязаны
 * проходить через `tool.execute.before`, и `cancel` обязан их останавливать.
 *
 * Почему это нужно закрепить тестом. `GPT_TOP_LEVEL_TOOLS` показывает GPT/Codex-моделям
 * только `{exec, wait}`, поэтому КАЖДЫЙ пишущий инструмент у этих моделей вызывается
 * исключительно вложенно. До патча вложенная ветка звала `def.execute()` напрямую, минуя
 * хук: плагинные гейты записи не срабатывали для GPT/Codex вообще. Три месяца никто этого
 * не заметил, потому что гейт, который ослеп, не падает — он молчит.
 *
 * На этом патче держится весь внешний контур гейтов Scaffold, а покрытия у него не было:
 * `grep -rn "tool.execute.before" packages/opencode/test/` возвращал ноль. Ре-базлайн
 * апстрима мог снять патч, и первым признаком стало бы отсутствие отказов в продакшене.
 *
 * Тест проверяет ДВА разных утверждения, и оба нужны:
 *  1. хук вообще вызывается для вложенного инструмента, и приходит он под именем-алиасом
 *     `exec_command`, а не `bash` — сравнение с литералом `"bash"` уже ослепляло гейты;
 *  1а. вложенный вызов принимает `cmd`, а хук получает его уже переведённым в `command`
 *      (`execCommandArgs` в tool-script.ts). Это и есть причина, по которой плагины читают
 *      `args.command` для ОБЕИХ форм вызова и расходится только имя инструмента;
 *  2. `cancel` действительно останавливает исполнение — а не только помечает результат.
 *     Второе доказывается отсутствием файла-маркера, который команда создала бы.
 */

/**
 * `exec` показывается только GPT/Codex-семейству (`usesGPTToolset`), поэтому обычная
 * тестовая модель `alibaba/qwen-plus` его не видит — первый прогон дал `["invalid"]`
 * вместо имени инструмента. Включаем тот же набор флагом, а не подделкой имени модели:
 * подделка проверяла бы резолвер имён, а нам нужен вложенный путь исполнения.
 */
const PREV_CODEX_MODE = process.env["MIMOCODE_CODEX_MODE"]

beforeEach(() => {
  process.env["MIMOCODE_CODEX_MODE"] = "1"
})

afterEach(async () => {
  if (PREV_CODEX_MODE === undefined) delete process.env["MIMOCODE_CODEX_MODE"]
  else process.env["MIMOCODE_CODEX_MODE"] = PREV_CODEX_MODE
  await Instance.disposeAll()
})

function run<A, E>(fx: Effect.Effect<A, E, SessionPrompt.Service | Session.Service>) {
  return Effect.runPromise(
    fx.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SessionPrompt.defaultLayer, Session.defaultLayer))),
  )
}

describe("tool.execute.before на вложенном вызове внутри exec (PI-134)", () => {
  test(
    "хук видит exec_command и cancel останавливает исполнение",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const seenPath = path.join(tmp.path, "seen-tools.json")
      // Маркер существует ТОЛЬКО если команда реально выполнилась. Его отсутствие и есть
      // доказательство блокировки: сам по себе результат "Cancelled" мог бы означать, что
      // ядро пометило вызов отменённым уже после запуска оболочки.
      const markerPath = path.join(tmp.path, "SHOULD-NOT-EXIST.txt")

      const stub = startScriptedLLMServer([
        {
          lines: toolCallResponse({
            id: "call_exec",
            name: "exec",
            args: JSON.stringify({
              code: `return await tools.exec_command({ cmd: ${JSON.stringify(`touch ${markerPath}`)} })`,
            }),
          }),
        },
        { lines: textStopResponse("готово") },
      ])

      try {
        const file = path.join(tmp.path, "plugin.ts")
        await Bun.write(
          file,
          [
            "import * as fs from 'fs/promises'",
            `const SEEN = ${JSON.stringify(seenPath)}`,
            "export default async () => ({",
            '  "tool.execute.before": async (input: { tool: string }, output: { cancel?: boolean; cancelReason?: string }) => {',
            "    let cur: string[] = []",
            "    try { cur = JSON.parse(await fs.readFile(SEEN, 'utf8')) } catch {}",
            "    cur.push(input.tool)",
            "    await fs.writeFile(SEEN, JSON.stringify(cur))",
            '    if (input.tool === "exec_command" || input.tool === "bash") {',
            "      output.cancel = true",
            '      output.cancelReason = "заблокировано тестом PI-134"',
            "    }",
            "  },",
            "})",
            "",
          ].join("\n"),
        )
        await Bun.write(
          path.join(tmp.path, "mimocode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            plugin: [pathToFileURL(file).href],
            enabled_providers: ["alibaba"],
            provider: {
              alibaba: { options: { apiKey: "test-key", baseURL: `${stub.origin}/v1` } },
            },
            agent: { build: { model: "alibaba/qwen-plus" } },
          }),
        )

        await Instance.provide({
          directory: tmp.path,
          fn: () =>
            run(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const session = yield* sessions.create({ title: "nested-before" })
                return yield* prompt
                  .prompt({
                    sessionID: session.id,
                    agent: "build",
                    parts: [{ type: "text", text: "запусти команду" }],
                  })
                  .pipe(Effect.exit)
              }),
            ),
        })

        const seen: string[] = JSON.parse(await Bun.file(seenPath).text())

        // (1) Хук вызван для вложенного инструмента — и именно под алиасом.
        expect(seen).toContain("exec_command")
        // Верхнеуровневый `exec` тоже проходит через хук: если его нет, сломан не вложенный
        // путь, а обёртка целиком, и диагноз был бы другим.
        expect(seen).toContain("exec")

        // (2) Отмена остановила исполнение, а не только пометила результат.
        expect(await Bun.file(markerPath).exists()).toBe(false)
      } finally {
        await stub.stop()
      }
    },
    { timeout: 60_000 },
  )

  test(
    "НЕГАТИВНЫЙ: без cancel вложенная команда выполняется — гейт не always-deny",
    async () => {
      // Без этой половины первый тест проходил бы и на ядре, где вложенный путь сломан
      // НАСОВСЕМ: команда не выполняется никогда, маркера нет всегда.
      await using tmp = await tmpdir({ git: true })
      const markerPath = path.join(tmp.path, "SHOULD-EXIST.txt")

      const stub = startScriptedLLMServer([
        {
          lines: toolCallResponse({
            id: "call_exec2",
            name: "exec",
            args: JSON.stringify({
              code: `return await tools.exec_command({ cmd: ${JSON.stringify(`touch ${markerPath}`)} })`,
            }),
          }),
        },
        { lines: textStopResponse("готово") },
      ])

      try {
        const file = path.join(tmp.path, "plugin.ts")
        await Bun.write(
          file,
          ["export default async () => ({", '  "tool.execute.before": async () => {},', "})", ""].join("\n"),
        )
        await Bun.write(
          path.join(tmp.path, "mimocode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            plugin: [pathToFileURL(file).href],
            enabled_providers: ["alibaba"],
            provider: {
              alibaba: { options: { apiKey: "test-key", baseURL: `${stub.origin}/v1` } },
            },
            agent: { build: { model: "alibaba/qwen-plus" } },
          }),
        )

        await Instance.provide({
          directory: tmp.path,
          fn: () =>
            run(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const session = yield* sessions.create({ title: "nested-allow" })
                return yield* prompt
                  .prompt({
                    sessionID: session.id,
                    agent: "build",
                    parts: [{ type: "text", text: "запусти команду" }],
                  })
                  .pipe(Effect.exit)
              }),
            ),
        })

        expect(await Bun.file(markerPath).exists()).toBe(true)
      } finally {
        await stub.stop()
      }
    },
    { timeout: 60_000 },
  )
})

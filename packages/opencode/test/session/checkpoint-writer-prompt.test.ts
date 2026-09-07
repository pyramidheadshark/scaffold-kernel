import { describe, expect, test } from "bun:test"
import { composeWriterPromptForTest } from "../../src/session/checkpoint"

// Инструкция писателя обещала `read`/`write`/`edit`/`glob`/`grep`. Для GPT-набора реестр их
// вырезает, и внутри `exec` у писателя есть `apply_patch`, `task` и пространство `files`.
//
// Замер на ядре 0.1.41 — уже ПОСЛЕ того, как харнесс-промпт стал доезжать, а джейл памяти
// открылся: отказы `exec` упали 38.7 % → 22.2 %, ошибки джейла исчезли полностью, и весь
// остаток — обращения к отсутствующим именам (2 из 9 вызовов). Последний класс отказов
// держался именно на этой строке.

const base = {
  checkpointFile: "/data/memory/sessions/ses_x/checkpoint.md",
  memoryFile: "/data/memory/projects/pid/MEMORY.md",
  taskMemDir: "/data/memory/sessions/ses_x/tasks",
  notesFile: "/data/memory/sessions/ses_x/notes.md",
  rangeDesc: "первый чекпоинт",
  progressDiff: "",
}

describe("composeWriterPrompt — набор инструментов назван честно", () => {
  const gpt = composeWriterPromptForTest({ ...base, gptToolset: true })
  const other = composeWriterPromptForTest({ ...base, gptToolset: false })

  test("GPT: названы ровно доступные инструменты", () => {
    expect(gpt).toContain("tools.apply_patch(...)")
    expect(gpt).toContain("tools.task(...)")
    expect(gpt).toContain("files.readText(...)")
  })

  test("GPT: прямо сказано, чего НЕТ — иначе модель тянется к оболочке", () => {
    expect(gpt).toContain("There is no shell")
    expect(gpt).not.toContain("The read, write, edit, glob, grep, and task tools are available")
  })

  test("GPT: инструкция записи не ссылается на несуществующий Write tool", () => {
    expect(gpt).not.toContain("When using the Write tool")
    expect(gpt).toContain("When writing with `tools.apply_patch(...)`")
  })

  test("НЕГАТИВНЫЙ: остальные семейства получают текст апстрима дословно", () => {
    expect(other).toContain("The read, write, edit, glob, grep, and task tools are available")
    expect(other).toContain("When writing with the Write tool")
    expect(other).not.toContain("There is no shell")
  })

  test("НЕГАТИВНЫЙ: абсолютные пути не изменились ни в одной ветке", () => {
    // Пути — единственное, ради чего промпт вообще собирается динамически; их потеря
    // вернула бы дефект «модель выдумывает legacy-путь /data/checkpoints/».
    for (const p of [gpt, other]) {
      expect(p).toContain(base.checkpointFile)
      expect(p).toContain(base.memoryFile)
      expect(p).toContain(base.taskMemDir)
    }
  })
})

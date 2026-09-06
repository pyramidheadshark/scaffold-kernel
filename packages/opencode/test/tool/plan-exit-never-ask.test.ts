import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * `plan_exit` обязан уважать never-ask так же, как `question`.
 *
 * Патч scaffold-v0.1.32 закрыл вечный висяк headless-прогона на туле `question`, и его
 * описание называло ДВА тула — оба зовут `question.ask(...)` напрямую, минуя
 * permission-систему. Лечение поставили в один. `Question.ask` ждёт голый
 * `Deferred.await` без таймаута, подписки на `question.asked` в `run` нет — то есть
 * `plan_exit` в headless как вешал прогон навсегда, так и вешал, а документация уже
 * называла дефект закрытым.
 *
 * Проверка исходником, а не прогоном, сознательно: поднять `plan_exit` в тесте значит
 * поднять Session/Provider/Instance целиком ради одной ветки, а ветка — литеральная.
 * Зато утверждение здесь фальсифицируемо: убери ветку — тест краснеет.
 */
// Пути от САМОГО ФАЙЛА, а не от cwd: cwd у прогона тестов зависит от того, откуда его
// запустили, и относительный путь дал бы «файл не найден» → пустую строку → зелёный
// тест на пустоте. Ровно тот класс, который этот тест и сторожит.
const SRC = path.resolve(import.meta.dir, "../../src")
const PLAN = path.join(SRC, "tool/plan.ts")
const QUESTION = path.join(SRC, "tool/question.ts")

/**
 * Исходник без комментариев.
 *
 * ⚠ Первая версия этого теста искала `question.ask(` в сыром тексте — и находила его
 * в КОММЕНТАРИИ, который я же и написал строкой выше («оба зовут `question.ask(...)`
 * напрямую»). Тест краснел на исправном коде, потому что мой собственный текст оказался
 * раньше настоящего вызова. Класс — «шаблон поиска стал выводом»; лечится тем, что
 * разбирается код, а не проза о коде.
 */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
}

describe("plan_exit и never-ask", () => {
  it("plan_exit проверяет neverAsk ДО того, как заблокироваться на question.ask", () => {
    const src = code(PLAN)
    const guard = src.indexOf("question.neverAsk()")
    const ask = src.indexOf("question.ask(")
    expect(guard, "в plan.ts нет ветки neverAsk — headless-прогон снова висит вечно").toBeGreaterThan(-1)
    expect(ask).toBeGreaterThan(-1)
    expect(guard, "ветка neverAsk обязана стоять ПЕРЕД question.ask, иначе она недостижима").toBeLessThan(ask)
  })

  it("оба тула, зовущих question.ask напрямую, имеют одну и ту же защиту", () => {
    // Список составлен не на глаз: это ровно те файлы в tool/, где встречается
    // `question.ask(`. Появится третий такой тул — тест обязан его увидеть.
    for (const file of [PLAN, QUESTION]) {
      const src = code(file)
      if (!src.includes("question.ask(")) continue
      expect(src.includes("question.neverAsk()"), `${file} зовёт question.ask без защиты never-ask`).toBe(true)
    }
  })

  it("ответ never-ask НЕ переключает агента: без человека решение о выходе из плана не принимается", () => {
    const src = code(PLAN)
    const branch = src.slice(src.indexOf("question.neverAsk()"), src.indexOf("const answers"))
    expect(branch).toContain("switched: false")
  })
})

import { describe, expect, test } from "bun:test"
import { SystemPrompt } from "../../src/session/system"

// An agent prompt says WHAT the agent does; the provider prompt says HOW the harness works.
// For the GPT toolset the latter is the `exec` tool-script contract — the `tools.<id>()`
// namespace, which tools exist inside a script, and the Promise.all batching requirement.
// Before this test, `SystemPrompt.agent` returned `[agent.prompt]` whenever an agent had a
// prompt, so every configured role silently lost that contract and the model had to guess
// tool names inside `exec`.
//
// The assertions below are LITERAL on purpose. Computing the expectation from the same
// expression as the code under test would pin the expression, not the behaviour.

const GPT_PROMPT_MARKER = "You are Codex, an agent based on GPT-5."
const ROLE_PROMPT = "Ты — Инженер-исполнитель. Пиши тест до кода."

function model(id: string, apiID = id) {
  return { id, api: { id: apiID } } as any
}

function withPrompt(prompt?: string) {
  return { name: "build", prompt } as any
}

describe("SystemPrompt.agent — харнесс-руководство не вытесняется промптом роли", () => {
  test("GPT-модель с промптом роли получает ОБА: харнесс и роль", () => {
    const out = SystemPrompt.agent(withPrompt(ROLE_PROMPT), model("gpt-5.6-terra"))
    expect(out.length).toBe(2)
    expect(out[0]).toContain(GPT_PROMPT_MARKER)
    expect(out[1]).toBe(ROLE_PROMPT)
  })

  test("порядок: харнесс первым — он стабилен и держит префикс-кэш", () => {
    const out = SystemPrompt.agent(withPrompt(ROLE_PROMPT), model("gpt-5.6-sol"))
    expect(out[0]).toContain(GPT_PROMPT_MARKER)
    expect(out.at(-1)).toBe(ROLE_PROMPT)
  })

  test("харнесс определяется и по api.id, а не только по id", () => {
    const out = SystemPrompt.agent(withPrompt(ROLE_PROMPT), model("codex-flagship", "openai/gpt-5.6-sol"))
    expect(out.length).toBe(2)
    expect(out[0]).toContain(GPT_PROMPT_MARKER)
  })

  test("harness: \"codex\" включает харнесс даже для не-GPT слага", () => {
    const out = SystemPrompt.agent(withPrompt(ROLE_PROMPT), model("some-model"), "codex")
    expect(out.length).toBe(2)
    expect(out[0]).toContain(GPT_PROMPT_MARKER)
  })

  test("НЕГАТИВНЫЙ: другие семейства сохраняют поведение апстрима — только промпт роли", () => {
    // Иначе правка меняла бы контракт Anthropic/Gemini, где промпт агента — законная замена.
    const out = SystemPrompt.agent(withPrompt(ROLE_PROMPT), model("claude-sonnet-5"))
    expect(out).toEqual([ROLE_PROMPT])
  })

  test("НЕГАТИВНЫЙ: harness \"default\" у не-GPT слага харнесс НЕ добавляет", () => {
    const out = SystemPrompt.agent(withPrompt(ROLE_PROMPT), model("some-model"), "default")
    expect(out).toEqual([ROLE_PROMPT])
  })

  test("агент БЕЗ промпта по-прежнему получает ровно промпт провайдера", () => {
    const out = SystemPrompt.agent(withPrompt(undefined), model("gpt-5.6-terra"))
    expect(out.length).toBe(1)
    expect(out[0]).toContain(GPT_PROMPT_MARKER)
  })
})

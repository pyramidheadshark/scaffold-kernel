import { describe, expect, test } from "bun:test"
import { BOUNDED_COMPUTATION_AGENTS, isBoundedComputationAgent } from "@/agent/bounded-computation"

/**
 * The predicate used to be `native === true && hidden === true`. That inference
 * broke the day a user hid a native agent for an unrelated reason: `hidden` also
 * means "keep out of the spawn enum, the /agent list and the tab cycle", and
 * setting it disarmed fireCheckpoints and overflowCheck for that agent — it then
 * dies against the window instead of compacting, silently.
 */
describe("isBoundedComputationAgent", () => {
  test("the three named kernel agents qualify", () => {
    for (const name of ["title", "summary", "checkpoint-writer"]) {
      expect(isBoundedComputationAgent({ name, native: true })).toBe(true)
    }
    expect(BOUNDED_COMPUTATION_AGENTS.size).toBe(3)
  })

  // The regression this file exists for.
  test("a hidden native agent that is NOT on the list keeps context management", () => {
    expect(isBoundedComputationAgent({ name: "general", native: true, hidden: true } as never)).toBe(false)
  })

  test("a user agent sharing a listed name does not qualify — it has a real conversation", () => {
    expect(isBoundedComputationAgent({ name: "summary", native: false })).toBe(false)
    expect(isBoundedComputationAgent({ name: "summary" })).toBe(false)
  })

  test("undefined agent does not qualify", () => {
    expect(isBoundedComputationAgent(undefined)).toBe(false)
  })
})

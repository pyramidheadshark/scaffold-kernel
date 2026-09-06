import { describe, expect, test } from "bun:test"
import { BOUNDED_COMPUTATION_AGENTS, isBoundedComputationAgent } from "@/agent/bounded-computation"
import { SYSTEM_SPAWNED_AGENT_TYPES } from "@/agent/config"

/**
 * The predicate used to be `native === true && hidden === true`. That inference
 * broke the day a user hid a native agent for an unrelated reason: `hidden` also
 * means "keep out of the spawn enum, the /agent list and the tab cycle", and
 * setting it disarmed fireCheckpoints and overflowCheck for that agent — it then
 * dies against the window instead of compacting, silently.
 */
describe("isBoundedComputationAgent", () => {
  test("every runtime-spawned agent qualifies — the invariant they must not self-trigger", () => {
    // prune.ts and actor/registry.ts both state it: the writers must not spawn
    // themselves. Dropping any of these three from the set breaks that, and the
    // first version of this file dropped two.
    for (const name of SYSTEM_SPAWNED_AGENT_TYPES) {
      expect(isBoundedComputationAgent({ name, native: true })).toBe(true)
    }
  })

  test("the single-turn helpers qualify", () => {
    for (const name of ["title", "summary"]) {
      expect(isBoundedComputationAgent({ name, native: true })).toBe(true)
    }
  })

  // ⚠ This assertion is a LITERAL on purpose, and the reason is a defect this very test
  // shipped with. It first read `toEqual([...SYSTEM_SPAWNED_AGENT_TYPES, "title", "summary"])`
  // — the same expression the implementation is built from. Both sides moved together, so
  // deleting `dream` from the registry left the suite green while the set silently lost it:
  // exactly the regression the commit above this one was written to prevent, invisible again.
  //
  // A test whose expectation is computed the way the code is computed pins the expression,
  // not the population. Spelling the names out is the only form that can go red.
  test("the set is exactly these five agents", () => {
    expect([...BOUNDED_COMPUTATION_AGENTS].sort()).toEqual([
      "checkpoint-writer",
      "distill",
      "dream",
      "summary",
      "title",
    ])
  })

  // The literal above must not drift from the registry it is derived from either: if
  // someone adds a runtime-spawned agent, this fails and forces a decision instead of
  // letting the new agent silently miss the exemption.
  test("every runtime-spawned agent is present in that literal", () => {
    for (const name of SYSTEM_SPAWNED_AGENT_TYPES) {
      expect([...BOUNDED_COMPUTATION_AGENTS]).toContain(name)
    }
  })

  test("compaction is absent on purpose — it never reaches this predicate", () => {
    expect(BOUNDED_COMPUTATION_AGENTS.has("compaction")).toBe(false)
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

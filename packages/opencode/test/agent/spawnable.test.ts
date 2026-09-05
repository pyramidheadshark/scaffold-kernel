import { describe, expect, it } from "bun:test"
import { isSpawnableMode } from "../../src/agent/spawnable"

// One predicate, two call sites (tool/actor.ts builds the subagent_type enum,
// actor/spawn.ts decides gateEligible). Before it existed they were separate
// copies of `mode === "subagent"`, so whatever one started admitting the other
// silently treated as not-a-subagent.
describe("isSpawnableMode", () => {
  it('admits "subagent" — the explicit delegation target', () => {
    expect(isSpawnableMode("subagent")).toBe(true)
  })

  it('admits "all": agent.ts stamps it on every config-defined agent that does not say otherwise', () => {
    // This is the PI-137 case. Excluding "all" drops exactly the roles a user
    // just declared: they vanish from the enum and `actor spawn <role>` fails
    // zod validation or is misrouted to whatever is left eligible.
    expect(isSpawnableMode("all")).toBe(true)
  })

  it('rejects "primary" — a session root is a tab destination, not a delegation target', () => {
    expect(isSpawnableMode("primary")).toBe(false)
  })

  it("rejects an absent mode rather than defaulting to spawnable", () => {
    expect(isSpawnableMode(undefined)).toBe(false)
  })

  it("rejects an unknown mode string", () => {
    expect(isSpawnableMode("peer")).toBe(false)
  })
})

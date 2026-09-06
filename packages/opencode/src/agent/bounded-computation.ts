import { SYSTEM_SPAWNED_AGENT_TYPES } from "./config"

/**
 * Which agents are exempt from context management.
 *
 * A "bounded computation" agent runs work that must not manage its own context:
 * either a single short self-contained turn, or the very machinery that writes
 * checkpoints and consolidates memory. For the second group the exemption is an
 * INVARIANT, not an optimisation — `session/prune.ts` and `actor/registry.ts`
 * both state it: "system-spawned agents (checkpoint-writer/dream/distill) are
 * the writers themselves and must not self-trigger". A `dream` session that
 * spawns a checkpoint-writer, or gets its context rebuilt mid-consolidation, is
 * exactly the recursion those comments forbid.
 *
 * ⚠ Scaffold, 2026-09-06. Two mistakes, one after the other, both worth keeping
 * written down.
 *
 * FIRST the predicate was inferred: `native === true && hidden === true`.
 * Inference is the defect. `hidden` is a legal config key with an unrelated
 * meaning — "keep this agent out of the spawn enum, the /agent list and the tab
 * cycle" — and a user who hides a native agent for THAT reason silently loses
 * checkpoints and auto-compaction for it. We hit this ourselves within a day of
 * writing the config: hiding `general` so it stops being a delegation escape
 * hatch also disarmed `fireCheckpoints` and `overflowCheck` for every
 * `run --agent general` session.
 *
 * THEN the replacement list was written from the design doc's three names, and
 * it silently DROPPED `dream` and `distill`, which the old inference had covered
 * (they are native and hidden). Narrowing a set is as much a behaviour change as
 * widening it, and this one broke the invariant quoted above. The fix for an
 * over-broad inference is not a hand-written list either — it is the list that
 * already exists for exactly this population.
 *
 * Hence: `SYSTEM_SPAWNED_AGENT_TYPES` (the runtime's own registry of agents it
 * spawns itself) plus the two single-turn helpers. Adding a name here is a
 * statement about the shape of the work, never a side effect of a visibility
 * choice.
 *
 * `compaction` is deliberately absent: it never reaches this predicate, because
 * `lastUser.agent === "compaction"` does not occur — the only `agent:
 * "compaction"` is an assistant message written by `session/compaction.ts`.
 */
export const BOUNDED_COMPUTATION_AGENTS: ReadonlySet<string> = new Set([
  ...SYSTEM_SPAWNED_AGENT_TYPES,
  // Single-turn helpers: they answer once and never grow a context worth managing.
  "title",
  "summary",
])

/**
 * Only a kernel-native agent qualifies: a user agent that happens to share one
 * of these names is still a user agent, with a prompt and a real conversation.
 */
export function isBoundedComputationAgent(agent: { name?: string; native?: boolean } | undefined): boolean {
  if (!agent?.native) return false
  return typeof agent.name === "string" && BOUNDED_COMPUTATION_AGENTS.has(agent.name)
}

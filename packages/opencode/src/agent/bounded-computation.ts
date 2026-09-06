/**
 * Which agents are exempt from context management.
 *
 * A "bounded computation" agent runs a single short, self-contained turn: it
 * needs no checkpoint writer and no overflow rebuild, because it cannot grow a
 * context worth managing. Three kernel agents are like that — `title`,
 * `summary` and `checkpoint-writer` — and the design doc names exactly those
 * (docs/superpowers/specs/2026-04-28-bounded-computation-agents-design.md).
 *
 * ⚠ Scaffold, 2026-09-06. The predicate used to be inferred: `native === true &&
 * hidden === true`. Inference is the defect. `hidden` is a legal config key with
 * an unrelated meaning — "keep this agent out of the spawn enum, the /agent list
 * and the tab cycle" — and a user who hides a native agent for THAT reason
 * silently loses checkpoints and auto-compaction for it. It then dies against
 * the context window instead of compacting, and nothing anywhere says why.
 *
 * We hit this ourselves within a day of writing the config: hiding `general` so
 * it stops being a delegation escape hatch also disarmed `fireCheckpoints` and
 * `overflowCheck` for every `run --agent general` session. Two unrelated
 * properties shared one flag, so setting either one set both.
 *
 * The list is explicit for that reason. Adding an agent here is a statement
 * about the shape of its work, not a side effect of a visibility choice.
 */
export const BOUNDED_COMPUTATION_AGENTS: ReadonlySet<string> = new Set([
  "title",
  "summary",
  "checkpoint-writer",
])

/**
 * Only a kernel-native agent qualifies: a user agent that happens to share one
 * of these names is still a user agent, with a prompt and a real conversation.
 */
export function isBoundedComputationAgent(agent: { name?: string; native?: boolean } | undefined): boolean {
  if (!agent?.native) return false
  return typeof agent.name === "string" && BOUNDED_COMPUTATION_AGENTS.has(agent.name)
}

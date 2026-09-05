/**
 * Who may be a delegation target — one predicate, two call sites.
 *
 * Scaffold, 2026-09-06. There are two independent places that decide whether an
 * agent can be spawned as an actor:
 *
 *   1. `tool/actor.ts` builds the `subagent_type` enum the model is allowed to
 *      pick from;
 *   2. `actor/spawn.ts` decides whether the spawned agent takes part in the
 *      subagent lifecycle (`gateEligible` → RETURN_FORMAT_INSTRUCTION).
 *
 * They were separate copies of `mode === "subagent"`, so anything the first one
 * started admitting the second one would silently treat as not-a-subagent. This
 * module is the single source, so the two cannot drift.
 *
 * `"all"` counts. `agent/agent.ts` stamps `mode: "all"` on every config-defined
 * agent whose config does not say otherwise, so excluding it drops exactly the
 * roles a user just declared. `"primary"` does not count: a primary agent is a
 * session root (a `tab` destination), not a delegation target.
 */
export function isSpawnableMode(mode: string | undefined): boolean {
  return mode === "subagent" || mode === "all"
}

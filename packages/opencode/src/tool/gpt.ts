import { Flag } from "@/flag/flag"

export type HarnessMode = "auto" | "codex" | "default"

function codexHarnessOverride(harness?: HarnessMode): boolean | undefined {
  if (harness === "codex") return true
  if (harness === "default") return false
  return undefined
}

export function isGPTModel(...values: Array<string | undefined>) {
  const ids = values.flatMap((value) => (value ? [value.toLowerCase()] : []))
  if (ids.some((id) => id.includes("gpt-oss"))) return false
  return ids.some((id) => id.includes("gpt"))
}

// GPT slugs that do NOT need the compact exec/wait toolset or the Codex harness
// prompt. Kept as an EXACT allowlist on purpose, mirroring the same discipline as
// pi-scaffold's own KERNEL_KNOWN_OPENAI_SLUGS (src/scaffold/providers/registry.ts) —
// that list exists precisely because not every "gpt-5.6-*"-shaped string is a real,
// working slug: the bare "gpt-5.6", "gpt-5.6-codex", and "gpt-5.6-mini" are all
// rejected by the Codex backend. A substring/prefix match here would silently
// enroll an unvalidated future slug (e.g. a hypothetical "gpt-5.60" or "gpt-5.6.1")
// the moment its name happens to contain "gpt-5.6" — exactly the pattern-widening
// the note below warns against. Match on the exact final path segment instead (so
// both "gpt-5.6-sol" and "openai/gpt-5.6-sol" match, but "gpt-5.60-anything" does not).
//
// gpt-5.6-sol/-terra/-luna were validated 2026-09-08 (pi-scaffold, A/B against the
// compact toolset):
//   - payload of 323 native tools / 358KB sent to the Codex Responses endpoint with
//     zero server_error / response.failed — the strict-schema auto-patch bug (fixed
//     2026-08-04, see EXPLICIT_NON_STRICT_TOOL_SDKS in provider/transform.ts, which
//     pins tool.strict=false independent of tool count) does not resurface.
//   - the model genuinely batches independent native tool_calls in one turn (3
//     parallel Glob + 3 parallel Read observed on the wire), not just one call at a
//     time re-wrapped without exec — this was the open question this list exists to
//     answer per-generation, not assume.
// Earlier generations (gpt-5.4/5.5/5.4-mini and older) are NOT in this list: they
// hit a real, separate, version-specific bug (>90-95KB combined tools+instructions+
// input payload silently returns response.incomplete with zero usage — see
// pi-scaffold CLAUDE.md, PI-129) and were never subjected to this same live batching
// test. Add a slug here only after the same live check has been repeated for it —
// never widen this to a pattern.
const NATIVE_TOOLSET_GPT_SLUGS = new Set(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])

function matchesNativeToolsetSlug(id: string) {
  return NATIVE_TOOLSET_GPT_SLUGS.has(id) || [...NATIVE_TOOLSET_GPT_SLUGS].some((slug) => id.endsWith(`/${slug}`))
}

// True only for GPT models that still need the compact exec/wait toolset and the
// Codex harness prompt (i.e. isGPTModel() minus the exact, live-validated slugs in
// NATIVE_TOOLSET_GPT_SLUGS above). This is the predicate every toolset/prompt
// decision in this file should gate on instead of the broader isGPTModel() — keeping
// isGPTModel() itself a pure "is this named like a GPT model" check, not a proxy for
// "needs the Codex compaction workaround".
export function needsCompactGPTToolset(...values: Array<string | undefined>) {
  if (!isGPTModel(...values)) return false
  const ids = values.flatMap((value) => (value ? [value.toLowerCase()] : []))
  return !ids.some((id) => matchesNativeToolsetSlug(id))
}

export function isMcpToolSearchEnabled(
  enabled: boolean,
  harness: HarnessMode | undefined,
  ...modelIDs: Array<string | undefined>
) {
  if (isGPTModel(...modelIDs)) return true
  return enabled || (codexHarnessOverride(harness) ?? Flag.MIMOCODE_CODEX_MODE)
}

export function isMimoModel(...values: Array<string | undefined>) {
  return values.some((value) => value && /(?:^|[/_-])mimo(?:$|[/_.-])/i.test(value))
}

export function usesMimoResponsesApi(...values: Array<string | undefined>) {
  const ids = values.flatMap((value) => (value ? [value.toLowerCase()] : []))
  return isMimoModel(...ids) && ids.some((id) => /(?:^|[/_.-])ptc(?:$|[/_.-])/.test(id))
}

export function usesGPTToolset(
  modelID: string,
  harness?: HarnessMode,
  ...modelIDs: Array<string | undefined>
) {
  const ids = [modelID, ...modelIDs]
  if (needsCompactGPTToolset(...ids)) return true
  return codexHarnessOverride(harness) ?? Flag.MIMOCODE_CODEX_MODE
}

import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

// Regression guard for the most critical branding finding of Track 5.3b:
// the agent must never present itself to the user under a different
// company's brand. Checked as a literal source-text assertion (not a live
// prompt-build test) so it fails loudly and immediately if either file
// regresses, without needing full session bootstrap.
describe("no foreign self-identification in prompts", () => {
  // Deliberately literal, user-facing phrases only — not a bare /MiMoCode/i,
  // which would also match the codebase's own internal MIMOCODE_* env var
  // naming convention (unrelated to what the agent tells the user).
  const FORBIDDEN = [/MiMo Code Agent/i, /built by Xiaomi/i, /Xiaomi's official CLI/i, /MiMoCode, Xiaomi/i]

  test("session/system.ts base system prompt", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/session/system.ts"), "utf8")
    for (const pattern of FORBIDDEN) {
      expect(src).not.toMatch(pattern)
    }
  })

  test("agent/prompt/general.txt subagent prompt", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/agent/prompt/general.txt"), "utf8")
    for (const pattern of FORBIDDEN) {
      expect(src).not.toMatch(pattern)
    }
  })
})

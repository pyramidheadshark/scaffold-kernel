import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { isGPTModel, isMcpToolSearchEnabled, needsCompactGPTToolset, usesGPTToolset } from "../../src/tool/gpt"

const codexMode = process.env.MIMOCODE_CODEX_MODE

beforeEach(() => {
  delete process.env.MIMOCODE_CODEX_MODE
})

afterEach(() => {
  if (codexMode === undefined) delete process.env.MIMOCODE_CODEX_MODE
  else process.env.MIMOCODE_CODEX_MODE = codexMode
})

describe("isGPTModel", () => {
  test("recognizes GPT versions and API aliases", () => {
    expect(isGPTModel("gpt-4o")).toBe(true)
    expect(isGPTModel("chatgpt-4o-latest")).toBe(true)
    expect(isGPTModel("gpt-5.3-codex")).toBe(true)
    expect(isGPTModel("company-alias", "gpt-5.4", "gpt-5")).toBe(true)
  })

  test("excludes non-GPT and GPT-OSS models", () => {
    expect(isGPTModel("claude-opus-4-6")).toBe(false)
    expect(isGPTModel("gpt-oss-120b")).toBe(false)
    expect(isGPTModel("company-gpt-production", "gpt-oss-120b", "gpt-oss")).toBe(false)
  })
})

describe("needsCompactGPTToolset", () => {
  test("gpt-5.6 generations are excluded from the compact toolset — live-validated 2026-09-08", () => {
    expect(needsCompactGPTToolset("gpt-5.6-sol")).toBe(false)
    expect(needsCompactGPTToolset("gpt-5.6-terra")).toBe(false)
    expect(needsCompactGPTToolset("gpt-5.6-luna")).toBe(false)
  })

  test("earlier GPT generations still need the compact toolset — not validated the same way", () => {
    expect(needsCompactGPTToolset("gpt-5.4")).toBe(true)
    expect(needsCompactGPTToolset("gpt-5.5")).toBe(true)
    expect(needsCompactGPTToolset("gpt-5.4-mini")).toBe(true)
    expect(needsCompactGPTToolset("gpt-5.3-codex")).toBe(true)
    expect(needsCompactGPTToolset("gpt-4o")).toBe(true)
  })

  test("non-GPT and GPT-OSS models never need it", () => {
    expect(needsCompactGPTToolset("claude-opus-4-6")).toBe(false)
    expect(needsCompactGPTToolset("gpt-oss-120b")).toBe(false)
  })

  test("matches across multiple candidate ids the same way isGPTModel does", () => {
    expect(needsCompactGPTToolset("company-alias", "gpt-5.6-sol")).toBe(false)
    expect(needsCompactGPTToolset("company-alias", "gpt-5.4")).toBe(true)
  })

  test("matches the exact slug through a provider/ prefix", () => {
    expect(needsCompactGPTToolset("openai/gpt-5.6-sol")).toBe(false)
    expect(needsCompactGPTToolset("openai/gpt-5.6-terra")).toBe(false)
  })

  test("EXACT allowlist, not a substring/prefix match — unvalidated lookalike slugs stay compacted", () => {
    // The Codex backend itself rejects these (registry.ts KERNEL_KNOWN_OPENAI_SLUGS on the
    // pi-scaffold side already had to special-case exactly this): a substring match here would
    // have silently exempted them anyway, which is the bug this test pins against.
    expect(needsCompactGPTToolset("gpt-5.6")).toBe(true)
    expect(needsCompactGPTToolset("gpt-5.6-codex")).toBe(true)
    expect(needsCompactGPTToolset("gpt-5.6-mini")).toBe(true)
    // A hypothetical future slug that merely CONTAINS "gpt-5.6" must not be swept in by pattern.
    expect(needsCompactGPTToolset("gpt-5.60")).toBe(true)
    expect(needsCompactGPTToolset("gpt-5.6.1")).toBe(true)
    expect(needsCompactGPTToolset("gpt-5.6-sol-preview")).toBe(true)
  })
})

describe("isMcpToolSearchEnabled", () => {
  test("defaults to GPT models and allows explicit non-GPT opt-in", () => {
    expect(isMcpToolSearchEnabled(false, undefined, "claude-opus-4-6")).toBe(false)
    expect(isMcpToolSearchEnabled(false, undefined, "mimo-v2.5")).toBe(false)
    expect(isMcpToolSearchEnabled(false, undefined, "mimo-v2.5-pro")).toBe(false)
    expect(isMcpToolSearchEnabled(false, undefined, "mimo-v2.5-pro-ultraspeed")).toBe(false)
    expect(isMcpToolSearchEnabled(false, undefined, "mimo-v2-pro")).toBe(false)
    expect(isMcpToolSearchEnabled(false, undefined, "mimo-v2.6")).toBe(false)
    expect(isMcpToolSearchEnabled(false, undefined, "mimo-ptc-test")).toBe(false)
    expect(isMcpToolSearchEnabled(false, undefined, "mimo-v2.6-ptc")).toBe(false)
    expect(isMcpToolSearchEnabled(false, undefined, "gpt-5.2")).toBe(true)
    expect(isMcpToolSearchEnabled(false, undefined, "gpt-oss-120b")).toBe(false)
    expect(isMcpToolSearchEnabled(true, undefined, "claude-opus-4-6")).toBe(true)
  })

  test("enables every non-GPT model when process Codex mode is enabled", () => {
    process.env.MIMOCODE_CODEX_MODE = "true"
    expect(isMcpToolSearchEnabled(false, undefined, "claude-opus-4-6")).toBe(true)
    expect(isMcpToolSearchEnabled(false, undefined, "mimo-v2.6")).toBe(true)
    expect(isMcpToolSearchEnabled(false, undefined, "mimo-v2.6-ptc")).toBe(true)
  })

  test("allows the resolved session mode to override the process mode", () => {
    expect(isMcpToolSearchEnabled(false, "codex", "claude-opus-4-6")).toBe(true)
    expect(isMcpToolSearchEnabled(false, "codex", "mimo-v2.6")).toBe(true)
    expect(isMcpToolSearchEnabled(false, "codex", "mimo-v2.6-ptc")).toBe(true)
    expect(isMcpToolSearchEnabled(false, "auto", "gpt-5.2")).toBe(true)
    expect(isMcpToolSearchEnabled(false, "auto", "claude-opus-4-6")).toBe(false)
    process.env.MIMOCODE_CODEX_MODE = "true"
    expect(isMcpToolSearchEnabled(false, "auto", "claude-opus-4-6")).toBe(true)
    expect(isMcpToolSearchEnabled(false, "auto", "mimo-v2.6")).toBe(true)
    expect(isMcpToolSearchEnabled(false, "auto", "mimo-v2.6-ptc")).toBe(true)
    expect(isMcpToolSearchEnabled(false, "default", "claude-opus-4-6")).toBe(false)
    expect(isMcpToolSearchEnabled(false, "default", "mimo-v2.6")).toBe(false)
    expect(isMcpToolSearchEnabled(false, "default", "gpt-5.2")).toBe(true)
    expect(isMcpToolSearchEnabled(true, "default", "mimo-v2.6")).toBe(true)
  })
})

describe("usesGPTToolset", () => {
  test("uses the normal toolset for MiMo models regardless of API transport", () => {
    expect(usesGPTToolset("mimo-v2.5")).toBe(false)
    expect(usesGPTToolset("mimo-v2.5-pro")).toBe(false)
    expect(usesGPTToolset("mimo-v2.5-pro-ultraspeed")).toBe(false)
    expect(usesGPTToolset("mimo-v2-pro")).toBe(false)
    expect(usesGPTToolset("mimo-v2.6")).toBe(false)
    expect(usesGPTToolset("mimo-ptc-test")).toBe(false)
    expect(usesGPTToolset("mimo-v2.6-ptc")).toBe(false)
  })

  test("uses the GPT toolset for every non-GPT model in process Codex mode", () => {
    expect(usesGPTToolset("claude-opus-4-6")).toBe(false)
    process.env.MIMOCODE_CODEX_MODE = "true"
    expect(usesGPTToolset("claude-opus-4-6")).toBe(true)
    expect(usesGPTToolset("mimo-v2.6")).toBe(true)
    expect(usesGPTToolset("mimo-v2.6-ptc")).toBe(true)
  })

  test("allows the resolved session mode to override the process mode", () => {
    expect(usesGPTToolset("claude-opus-4-6", "codex")).toBe(true)
    expect(usesGPTToolset("mimo-v2.6", "codex")).toBe(true)
    expect(usesGPTToolset("mimo-v2.6-ptc", "codex")).toBe(true)
    expect(usesGPTToolset("deployment-primary", "codex", "mimo-v2.6", "mimo")).toBe(true)
    expect(usesGPTToolset("deployment-primary", "codex", "mimo-v2.6-ptc", "mimo")).toBe(true)
    expect(usesGPTToolset("gpt-5.2", "auto")).toBe(true)
    expect(usesGPTToolset("mimo-v2.6-ptc", "auto")).toBe(false)
    expect(usesGPTToolset("claude-opus-4-6", "auto")).toBe(false)
    process.env.MIMOCODE_CODEX_MODE = "true"
    expect(usesGPTToolset("claude-opus-4-6", "auto")).toBe(true)
    expect(usesGPTToolset("mimo-v2.6", "auto")).toBe(true)
    expect(usesGPTToolset("mimo-v2.6-ptc", "auto")).toBe(true)
    expect(usesGPTToolset("claude-opus-4-6", "default")).toBe(false)
    expect(usesGPTToolset("mimo-v2.6", "default")).toBe(false)
    expect(usesGPTToolset("gpt-5.2", "default")).toBe(true)
  })

  test("gpt-5.6 gets the native toolset by default — the compaction short-circuit no longer fires", () => {
    expect(usesGPTToolset("gpt-5.6-sol")).toBe(false)
    expect(usesGPTToolset("gpt-5.6-terra")).toBe(false)
    expect(usesGPTToolset("gpt-5.6-luna")).toBe(false)
    // explicit harness:"codex" is still a working escape hatch to force compaction back on
    expect(usesGPTToolset("gpt-5.6-sol", "codex")).toBe(true)
    // explicit harness:"default" is a no-op here (already the effective default), and
    // process-wide MIMOCODE_CODEX_MODE can still force compaction on for gpt-5.6 too
    expect(usesGPTToolset("gpt-5.6-sol", "default")).toBe(false)
  })

  test("older GPT generations are unaffected by the gpt-5.6 carve-out", () => {
    expect(usesGPTToolset("gpt-5.4")).toBe(true)
    expect(usesGPTToolset("gpt-5.5")).toBe(true)
    expect(usesGPTToolset("gpt-5.4-mini", "default")).toBe(true)
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "../../src/flag/flag"

const originalXiaomi = process.env.MIMOCODE_ENABLE_XIAOMI_PROVIDERS
const originalOpencode = process.env.MIMOCODE_ENABLE_OPENCODE_SUBSCRIPTIONS

function set(key: string, value?: string) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

afterEach(() => {
  set("MIMOCODE_ENABLE_XIAOMI_PROVIDERS", originalXiaomi)
  set("MIMOCODE_ENABLE_OPENCODE_SUBSCRIPTIONS", originalOpencode)
})

describe("MIMOCODE_ENABLE_XIAOMI_PROVIDERS", () => {
  test("defaults to false (Xiaomi/MiMo catalog entries stay hidden)", () => {
    set("MIMOCODE_ENABLE_XIAOMI_PROVIDERS", undefined)
    expect(Flag.MIMOCODE_ENABLE_XIAOMI_PROVIDERS).toBe(false)
  })

  test("reads env on access, not at module-evaluation time", () => {
    set("MIMOCODE_ENABLE_XIAOMI_PROVIDERS", "true")
    expect(Flag.MIMOCODE_ENABLE_XIAOMI_PROVIDERS).toBe(true)
    set("MIMOCODE_ENABLE_XIAOMI_PROVIDERS", "false")
    expect(Flag.MIMOCODE_ENABLE_XIAOMI_PROVIDERS).toBe(false)
  })
})

describe("MIMOCODE_ENABLE_OPENCODE_SUBSCRIPTIONS", () => {
  test("defaults to false (OpenCode Go/Zen upsell and catalog entries stay hidden)", () => {
    set("MIMOCODE_ENABLE_OPENCODE_SUBSCRIPTIONS", undefined)
    expect(Flag.MIMOCODE_ENABLE_OPENCODE_SUBSCRIPTIONS).toBe(false)
  })

  test("reads env on access, not at module-evaluation time", () => {
    set("MIMOCODE_ENABLE_OPENCODE_SUBSCRIPTIONS", "1")
    expect(Flag.MIMOCODE_ENABLE_OPENCODE_SUBSCRIPTIONS).toBe(true)
    set("MIMOCODE_ENABLE_OPENCODE_SUBSCRIPTIONS", "0")
    expect(Flag.MIMOCODE_ENABLE_OPENCODE_SUBSCRIPTIONS).toBe(false)
  })
})

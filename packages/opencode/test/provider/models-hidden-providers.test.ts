import { afterEach, expect, test } from "bun:test"
import { filterHiddenProviders, type Provider } from "../../src/provider/models"

const XIAOMI_ENV_KEY = "MIMOCODE_ENABLE_XIAOMI_PROVIDERS"
const OPENCODE_ENV_KEY = "MIMOCODE_ENABLE_OPENCODE_SUBSCRIPTIONS"
const originalXiaomiEnv = process.env[XIAOMI_ENV_KEY]
const originalOpencodeEnv = process.env[OPENCODE_ENV_KEY]

afterEach(() => {
  if (originalXiaomiEnv === undefined) delete process.env[XIAOMI_ENV_KEY]
  else process.env[XIAOMI_ENV_KEY] = originalXiaomiEnv
  if (originalOpencodeEnv === undefined) delete process.env[OPENCODE_ENV_KEY]
  else process.env[OPENCODE_ENV_KEY] = originalOpencodeEnv
})

function provider(id: string): Provider {
  return { id, name: id, env: [], models: {} }
}

const CATALOG: Record<string, Provider> = {
  openai: provider("openai"),
  anthropic: provider("anthropic"),
  xiaomi: provider("xiaomi"),
  "xiaomi-token-plan-cn": provider("xiaomi-token-plan-cn"),
  "xiaomi-token-plan-ams": provider("xiaomi-token-plan-ams"),
  "xiaomi-token-plan-sgp": provider("xiaomi-token-plan-sgp"),
  opencode: provider("opencode"),
  "opencode-go": provider("opencode-go"),
}

test("hides Xiaomi/MiMo and OpenCode Zen/Go entries from the catalog by default", () => {
  delete process.env[XIAOMI_ENV_KEY]
  delete process.env[OPENCODE_ENV_KEY]
  const result = filterHiddenProviders(CATALOG)
  expect(Object.keys(result).sort()).toEqual(["anthropic", "openai"])
})

test("is case-insensitive and matches only the xiaomi-prefixed/opencode ids, not unrelated ones", () => {
  delete process.env[XIAOMI_ENV_KEY]
  delete process.env[OPENCODE_ENV_KEY]
  const result = filterHiddenProviders({
    ...CATALOG,
    "Xiaomi-Weird-Case": provider("Xiaomi-Weird-Case"),
    "not-xiaomi-affiliated": provider("not-xiaomi-affiliated"),
    "opencode-zen-clone": provider("opencode-zen-clone"),
  })
  expect(Object.keys(result).sort()).toEqual(
    ["anthropic", "not-xiaomi-affiliated", "opencode-zen-clone", "openai"].sort(),
  )
})

test("MIMOCODE_ENABLE_XIAOMI_PROVIDERS=true restores only the Xiaomi group", () => {
  process.env[XIAOMI_ENV_KEY] = "true"
  delete process.env[OPENCODE_ENV_KEY]
  const result = filterHiddenProviders(CATALOG)
  expect(Object.keys(result).sort()).toEqual(
    ["anthropic", "openai", "xiaomi", "xiaomi-token-plan-ams", "xiaomi-token-plan-cn", "xiaomi-token-plan-sgp"].sort(),
  )
})

test("MIMOCODE_ENABLE_OPENCODE_SUBSCRIPTIONS=true restores only the OpenCode Zen/Go group", () => {
  delete process.env[XIAOMI_ENV_KEY]
  process.env[OPENCODE_ENV_KEY] = "true"
  const result = filterHiddenProviders(CATALOG)
  expect(Object.keys(result).sort()).toEqual(["anthropic", "opencode", "opencode-go", "openai"].sort())
})

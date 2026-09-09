import { describe, expect, test } from "bun:test"
import { NOT_LOGGED_IN_MESSAGE } from "../../src/cli/cmd/providers"

describe("providers whoami not-logged-in message", () => {
  test("stays brand-neutral — no hardcoded foreign CLI binary name", () => {
    expect(NOT_LOGGED_IN_MESSAGE).not.toMatch(/mimo|opencode/i)
  })

  test("still tells the user what to run", () => {
    expect(NOT_LOGGED_IN_MESSAGE).toContain("auth login")
  })
})

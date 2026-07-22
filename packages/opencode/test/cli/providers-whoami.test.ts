import { describe, expect, test } from "bun:test"
import { describeCredential, formatCredentialOption } from "../../src/cli/cmd/providers"

describe("providers whoami helpers", () => {
  test("describeCredential uses provider label and api user id metadata", () => {
    expect(
      describeCredential("OpenAI", {
        type: "api",
        key: "secret",
        metadata: { uid: "user-123" },
      }),
    ).toEqual(["Provider: OpenAI", "User ID: user-123"])
  })

  test("describeCredential falls back to oauth account id", () => {
    expect(
      describeCredential("OpenAI", {
        type: "oauth",
        refresh: "r",
        access: "a",
        expires: 1,
        accountId: "acct-42",
      }),
    ).toEqual(["Provider: OpenAI", "Account ID: acct-42"])
  })

  test("formatCredentialOption keeps provider-specific label instead of hardcoded MiMo", () => {
    expect(
      formatCredentialOption(
        "openai",
        {
          type: "oauth",
          refresh: "r",
          access: "a",
          expires: 1,
        },
        "OpenAI",
      ).label,
    ).toContain("OpenAI")
  })
})

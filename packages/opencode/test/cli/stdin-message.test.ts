import { describe, expect, it } from "bun:test"
import { readMessageFromStdin } from "../../src/cli/cmd/stdin-message"

// The contract that matters is negative: `read` must not even be CALLED when a
// message argument is present, because calling it is what hangs. Asserting on the
// returned value alone would pass on an implementation that reads first and
// discards — the exact implementation that blocks forever.
function reader() {
  const state = { calls: 0 }
  return {
    state,
    read: async () => {
      state.calls++
      return "piped text"
    },
  }
}

describe("readMessageFromStdin", () => {
  it("reads stdin when the message can come from nowhere else", async () => {
    const r = reader()
    expect(await readMessageFromStdin({ argument: undefined, isTTY: false, read: r.read })).toBe("piped text")
    expect(r.state.calls).toBe(1)
  })

  it("treats an empty argument as no argument — `mimo run \"\" < file` still pipes", async () => {
    const r = reader()
    expect(await readMessageFromStdin({ argument: "   ", isTTY: false, read: r.read })).toBe("piped text")
  })

  it("does not even call read when an argument was given", async () => {
    const r = reader()
    expect(await readMessageFromStdin({ argument: "do the thing", isTTY: false, read: r.read })).toBeUndefined()
    expect(r.state.calls).toBe(0)
  })

  it("never touches a TTY — a human is not a pipe to drain", async () => {
    const r = reader()
    expect(await readMessageFromStdin({ argument: undefined, isTTY: true, read: r.read })).toBeUndefined()
    expect(r.state.calls).toBe(0)
  })

  it("returns an empty pipe as empty rather than undefined, so callers can tell it apart from 'not read'", async () => {
    const calls = { n: 0 }
    const out = await readMessageFromStdin({
      argument: undefined,
      isTTY: false,
      read: async () => {
        calls.n++
        return ""
      },
    })
    expect(out).toBe("")
    expect(calls.n).toBe(1)
  })
})

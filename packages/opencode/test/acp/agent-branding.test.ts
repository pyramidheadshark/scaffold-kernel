import { describe, expect, test } from "bun:test"
import { ACP } from "../../src/acp/agent"
import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import type { OpencodeClient } from "@mimo-ai/sdk/v2"

// The event subscription loop in the constructor is fire-and-forget and
// internally caught (see runEventSubscription/startEventSubscription), so a
// stub sdk that immediately rejects is enough — it never surfaces here.
function makeAgent() {
  const sdk = {
    global: { event: () => Promise.reject(new Error("stub: no event stream in this test")) },
  } as unknown as OpencodeClient
  const connection = {} as unknown as AgentSideConnection
  return new ACP.Agent(connection, { sdk } as never)
}

describe("acp.agent branding", () => {
  test("identifies itself as Scaffold, not the upstream OpenCode name", async () => {
    const agent = makeAgent()
    const result = await agent.initialize({ protocolVersion: 1 } as never)
    expect(result.agentInfo?.name).toBe("Scaffold")
  })

  test("auth method description does not hardcode a foreign CLI command", async () => {
    const agent = makeAgent()
    const result = await agent.initialize({ protocolVersion: 1 } as never)
    const description = result.authMethods?.[0]?.description ?? ""
    expect(description).not.toMatch(/opencode|mimo/i)
    expect(description).toContain("auth login")
  })
})

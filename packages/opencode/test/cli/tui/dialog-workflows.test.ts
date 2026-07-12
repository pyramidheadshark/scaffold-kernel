import { describe, expect, test } from "bun:test"
import { formatWorkflowRunDescription, formatWorkflowRunTitle } from "../../../src/cli/cmd/tui/component/dialog-workflows"

describe("dialog-workflows formatting", () => {
  test("title prefers topLevelStep over currentPhase", () => {
    expect(
      formatWorkflowRunTitle({
        runID: "wf_1",
        sessionID: "ses_1",
        name: "release-ready-smoke",
        status: "running",
        running: 1,
        succeeded: 2,
        failed: 0,
        currentPhase: "P6",
        topLevelStep: "Реализация",
      }),
    ).toContain("Реализация")
  })

  test("description renders external workflow metadata", () => {
    expect(
      formatWorkflowRunDescription({
        runID: "wf_1",
        sessionID: "ses_1",
        name: "release-ready-smoke",
        status: "running",
        running: 1,
        succeeded: 2,
        failed: 0,
        workflowSource: "scaffold-s2tdd",
        readinessVerdict: "blocked:G5",
        blockingGates: ["G5"],
        nextAction: { title: "Закрыть G5", reason: "Нужна реализация" },
      }),
    ).toBe("source: scaffold-s2tdd  •  verdict: blocked:G5  •  gates: G5  •  next: Закрыть G5 — Нужна реализация")
  })
})

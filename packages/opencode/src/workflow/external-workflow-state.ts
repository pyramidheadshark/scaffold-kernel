import { Filesystem } from "@/util"

export interface ExternalWorkflowNextAction {
  title?: string
  reason?: string
}

export interface ExternalWorkflowSnapshot {
  version: number
  source: string
  taskId?: string
  taskName?: string
  currentPhase?: string
  topLevelStep?: string
  blocking?: boolean
  blockingGates?: string[]
  nextAction?: ExternalWorkflowNextAction
  readinessVerdict?: string
}

export function parseExternalWorkflowSnapshot(raw: unknown): ExternalWorkflowSnapshot | undefined {
  if (!isRecord(raw)) return undefined
  if (raw.version !== 1) return undefined
  if (typeof raw.source !== "string" || !raw.source) return undefined
  if (!isOptionalString(raw.taskId)) return undefined
  if (!isOptionalString(raw.taskName)) return undefined
  if (!isOptionalString(raw.currentPhase)) return undefined
  if (!isOptionalString(raw.topLevelStep)) return undefined
  if (!isOptionalBoolean(raw.blocking)) return undefined
  if (!isOptionalString(raw.readinessVerdict)) return undefined
  if (!isOptionalStringArray(raw.blockingGates)) return undefined
  if (!isOptionalNextAction(raw.nextAction)) return undefined

  return {
    version: 1,
    source: raw.source,
    taskId: raw.taskId,
    taskName: raw.taskName,
    currentPhase: raw.currentPhase,
    topLevelStep: raw.topLevelStep,
    blocking: raw.blocking,
    blockingGates: raw.blockingGates,
    nextAction: raw.nextAction,
    readinessVerdict: raw.readinessVerdict,
  }
}

export async function loadExternalWorkflowSnapshot(file?: string): Promise<ExternalWorkflowSnapshot | undefined> {
  if (!file) return undefined
  if (!(await Filesystem.exists(file))) return undefined
  const text = await Filesystem.readText(file).catch(() => undefined)
  if (text === undefined) return undefined
  const parsed = parseJson(text)
  if (parsed === undefined) return undefined
  return parseExternalWorkflowSnapshot(parsed)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string"
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean"
}

function isOptionalStringArray(value: unknown): value is string[] | undefined {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string"))
}

function isOptionalNextAction(value: unknown): value is ExternalWorkflowNextAction | undefined {
  if (value === undefined) return true
  if (!isRecord(value)) return false
  return isOptionalString(value.title) && isOptionalString(value.reason)
}

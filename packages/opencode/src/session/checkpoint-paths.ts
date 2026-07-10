import path from "path"
import fs from "fs/promises"
import { Global } from "@/global"
import type { ProjectID } from "@/project/schema"
import { SessionID } from "./schema"

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

/**
 * Session memory root. Houses checkpoint artifacts, task narratives, and
 * other per-session memory files under `<data>/memory/sessions/<sid>/`.
 */
export function metaDir(sessionID: SessionID): string {
  return path.join(Global.Path.data, "memory", "sessions", sessionID)
}

/**
 * v5 single-file checkpoint at `<sid>/checkpoint.md` (no subdir).
 */
export function checkpointPath(sessionID: SessionID): string {
  return path.join(metaDir(sessionID), "checkpoint.md")
}

/**
 * v5 per-project memory file at `<data>/memory/projects/<pid>/MEMORY.md`.
 */
export function memoryPath(projectID: ProjectID): string {
  return path.join(Global.Path.data, "memory", "projects", projectID, "MEMORY.md")
}

/**
 * Single global memory file at `<data>/memory/global/MEMORY.md`. User-level
 * cross-project preferences. Read-only from the agent side; no auto-create.
 */
export function globalMemoryPath(): string {
  return path.join(Global.Path.data, "memory", "global", "MEMORY.md")
}

async function exactEntryState(filePath: string): Promise<"exact" | "case-insensitive-alias" | "missing"> {
  const dir = path.dirname(filePath)
  const base = path.basename(filePath)
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"
    throw error
  }
  if (entries.includes(base)) return "exact"
  if (entries.some((entry) => entry.toLowerCase() === base.toLowerCase())) return "case-insensitive-alias"
  return "missing"
}

/**
 * One-shot rename of a legacy `projects/<pid>/memory.md` to the canonical
 * `MEMORY.md`. Idempotent: no-op when the uppercase file already exists or
 * when neither exists. The rename is atomic, so concurrent readers see either
 * the old or new name, never a missing file. Call before reading/writing
 * project memory so the uppercase path is authoritative.
 */
export async function migrateProjectMemory(projectID: ProjectID): Promise<void> {
  const upper = memoryPath(projectID)
  const lower = path.join(path.dirname(upper), "memory.md")
  const upperState = await exactEntryState(upper)
  if (upperState === "exact") return
  const lowerState = await exactEntryState(lower)
  if (lowerState === "missing") return

  // On case-insensitive filesystems a legacy `memory.md` aliases `MEMORY.md`, so
  // a direct lower->upper rename can behave like a no-op. Rename through a unique
  // temp name first to force the directory entry's casing to canonicalize.
  const temp = path.join(path.dirname(upper), `.memory-migrate-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`)

  await fs.rename(lower, temp).catch((e) => {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
  })

  const tempState = await exactEntryState(temp)
  if (tempState === "missing") return

  await fs.rename(temp, upper).catch((e) => {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
  })
}

/**
 * v8 session-scoped notes file at `<sid>/notes.md`. Main-agent-only
 * scratchpad; writer reconciles entries at checkpoint events.
 */
export function notesPath(sessionID: SessionID): string {
  return path.join(metaDir(sessionID), "notes.md")
}

/**
 * Per-session tasks directory at `<sid>/tasks/`. Houses per-task progress
 * journals authored either by subagents (Spec ②) or by the splitover
 * plugin (when main checkpoint.md grows past caps).
 */
export function tasksDir(sessionID: SessionID): string {
  return path.join(metaDir(sessionID), "tasks")
}

/**
 * Per-task progress journal at `<sid>/tasks/<TID>/progress.md`. Authored
 * by subagents (Spec ② actor.postStop) and read by the checkpoint writer's
 * reconcile preprocessor (Spec ② Chain 2).
 */
export function progressPath(sessionID: SessionID, taskID: string): string {
  return path.join(tasksDir(sessionID), taskID, "progress.md")
}

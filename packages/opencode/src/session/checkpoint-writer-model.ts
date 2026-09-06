/**
 * Which model the checkpoint writer runs on.
 *
 * Scaffold, 2026-09-06. `tryStartCheckpointWriter` used to pass the PARENT's
 * model to `actor.spawn` unconditionally. `agent["checkpoint-writer"].model`
 * reached the config and was resolved by the agent registry, and then this call
 * site threw it away — so a tiered model policy could not move the single most
 * expensive system agent onto a cheap tier. Over the whole recorded history the
 * writer's model distribution is simply a copy of its parents'.
 *
 * The setting is honoured only under `checkpoint.fork: false`, and that is not a
 * limitation but the shape of the mechanism. `fork: true` exists SO THAT the
 * writer replays the parent's prefix and reuses its prompt cache; a prompt cache
 * is per-model, so switching the model under fork:true would quietly turn every
 * checkpoint into a cold full-prefix read — a latency bill nobody asked for and
 * nobody would see. Under `fork: false` the writer already cold-starts with its
 * own system prompt and a delta slice, so the model is free.
 *
 * Configuring a model under fork:true is therefore reported, not applied — see
 * the caller's log line. Silently ignoring it would be the same class of defect
 * this fork keeps finding: a setting that is accepted, costs budget, and changes
 * nothing.
 */

export interface WriterModelRef {
  providerID: string
  modelID: string
}

/**
 * Parse `"provider/model"` as `Provider.parseModel` does, without importing it
 * (checkpoint.ts deliberately keeps its import surface small to avoid the
 * Actor → SessionPrompt → SessionCheckpoint layer cycle).
 *
 * Returns undefined for anything that is not a non-empty provider AND a
 * non-empty model id: a half-written value must fall back to the parent's model,
 * never spawn against a provider that does not exist.
 */
export function parseWriterModel(raw: unknown): WriterModelRef | undefined {
  if (typeof raw !== "string") return undefined
  const slash = raw.indexOf("/")
  if (slash <= 0) return undefined
  const providerID = raw.slice(0, slash)
  const modelID = raw.slice(slash + 1)
  if (!providerID || !modelID) return undefined
  return { providerID, modelID }
}

/**
 * Задана ли модель в форме ССЫЛКИ НА ГРУППУ (`"lite"`), а не `"provider/model"`.
 *
 * Это законный конфиг ядра: `agent/agent.ts` кладёт значение без слеша в `modelRef`,
 * а не в `model`. Резолвер писателя такую форму применить не может — но и молчать о ней
 * нельзя: настройка была бы принята, стоила бы места в конфиге и не меняла бы ничего,
 * то есть ровно тот дефект, который этот модуль и заводился чинить.
 */
export function isModelGroupRef(raw: unknown): raw is string {
  return typeof raw === "string" && raw.trim().length > 0 && !raw.includes("/")
}

/** The `agent` map of a resolved config, narrowed to the one field we read. */
type AgentConfigMap = Record<string, { model?: unknown } | undefined> | undefined

/**
 * The model the writer should actually be spawned with.
 *
 * Under fork:true this is always `parentModel` — byte-identical to the
 * pre-patch behaviour.
 */
export function resolveWriterModel(input: { agents: AgentConfigMap; parentModel: WriterModelRef; forkMode: boolean }): {
  model: WriterModelRef
  configured?: WriterModelRef
  ignoredBecauseFork: boolean
  /** Задана ссылка на группу — применить нельзя, но сказать об этом обязаны. */
  unsupportedGroupRef?: string
} {
  const raw = input.agents?.["checkpoint-writer"]?.model
  const configured = parseWriterModel(raw)
  if (!configured) {
    return {
      model: input.parentModel,
      ignoredBecauseFork: false,
      ...(isModelGroupRef(raw) ? { unsupportedGroupRef: raw } : {}),
    }
  }
  if (input.forkMode) return { model: input.parentModel, configured, ignoredBecauseFork: true }
  return { model: configured, configured, ignoredBecauseFork: false }
}

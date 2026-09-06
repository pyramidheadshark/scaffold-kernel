import z from "zod"
import path from "path"
import { Effect } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import { Session } from "../session"
import { MessageV2 } from "../session/message-v2"
import { Provider } from "../provider"
import { Instance } from "../project/instance"
import { type SessionID, MessageID, PartID } from "../session/schema"
import EXIT_DESCRIPTION from "./plan-exit.txt"

function getLastModel(sessionID: SessionID) {
  for (const item of MessageV2.stream(sessionID, { agentID: "*" })) {
    if (item.info.role === "user" && item.info.model) return item.info.model
  }
  return undefined
}

export const PlanExitTool = Tool.define(
  "plan_exit",
  Effect.gen(function* () {
    const session = yield* Session.Service
    const question = yield* Question.Service
    const provider = yield* Provider.Service

    return {
      description: EXIT_DESCRIPTION,
      parameters: z.object({}),
      execute: (_params: {}, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (ctx.agent !== "plan") {
            return {
              title: "Not in plan mode",
              output: "You are not in plan mode. This tool is only effective in plan mode.",
              metadata: { switched: false, feedback: "" },
            }
          }

          const info = yield* session.get(ctx.sessionID)
          const plan = path.relative(Instance.worktree, Session.plan(info))

          // never-ask: та же ветка, что в tool/question.ts.
          //
          // Scaffold, 2026-09-06 — исправление собственной наполовину сделанной работы.
          // Предыдущий патч (scaffold-v0.1.32) закрыл вечный висяк headless-прогона на
          // `question`, и его описание называло ДВА тула — `question` и `plan_exit`, —
          // потому что оба зовут `question.ask(...)` напрямую, минуя permission-систему.
          // Лечение при этом поставили только в один. `Question.ask` ждёт голый
          // `Deferred.await` без таймаута, подписки на `question.asked` в `run` нет —
          // значит `plan_exit` в headless как вешал прогон навсегда, так и вешает.
          //
          // Хуже, чем просто недоделка: единственная защита, на которую ссылался
          // downstream (`pi-scaffold/src/scaffold/cli.ts`, шаблон команды `/plan`:
          // «у команды run в ядре hardcoded plan_exit: deny»), тем же патчем ОБЪЯВЛЕНА
          // инертной. То есть дефект остался, а документация назвала его закрытым.
          if (yield* question.neverAsk()) {
            return {
              title: "Plan complete (never-ask)",
              output:
                `[Never-Ask] No user is available to confirm the switch (never-ask mode is on). The plan at ${plan} is complete. ` +
                "Plan mode STAYS active — do not start implementing, and do not call plan_exit again. " +
                "Summarise the plan in your response text and end your turn: the operator will review it and switch agents if they want the work done. " +
                "IMPORTANT: state the plan's conclusion in the response text, not only in thinking — that text is the whole deliverable of an unattended plan run.",
              metadata: { switched: false, feedback: "" },
            }
          }

          const answers = yield* question.ask({
            sessionID: ctx.sessionID,
            questions: [
              {
                key: "plan_exit",
                params: { plan },
                question: `Plan at ${plan} is complete. Would you like to switch to the build agent and start implementing?`,
                header: "Plan",
                options: [
                  { label: "Yes", description: "Switch to build agent and start implementing the plan" },
                  { label: "No", description: "Stay with plan agent to continue refining the plan" },
                ],
              },
            ],
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          const answer = answers[0]?.[0]
          if (answer === "No") {
            return {
              title: "Staying in plan mode",
              output:
                "User chose to stay in plan mode and continue refining the plan. Plan mode is still active — do NOT start implementing. Use the question tool to ask the user which aspects of the plan they want to refine or change, then update the plan file accordingly and call plan_exit again when ready.",
              metadata: { switched: false, feedback: "" },
            }
          }

          if (answer !== "Yes") {
            return {
              title: "User provided feedback",
              output: `User chose not to switch yet and provided feedback: ${answer}\n\nPlan mode is still active — do NOT start implementing. Address the feedback by refining the plan file, then call plan_exit again when the plan is ready.`,
              metadata: { switched: false, feedback: answer },
            }
          }

          const model = getLastModel(ctx.sessionID) ?? (yield* provider.defaultModel())

          const msg: MessageV2.User = {
            id: MessageID.ascending(),
            sessionID: ctx.sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: "build",
            model,
          }
          yield* session.updateMessage(msg)
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: msg.id,
            sessionID: ctx.sessionID,
            type: "text",
            text: `The plan at ${plan} has been approved, you can now edit files. Execute the plan`,
            synthetic: true,
          } satisfies MessageV2.TextPart)

          return {
            title: "Switching to build agent",
            output: "User approved switching to build agent. Wait for further instructions.",
            metadata: { switched: true, feedback: "" },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

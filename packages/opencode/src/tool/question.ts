import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import { QuestionID } from "../question/schema"
import { QuestionOwner } from "../question/owner"
import DESCRIPTION from "./question.txt"

export const Parameters = Schema.Struct({
  questions: Schema.mutable(Schema.Array(Question.Prompt)).annotate({ description: "Questions to ask" }),
})

type Metadata = {
  answers?: ReadonlyArray<Question.Answer>
  // Persisted while waiting so a restarted server can re-ask under the same ID.
  requestID?: QuestionID
  // The process holding the pending request; recovery leaves its live questions alone.
  owner?: QuestionOwner.Owner
}

export const QuestionTool = Tool.define<typeof Parameters, Metadata, Question.Service>(
  "question",
  Effect.gen(function* () {
    const question = yield* Question.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const requestID = QuestionID.ascending()
          yield* ctx.metadata({ metadata: { requestID, owner: QuestionOwner.current } })
          const answers = yield* question.ask({
            id: requestID,
            sessionID: ctx.sessionID,
            questions: params.questions,
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })
          return answerResult(params.questions, answers)
        }).pipe(Effect.orDie),
    }
  }),
)

/** The tool result for QUESTIONS answered with ANSWERS. */
export function answerResult(questions: ReadonlyArray<Question.Prompt>, answers: ReadonlyArray<Question.Answer>) {
  const formatted = questions
    .map((q, i) => `"${q.question}"="${answers[i]?.length ? answers[i].join(", ") : "Unanswered"}"`)
    .join(", ")

  return {
    title: `Asked ${questions.length} question${questions.length > 1 ? "s" : ""}`,
    output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
    metadata: {
      answers,
    },
  }
}

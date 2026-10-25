export * as ToolUserStop from "./user-stop.js"

import { Tool } from "@opencode/schema/tool"
import { Cause, Result } from "effect"
import { Permission } from "../permission.js"
import { QuestionTool } from "./plugin/question.js"

export type Error = Permission.DeclinedError | QuestionTool.CancelledError

// Promise adapters attach the original stop to Tool.Error; Effect tools leave it as a defect.
export function fromCause<E>(cause: Cause.Cause<E>): Result.Result<Error, Cause.Cause<E>> {
  const stop = cause.reasons
    .map((reason) => {
      if (Cause.isDieReason(reason)) return reason.defect
      if (Cause.isFailReason(reason)) return reason.error instanceof Tool.Error ? reason.error.error : reason.error
    })
    .find(
      (value): value is Error =>
        value instanceof Permission.DeclinedError || value instanceof QuestionTool.CancelledError,
    )
  return stop ? Result.succeed(stop) : Result.fail(cause)
}

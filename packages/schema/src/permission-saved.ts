export * as PermissionSaved from "./permission-saved.js"

import { Schema } from "effect"
import { ascending } from "./identifier.js"
import { ProjectID } from "./project-id.js"
import { DateTimeUtcFromMillis, statics } from "./schema.js"

import { SessionID } from "./session-id.js"

export const ID = Schema.String.pipe(
  Schema.brand("PermissionSaved.ID"),
  Schema.annotate({ identifier: "PermissionSaved.ID" }),
  statics((schema) => ({ create: () => schema.make("psv_" + ascending()) })),
)
export type ID = typeof ID.Type

export const Info = Schema.Struct({
  id: ID,
  projectID: ProjectID,
  // The approval answers this Session and its descendants, not the rest of the project.
  sessionID: SessionID,
  action: Schema.String,
  resource: Schema.String,
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
  }),
}).annotate({ identifier: "PermissionSaved.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

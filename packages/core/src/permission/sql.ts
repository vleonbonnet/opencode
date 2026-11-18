import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { Project } from "@opencode/schema/project"
import { Timestamps } from "../database/schema.sql.js"
import { ProjectTable } from "../project/sql.js"
import type { PermissionSaved } from "@opencode/schema/permission-saved"

import type { SessionSchema } from "../session/schema.js"
import { SessionTable } from "../session/sql.js"

export const PermissionTable = sqliteTable(
  "permission",
  {
    id: text().$type<PermissionSaved.ID>().primaryKey(),
    project_id: text()
      .$type<Project.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    action: text().notNull(),
    resource: text().notNull(),
    ...Timestamps,
  },
  (table) => [uniqueIndex("permission_session_action_resource_idx").on(table.session_id, table.action, table.resource)],
)

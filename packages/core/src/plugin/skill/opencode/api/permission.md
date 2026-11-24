# permission

## GET /api/permission/request

Retrieve pending permission requests for a location.

Returns: `{ location: Location.PublicRef; data: Permission.Request[] }`

## Types

- `Location.PublicRef`: `{ directory: string }`
- `Permission.Reason`: `{ resource: string; spelling?: string; rule?: Permission.Rule }`
- `Permission.Request`: `{ id: string; sessionID: string; action: string; resources: string[]; alternates?: string[][]; save?: string[]; metadata?: Record<string, unknown>; source?: Permission.Source; message?: string; reasons?: Permission.Reason[] }`
- `Permission.Rule`: `{ action: string; resource: string; effect: "allow" | "deny" | "ask"; message?: string }`
- `Permission.Source`: `{ type: "tool"; messageID: string; id: string }`

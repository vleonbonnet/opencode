import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { ModelResolver } from "@opencode/core/model-resolver"
import { it } from "../lib/effect"

describe("ModelResolver", () => {
  it.effect("names the credential by key, account or external source, never by its token", () =>
    Effect.sync(() => {
      const identity = ModelResolver.credentialIdentity
      const oauth = (access: string, metadata?: Record<string, unknown>) =>
        Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("device"),
          access,
          refresh: "refresh",
          expires: 0,
          ...(metadata === undefined ? {} : { metadata }),
        })
      const key = (value: string) => Credential.Key.make({ type: "key", key: value })
      const none = { credential: undefined, settings: undefined }

      expect(identity({ ...none, credential: key("a") })).toStartWith("key:")
      expect(identity({ ...none, credential: key("a") })).toBe(identity({ ...none, credential: key("a") }))
      expect(identity({ ...none, credential: key("a") })).not.toBe(identity({ ...none, credential: key("b") }))
      expect(identity({ ...none, credential: key("secret") })).not.toContain("secret")
      // An account the credential records survives a token refresh and a new sign-in; another account is another
      // cache.
      const account = identity({ ...none, credential: oauth("token-1", { accountID: "acct" }) })
      expect(account).toStartWith("account:")
      expect(identity({ ...none, credential: oauth("token-2", { accountID: "acct" }) })).toBe(account)
      expect(identity({ ...none, credential: oauth("token-1", { accountID: "other" }) })).not.toBe(account)
      // Without one nothing stable names the sign-in: the cache is keyed by endpoint alone.
      expect(identity({ ...none, credential: oauth("token-1") })).toBeUndefined()
      const external = (metadata: Record<string, unknown>) =>
        identity({
          ...none,
          credential: Credential.External.make({
            type: "external",
            methodID: Integration.MethodID.make("azure-cli"),
            metadata,
          }),
        })
      expect(external({ resourceName: "a" })).toBe(external({ resourceName: "a" }))
      expect(external({ resourceName: "a" })).not.toBe(external({ resourceName: "b" }))
      expect(identity({ ...none, settings: { apiKey: "configured" } })).toBe(
        identity({ ...none, credential: key("configured") }),
      )
      // Google ADC or an AWS profile found in the environment: whatever the provider finds itself.
      expect(identity(none)).toBeUndefined()
    }),
  )
})

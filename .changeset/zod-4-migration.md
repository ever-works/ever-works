---
'@ever-works/plugin': minor
---

**The SDK now depends on zod 4 (`^4.6.7`).** zod below 4.6.6 is affected by GHSA-mrhx-c7xc-m3w5 and no zod 3 release is patched. `IAiProviderPlugin.askJson` options and `AiOperations.askJson` take a zod 4 schema (`ZodType` from `zod` 4); a plugin that builds its own schemas with zod 3 must move to zod 4. `AiOperations.askJson` now converts the schema to JSON Schema itself, so `.describe()` texts reach the model and the caller's schema is never modified, and it still falls back to a plain completion for a property that is `.optional()` without `.nullable()`, as before.

New in `@ever-works/plugin/helpers`: `zod3ErrorMessage` and `ZOD3_ERROR_MESSAGES`, zod 3's default English validation messages for zod 4 issues (`schema.safeParse(input, ZOD3_ERROR_MESSAGES)`), for callers that show default messages to people. This ships as a minor, like the facade type change before it, because a major would put every published plugin's `^1.x` SDK peer range out of date.

# Integration contract v1 — machine-readable pieces

These files are the published, machine-readable half of the Ever Works integration contract v1. Ever Works implements
it under `/api/integrations/v1`, and Ever Gauzy codes against it (its mock Ever Works server and its tests load these
files). The prose half is [`../spec.md`](../spec.md).

**Contract version:** `v1-draft.15` (2026-10-18; draft.1 2026-10-15, then CR-2 to CR-13 (CR-13: `POST /members/invite`); P2 adds CR-9 (Goals), CR-8 (Missions), CR-10 (organizations), CR-6 (Project Works)). Source of truth: the Gauzy ↔ Ever Works integration plan, document 03
Part B (private `ever-co/homelab` repo,
`docs/superpowers/specs/2026-10-15-gauzy-ever-works-integration/03-events-sync-engine-and-contract.md`). Every change
bumps the version there and gets a change-request (CR) row on that plan's `STATUS.md` board. A breaking change needs `/v2`.

| File                                                                           | What it is                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`schemas/common.schema.json`](schemas/common.schema.json)                     | Shared `$defs`: ids, timestamps, `Seq`, `Version`, `Visibility`, `Actor`, `Owner`, `ExternalLink`, `Page`, …                                                                                                          |
| [`schemas/error.schema.json`](schemas/error.schema.json)                       | Error envelope (B.1) with every code and the status it comes with                                                                                                                                                     |
| [`schemas/event-envelope.schema.json`](schemas/event-envelope.schema.json)     | Event envelope (B.3), shared by the change feed, webhooks v2 and EW plugins                                                                                                                                           |
| [`event-catalog.v1.json`](event-catalog.v1.json)                               | Event catalog v1 (B.4): every type, its aggregate, its `data` schema, phase, child/opt-in flags                                                                                                                       |
| [`schemas/event-catalog.schema.json`](schemas/event-catalog.schema.json)       | Shape of the catalog file                                                                                                                                                                                             |
| [`schemas/resources/*.schema.json`](schemas/resources/)                        | Resource DTOs (B.6): organization, member, agent, team, work, task, task comment, link, whoami, feed page, webhook subscription, visibility-changed data; P2 idea, goal, mission; P3 inbox item; member invite result |
| [`schemas/requests.schema.json`](schemas/requests.schema.json)                 | Request bodies (create/update/PUT-set/transition/comment/link/webhook/batch; P2 ideas, goals, missions and organization create; member invite)                                                                        |
| [`webhook-signature-vectors.json`](webhook-signature-vectors.json)             | Shared signature test vectors (B.5): secret / body / header / clock → expected                                                                                                                                        |
| [`examples/`](examples/)                                                       | One valid instance per DTO, error and a set of event envelopes                                                                                                                                                        |
| [`tools/generate-signature-vectors.mjs`](tools/generate-signature-vectors.mjs) | Regenerates the vectors (deterministic)                                                                                                                                                                               |

## Conventions

- JSON Schema **draft 2020-12**. `$id`s live under `https://ever.works/schemas/integrations/v1/`; `$ref`s are relative,
  so load every `*.schema.json` into one validator (Ajv: `ajv/dist/2020` + `ajv-formats`) and address schemas by `$id`.
- DTOs are closed (`additionalProperties: false`) so a typo fails a contract test. **Consumers** must still ignore
  unknown properties at runtime: v1 grows additively (P2 adds `dueAt`, `startAt`, `estimateMinutes` to tasks, …).
- Open value sets (work `kind`, member `role`, team resource types) are plain strings with `examples`; closed ones (task
  `status`, `priority`, `visibility`, actor types) are `enum`s.
- `seq` and every cursor are **strings**. Compare `seq` values as big integers, never lexically.
- Event `data` for delete/removed events is the last snapshot plus `"deleted": true`; for child events it is the child
  DTO and `aggregate` is the parent with its new version (B.3).

## Validating

Ever Works runs these as contract tests (`packages/agent` — every example, every catalog row, every vector). A Gauzy or
third-party consumer can do the same:

```ts
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
for (const schema of allSchemaFilesUnder('schemas/')) ajv.addSchema(schema);
const validateEnvelope = ajv.getSchema('https://ever.works/schemas/integrations/v1/event-envelope.schema.json')!;
```

## Webhook signatures (B.5)

`X-Ever-Works-Signature: t=<unix-seconds>,v1=<lower-case hex HMAC-SHA256>` over the string `"<t>.<raw body>"`. The
HMAC key is the subscription secret **exactly as returned** by `POST /webhooks` (its UTF-8 bytes; never base64-decode
it). During a secret rotation the header carries two `v1` values (new first); accept when any verifies. Tolerance is
300 seconds, inclusive. This is the same scheme as `verifyWebhookSignature` in `@gauzy/core`. Every receiver must
reproduce `expected` for every vector in [`webhook-signature-vectors.json`](webhook-signature-vectors.json), including
the malformed ones (which must be rejected, not throw).

To regenerate after changing an example it reads:

```bash
node docs/specs/features/integrations-api-v1/contract/tools/generate-signature-vectors.mjs
pnpm prettier --write docs/specs/features/integrations-api-v1/contract/webhook-signature-vectors.json
```

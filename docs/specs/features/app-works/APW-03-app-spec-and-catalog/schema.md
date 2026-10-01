# App spec reference — `.works/works.yml`, kind `app`

> **Normative.** This file is the field-by-field contract for the App spec. The outline in
> [CONTRACTS.md §1](../CONTRACTS.md#1-the-app-spec-owner-apw-03) fixes the top-level key names; this
> file fixes every field, type, default, bound, cross-field rule and issue code beneath them.
> Behaviour lives in [`spec.md`](./spec.md); implementation in [`plan.md`](./plan.md).

**Epic**: `APW-03-app-spec-and-catalog` · **Status**: `Draft` · **Created**: 2026-09-17
**Schema**: `appSpecVersion: 1` inside `.works/works.yml` envelope `version: 2`
**Published as**: the `app` branch of `https://api.ever.works/api/schema/works.yml.schema.json` and the
stand-alone `https://api.ever.works/api/schema/app-spec.schema.json`

---

## 0. How to read this file

| Notation            | Meaning                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| **required**        | Absent ⇒ error `required`.                                                                         |
| _default_           | The value the platform uses when the key is absent. Defaults are never written back into the file. |
| `Name`              | DNS label: `^[a-z]([-a-z0-9]{0,30}[a-z0-9])?$` (1–32 chars).                                       |
| `EnvName`           | `^[A-Z_][A-Z0-9_]{0,127}$`.                                                                        |
| `RelPath`           | Repository-relative path, 1–255 chars; no leading `/`, no `\`, no `..` segment, not under `.git/`. |
| `Glob`              | A `RelPath` that may contain `*`, `**`, `?`; 1–200 chars.                                          |
| `HttpPath`          | `^/[^\s]{0,511}$`.                                                                                 |
| `Cron`              | Five-field cron (`minute hour day-of-month month day-of-week`), UTC.                               |
| `CpuQuantity`       | Millicores `250m` (10m–64000m) or cores `2`, `0.5` (0.01–64).                                      |
| `MemQuantity`       | Integer followed by `Mi` or `Gi`, range `64Mi`–`256Gi`.                                            |
| `StorageQuantity`   | Integer followed by `Mi` or `Gi`, range `100Mi`–`500Gi`.                                           |
| `ImageRef`          | `registry/path[:tag][@sha256:<64 hex>]`, ≤ 512 chars.                                              |
| `Reference`         | See [§21](#21-reference-syntax).                                                                   |
| _error_ / _warning_ | An **error** stops the spec from being applied; a **warning** is shown and the spec still applies. |

Every issue carries a stable `code` ([§23](#23-issue-object-and-codes)). The UI translates codes; the App
Provisioner agent reads them to self-correct.

**Machine-checkable mirror.** §1–§22 are also committed as JSON Schema 2020-12 in
`docs/specs/features/app-works/contracts/app-spec.schema.json` (created by this epic's T59), with a fixture corpus
beside it — `contracts/fixtures/app-spec/valid/` and `contracts/fixtures/app-spec/invalid/<code>.yml`, each invalid
file headed by the code it must report. The JSON Schema is **structural only** — the cross-field rules of
[§22](#22-cross-field-rules) stay in code — and it is checked in CI against the same corpus the validator runs, so a
Blueprint draft, a profile draft and a catalog entry can be validated before this epic's code exists. This file
remains the reference: **where the two disagree, this prose wins** and the JSON Schema is corrected (T59 owns the
guard).

---

## 1. Envelope

```yaml
# yaml-language-server: $schema=https://api.ever.works/api/schema/works.yml.schema.json
version: 2
kind: app
name: Cal.diy (community build) # v1 root keys keep their meaning
spec:
    kind: app # optional; repeats the root kind
    appSpecVersion: 1 # optional; default 1
    source: { relation: fork, upstream: { repo: calcom/cal.diy, defaultBranch: main } }
```

| Key                   | Type    | Default | Notes                                                                                    |
| --------------------- | ------- | ------- | ---------------------------------------------------------------------------------------- |
| `kind` (root)         | string  | —       | `app`. When absent, `spec.kind: app` selects this schema.                                |
| `spec.kind`           | string  | root    | Must equal the root `kind` when both are present — else error `kind_mismatch`.           |
| `spec.appSpecVersion` | integer | `1`     | 1–1000. Newer than this build understands ⇒ `unknown_field` issues become warnings (§2). |

## 2. Strictness, preservation and limits

1. **Strict reporting.** Inside `spec`, a key this schema does not define is error `unknown_field`, with a
   suggestion when a defined key is within edit distance 2 (`replica` → `replicas`).
2. **Preservation.** The platform never deletes a key it does not know. Strictness changes the
   validation result only; every writer round-trips the raw document (the envelope rule in
   `docs/agent-services/works-yml-schema.md` is unchanged).
3. **Extension keys.** Any key starting with `x-` is allowed at any depth inside `spec`, preserved, and
   ignored.
4. **Newer spec.** When `appSpecVersion` is greater than the build's supported version, `unknown_field`
   becomes warning `unknown_field_newer_version`; every other rule still applies.
5. **Limits.** File ≤ 256 KiB (error `file_too_large`); nesting depth ≤ 12; YAML alias expansions ≤ 100
   (error `yaml_alias_limit`); duplicate mapping keys are error `duplicate_key`; at most 200 issues are
   reported, then `truncated: true`.

## 3. Where validation runs

| Where                                      | Mode              | Runs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------ | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Editor (`yaml-language-server`)            | —                 | Structure only (JSON Schema, §25).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Platform, on a Work's Work Repository      | `data-repository` | Structure, §21, §22 and server-only rules.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Platform, draft text (`validate` API)      | `data-repository` | Structure, §21, §22; server-only rules when a Work id is given.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Apps catalog CI, on a Blueprint repository | `blueprint`       | Structure, §21, §22. **`source` and `blueprint` are allowed and expected** — a Blueprint's file becomes the App Work's spec, where both are present (all three APW-13 Blueprints declare both, and catalog CI check C4 requires zero errors). _Corrected 2026-09-17:_ this row used to forbid them with `blueprint_mode_forbidden_key`, which **no APW-13 Blueprint could satisfy** — the code is kept in §23's list but is no longer emitted for these two keys. The rule that does apply in this mode: `blueprint.repo` must name the repository the file lives in. `license` is optional. |

The **effective spec** of an App Work is the most recent evaluation of its tracked branch with zero
errors. A later file with errors is reported but never replaces it; nothing is built or deployed from a
commit whose own spec has errors ([spec.md FR-20](./spec.md)).

## 4. Top-level keys

| Key                    | Type   | Required                         | Owner (consumer)                                                                          | Section |
| ---------------------- | ------ | -------------------------------- | ----------------------------------------------------------------------------------------- | ------- |
| `source`               | object | **required** (`data-repository`) | APW-01 writes; on the Blueprint path APW-03's apply job writes it with the App spec (R-4) | §5      |
| `blueprint`            | object | —                                | APW-03                                                                                    | §6      |
| `license`              | object | —                                | APW-03                                                                                    | §7      |
| `display`              | object | —                                | APW-03 (08, 11)                                                                           | §8      |
| `build`                | object | when `components` is non-empty   | APW-05                                                                                    | §9      |
| `components`           | array  | —                                | APW-06                                                                                    | §10     |
| `dependencies`         | object | —                                | APW-07                                                                                    | §11     |
| `env`                  | array  | —                                | APW-07                                                                                    | §12     |
| `jobs`                 | array  | —                                | APW-06                                                                                    | §13     |
| `cron`                 | array  | —                                | APW-06                                                                                    | §14     |
| `domains`              | object | —                                | APW-06                                                                                    | §15     |
| `smoke`                | array  | —                                | APW-06 (04)                                                                               | §16     |
| `checks`               | array  | —                                | APW-08                                                                                    | §17     |
| `agents`               | object | —                                | APW-08                                                                                    | §18     |
| `upstreamSync`         | object | —                                | APW-02                                                                                    | §19     |
| `upstreamPullRequests` | object | —                                | APW-09                                                                                    | §20     |
| `provisioning`         | object | —                                | APW-04                                                                                    | §20     |

"Owner" is the epic whose runtime consumes the block; APW-03 owns the schema of every block.

## 5. `source`

| Field                    | Type   | Default                        | Rules                                                                                                |
| ------------------------ | ------ | ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `relation`               | enum   | **required**                   | `fork` · `private-copy` · `link`.                                                                    |
| `upstream.repo`          | string | **required** unless `link`     | `^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$`. Forbidden when `link` (`upstream_forbidden_for_link`). |
| `upstream.defaultBranch` | string | upstream's default at creation | Git ref name, 1–255 chars.                                                                           |
| `branch`                 | string | Work Repository default branch | Git ref name, 1–255 chars, not ending `.lock`, no `..`, no `//`. The branch built and deployed.      |

Server-only rule: `relation` must equal the relation recorded when the App Work was created (error
`source_relation_mismatch`) — a hand edit cannot turn a fork into a link.

## 6. `blueprint`

Written by the platform when an App Blueprint is applied; informational afterwards.

| Field     | Type   | Default      | Rules                                                           |
| --------- | ------ | ------------ | --------------------------------------------------------------- |
| `id`      | string | **required** | `^[a-z0-9][a-z0-9-]{0,63}$`.                                    |
| `version` | string | **required** | Semantic version `MAJOR.MINOR.PATCH`.                           |
| `repo`    | string | **required** | `^ever-works/[a-z0-9-]+$` (error `blueprint_repo_outside_org`). |
| `sha`     | string | **required** | `^[0-9a-f]{40}$`.                                               |

Server-only: an `id` the Apps catalog does not list is warning `blueprint_unknown` (upgrade notices stop).

## 7. `license`

Informational. The license gate classifies from **detection**, never from this block.

| Field            | Type   | Default | Rules                                                                                                  |
| ---------------- | ------ | ------- | ------------------------------------------------------------------------------------------------------ |
| `spdx`           | string | —       | SPDX expression ≤ 200 chars (`MIT`, `AGPL-3.0-only`, `MIT OR Apache-2.0`, `LicenseRef-<id>`).          |
| `class`          | enum   | —       | `green` · `amber` · `red` · `unknown`.                                                                 |
| `source`         | enum   | —       | `detected` · `blueprint` · `user`.                                                                     |
| `notice`         | string | —       | ≤ 500 chars. Trademark / attribution notice shown with the app.                                        |
| `sourceOfferUrl` | string | —       | `https://` URL ≤ 500 chars. Where network users obtain the source when the Work Repository is private. |

Server-only: a declared `spdx` or `class` that differs from detection is warning
`license_declared_mismatch`.

## 8. `display`

| Field            | Type   | Default   | Rules                                                                         |
| ---------------- | ------ | --------- | ----------------------------------------------------------------------------- |
| `name`           | string | Work name | 1–80 chars.                                                                   |
| `protectedPaths` | Glob[] | `[]`      | ≤ 50 entries. Agents may not change matching files (D13; enforced by APW-08). |

## 9. `build`

| Field                      | Type        | Default                           | Rules                                                                                                             |
| -------------------------- | ----------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `strategy`                 | enum        | `none` when `components` is empty | `dockerfile` · `image` · `auto` · `none`. **Required** when `components` is non-empty.                            |
| `dockerfile`               | RelPath     | `Dockerfile`                      | Only with `dockerfile`.                                                                                           |
| `context`                  | RelPath     | `.`                               | Only with `dockerfile` / `auto`.                                                                                  |
| `target`                   | string      | —                                 | `^[A-Za-z0-9._-]{1,64}$`. Only with `dockerfile`.                                                                 |
| `image`                    | ImageRef    | **required** with `image`         | Tag-only reference ⇒ warning `image_not_pinned`.                                                                  |
| `args[]`                   | array       | `[]`                              | ≤ 50. Each `{ name: EnvName, value?: string ≤ 1000, fromEnv?: EnvName }`, exactly one of `value` / `fromEnv`.     |
| `services[]`               | array       | `[]`                              | ≤ 5. Each `{ name: Name, image: ImageRef, port?: 1–65535, env?: [{ name, value }] ≤ 20 }`. Ephemeral, build-only. |
| `resources.cpu`            | number      | `2`                               | 1–16.                                                                                                             |
| `resources.memory`         | MemQuantity | `7Gi`                             | `1Gi`–`64Gi`.                                                                                                     |
| `resources.timeoutMinutes` | integer     | `60`                              | 5–180.                                                                                                            |

**Strategies** ([CONTRACTS.md Resolution R-13](../CONTRACTS.md#0-program-audit-resolutions-binding-2026-09-17-against-develop-ee45946e5)):
`dockerfile` builds the named Dockerfile; `image` deploys a prebuilt image and runs no Build; `none` builds and runs
nothing; `auto` is a **zero-config build** — the build plugin detects the language and framework from the repository
and builds an image without a Dockerfile. Which builder implements `auto` is the build plugin's choice and is never
named in the App spec. When no enabled build plugin lists `auto` among its supported strategies, the server-only
warning `build_strategy_unavailable` is reported (§22) and APW-05 refuses the Build.

## 10. `components`

At most 10. At least 1 when `build.strategy` ≠ `none` (error `strategy_requires_components`).

| Field                                 | Type        | Default                              | Rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------- | ----------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                                | Name        | **required**                         | Unique among components.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `role`                                | enum        | **required**                         | `web` (Service + Ingress) · `worker`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `command`                             | string[]    | image entrypoint                     | ≤ 20 items, each ≤ 1000 chars.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `args`                                | string[]    | image cmd                            | ≤ 50 items, each ≤ 1000 chars.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `target`                              | string      | `build.target`                       | Dockerfile stage override for this component.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `port`                                | integer     | **required** for `web`               | 1–65535. Forbidden for `worker` (`worker_port_forbidden`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `replicas`                            | integer     | `1`                                  | 0–10.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `writableRootFilesystem`              | boolean     | `false`                              |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `runAsUser`                           | integer     | — (the image's own user)             | **Added 2026-09-17 (APW06-G26).** 1–4294967294. The numeric uid the container must run as. Needed because an image whose `USER` is a **name** (`umami`'s `nextjs`) cannot satisfy `runAsNonRoot` — the kubelet refuses it with "image has non-numeric user" (APW-06 plan §4.4, §5.1 `image_user_unverifiable`), so the App would be undeployable on **both** targets with no field that could rescue it. The renderer passes it through verbatim and never derives one; on **Ever Works Apps** it is allowed but the tier's own `restricted` policy still applies. Omit it and the field is absent from the rendered pod spec, so every existing App spec renders byte-identically. |
| `probes.{startup,readiness,liveness}` | object      | `readiness: { tcp: true }` for `web` | See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `resources.cpu`                       | CpuQuantity | `250m`                               |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `resources.memory`                    | MemQuantity | `512Mi`                              | Request.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `resources.cpuLimit`                  | CpuQuantity | —                                    | ≥ `cpu`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `resources.memoryLimit`               | MemQuantity | `2 × memory`                         | ≥ `memory` (`limit_below_request`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `volumes[]`                           | array       | `[]`                                 | ≤ 5. `{ name: Name, path: absolute ≤ 255, size: StorageQuantity, backup: boolean = true }`; unique names and paths.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

**Probe object**: exactly one of `http: HttpPath` or `tcp: true`; `periodSeconds` 1–300 (default 10);
`timeoutSeconds` 1–60 (default 5); `initialDelaySeconds` 0–600 (default 0); `failureThreshold` 1–120
(default 3, startup default 30). A `worker` probe must use `tcp` only with a declared port, so workers use
no probe or an `http` probe on a port they open (warning `worker_probe_without_port`).

## 11. `dependencies`

| Field                         | Type     | Default      | Rules                                                                                                |
| ----------------------------- | -------- | ------------ | ---------------------------------------------------------------------------------------------------- |
| `postgres.version`            | enum     | `"16"`       | `"14"` · `"15"` · `"16"` · `"17"`.                                                                   |
| `postgres.directUrl`          | boolean  | `false`      | Also provide a non-pooled URL.                                                                       |
| `postgres.extensions`         | string[] | `[]`         | ≤ 10, each `^[a-z0-9_]{1,63}$`. Availability is provider-specific (warning `extension_unavailable`). |
| `redis.version`               | enum     | `"7"`        | `"7"`.                                                                                               |
| `redis.maxmemoryPolicy`       | enum     | `noeviction` | `noeviction` · `allkeys-lru` · `volatile-lru` · `allkeys-lfu` · `volatile-lfu`.                      |
| `redis.persistence`           | boolean  | `false`      |                                                                                                      |
| `objectStorage.buckets`       | Name[]   | **required** | 1–10, unique.                                                                                        |
| `objectStorage.publicBuckets` | Name[]   | `[]`         | Subset of `buckets` (`public_bucket_undeclared`).                                                    |
| `smtp.required`               | boolean  | `false`      | `true` ⇒ deploy is blocked until SMTP is configured (APW-07).                                        |

**Outputs** a `from:` may reference. _Proposed here; the normative list is APW-07's
`APP_DEPENDENCY_OUTPUTS` and this table must equal it before either epic merges._

| Dependency      | Outputs (secret ones marked †)                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------- |
| `postgres`      | `url`†, `directUrl`† (only with `directUrl: true`), `host`, `port`, `database`, `user`, `password`† |
| `redis`         | `url`†, `host`, `port`, `password`†                                                                 |
| `objectStorage` | `endpoint`, `region`, `accessKeyId`†, `secretAccessKey`†, `bucket.<name>` (one per declared bucket) |
| `smtp`          | `host`, `port`, `user`, `password`†, `from`, `secure`                                               |

## 12. `env[]`

At most 200 entries; `name` unique. Each entry has **exactly one** value source (error
`env_source_count`): `value`, `from`, `template`, `generate` or `prompt`.

| Field         | Type      | Default      | Rules                                                                                                                                                            |
| ------------- | --------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | EnvName   | **required** |                                                                                                                                                                  |
| `secret`      | boolean   | `false`      | Stored encrypted, never logged or returned (Constitution VII).                                                                                                   |
| `phase`       | enum      | `runtime`    | `runtime` · `build` · `both`.                                                                                                                                    |
| `description` | string    | —            | ≤ 300 chars.                                                                                                                                                     |
| `value`       | string    | —            | ≤ 4096 chars. **Forbidden when `secret: true`** (error `literal_secret_value`).                                                                                  |
| `from`        | Reference | —            | §21.                                                                                                                                                             |
| `template`    | string    | —            | ≤ 2048 chars, §21.                                                                                                                                               |
| `generate`    | object    | —            | See below. Implies `secret: true`; `secret: false` is error `generated_not_secret`.                                                                              |
| `validate`    | object    | —            | `length` 1–65536, `minLength`, `maxLength` (≤ 65536, `min ≤ max`), `pattern` ≤ 500 chars, RE2 syntax (no back-references or look-around: `pattern_unsupported`). |
| `prompt`      | object    | —            | `description` **required** 1–300; `required` boolean (default `true`); `example` ≤ 200 (secret-scanned: `prompt_example_secret`); `group` ≤ 40.                  |

**`generate`**

| Field      | Type    | Default             | Rules                                                                   |
| ---------- | ------- | ------------------- | ----------------------------------------------------------------------- |
| `kind`     | enum    | **required**        | `base64` · `hex` · `chars` · `uuid` · `keypair`.                        |
| `bytes`    | integer | `32`                | 16–128. `base64` and `hex` only.                                        |
| `length`   | integer | `32`                | 16–256. `chars` only.                                                   |
| `alphabet` | enum    | `alnum`             | `alnum` · `alnum-symbols` · `hex-lower` · `base64url`. `chars` only.    |
| `keypair`  | object  | `{ type: ed25519 }` | `keypair` only. See below. Public half exposed as `<NAME>_PUBLIC` only. |
| `rotate`   | enum    | `never`             | `never` is the only value in `appSpecVersion: 1`.                       |

**`generate.keypair`** ([CONTRACTS.md Resolution R-11](../CONTRACTS.md#0-program-audit-resolutions-binding-2026-09-17-against-develop-ee45946e5))

| Field         | Type    | Default   | Rules                                                                                                                                                                                           |
| ------------- | ------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`        | enum    | `ed25519` | `ed25519` · `ec-p256` · `rsa-2048` · `rsa-4096`.                                                                                                                                                |
| `format`      | enum    | `pem`     | `pem` · `base64url-raw` · `pkcs12`. `base64url-raw` only with `ed25519` or `ec-p256` (error `keypair_format_unsupported`, R25).                                                                 |
| `passwordEnv` | EnvName | —         | **Required** with `pkcs12`, forbidden otherwise; names another `env` entry that is `secret: true` and generated with `kind` `base64`, `hex` or `chars` (error `keypair_password_invalid`, R26). |

What each format stores — the private half in the entry itself, the public half in `<NAME>_PUBLIC` (a derived,
non-secret value; nothing else about the key pair is exposed):

| `format`        | Private half (`<NAME>`)                                                                                                                                                     | Public half (`<NAME>_PUBLIC`)                                                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `pem`           | PKCS #8 PEM (`-----BEGIN PRIVATE KEY-----`).                                                                                                                                | SubjectPublicKeyInfo PEM (`-----BEGIN PUBLIC KEY-----`).                                                                                 |
| `base64url-raw` | The raw private key bytes, base64url without padding: `ed25519` 32-byte seed and `ec-p256` 32-byte scalar are both **43** characters.                                       | The raw public key, base64url without padding: `ed25519` 32 bytes (43 characters); `ec-p256` uncompressed 65-byte point (87 characters). |
| `pkcs12`        | A PKCS #12 archive (the private key plus a self-signed certificate whose subject names the entry), standard base64 with padding, encrypted with the value of `passwordEnv`. | SubjectPublicKeyInfo PEM.                                                                                                                |

```yaml
env:
    # PEM, the default — a JWT signing key
    - { name: JWT_SIGNING_KEY, secret: true, generate: { kind: keypair, keypair: { type: ed25519 } } }
    # Raw base64url — web-push keys; the fixed 43-character length may be validated
    - {
          name: VAPID_PRIVATE_KEY,
          secret: true,
          generate: { kind: keypair, keypair: { type: ec-p256, format: base64url-raw } },
          validate: { length: 43, pattern: '^[A-Za-z0-9_-]{43}$' }
      }
    # PKCS #12 — protected by a separately generated password
    - { name: SAML_KEY_PASSWORD, secret: true, generate: { kind: chars, length: 32, alphabet: alnum } }
    - {
          name: SAML_SIGNING_KEY,
          secret: true,
          generate: { kind: keypair, keypair: { type: rsa-2048, format: pkcs12, passwordEnv: SAML_KEY_PASSWORD } }
      }
    # Invalid — rsa has no raw form (keypair_format_unsupported); pkcs12 without a password (keypair_password_invalid)
    - { name: BAD_RAW, secret: true, generate: { kind: keypair, keypair: { type: rsa-4096, format: base64url-raw } } }
    - { name: BAD_P12, secret: true, generate: { kind: keypair, keypair: { type: ec-p256, format: pkcs12 } } }
```

**Generated length** (used by rule R9): `hex` = `2 × bytes`; `base64` = `4 × ceil(bytes / 3)`; `chars` =
`length`; `uuid` = 36; `keypair` with `format: base64url-raw` = 43; any other `keypair` has no fixed length (any
`validate.length` is error `generate_validate_conflict`). An entry may not declare `<NAME>_PUBLIC` for a keypair
entry `<NAME>` (error `duplicate_name`, R4).

## 13. `jobs[]`

At most 10; `name` unique.

| Field                | Type     | Default                    | Rules                                                                                                                                                       |
| -------------------- | -------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`               | Name     | **required**               |                                                                                                                                                             |
| `when`               | enum     | **required**               | `pre-deploy` · `first-deploy` · `post-deploy`. `first-deploy` jobs run before the app is exposed publicly.                                                  |
| `component`          | Name     | `domains.primaryComponent` | Must name a component (`component_ref_unknown`); the job uses its image and env. An `http` job needs a `web` component (`http_job_requires_web_component`). |
| `command`            | string[] | —                          | Exactly one of `command` / `http`. ≤ 20 items × 1000 chars.                                                                                                 |
| `http.method`        | enum     | `POST`                     | `GET` · `POST` · `PUT` · `PATCH` · `DELETE`.                                                                                                                |
| `http.path`          | HttpPath | **required**               | Sent to the component's port inside the cluster, never through the public URL.                                                                              |
| `http.body`          | JSON     | —                          | ≤ 16 KiB serialized. String leaves may contain `{{…}}` placeholders (§21).                                                                                  |
| `http.authEnv`       | EnvName  | —                          | Must name a `secret: true` entry.                                                                                                                           |
| `http.authScheme`    | enum     | `bearer`                   | `bearer` sends `Authorization: Bearer <value>`; `raw` sends `Authorization: <value>` (CONTRACTS §1, APW-13 addition). Only with `authEnv`.                  |
| `http.expect.status` | int[]    | `[200, 201, 204]`          | 1–10 codes, 100–599.                                                                                                                                        |
| `timeoutSeconds`     | integer  | `600`                      | 10–3600.                                                                                                                                                    |
| `retries`            | integer  | `0`                        | 0–3.                                                                                                                                                        |

## 14. `cron[]`

The app's own recurring calls, rendered as cluster CronJobs — not platform Schedules. At most 20.

| Field              | Type    | Default                    | Rules                                                   |
| ------------------ | ------- | -------------------------- | ------------------------------------------------------- |
| `name`             | Name    | **required**               | Unique.                                                 |
| `schedule`         | Cron    | **required**               | `cron_invalid` when unparsable.                         |
| `component`        | Name    | `domains.primaryComponent` |                                                         |
| `command` / `http` | —       | exactly one                | `http` as in §13, including `authEnv` and `authScheme`. |
| `timeoutSeconds`   | integer | `300`                      | 10–3600.                                                |
| `concurrency`      | enum    | `forbid`                   | `forbid` · `allow`.                                     |

## 15. `domains`

| Field              | Type      | Default                  | Rules                                                             |
| ------------------ | --------- | ------------------------ | ----------------------------------------------------------------- |
| `primaryComponent` | Name      | the only `web` component | Must name a `web` component. **Required** with 2+ web components. |
| `publicUrlEnv`     | EnvName[] | `[]`                     | ≤ 10; each names an `env` entry.                                  |
| `onChange`         | enum      | `restart`                | `restart` · `rebuild`.                                            |
| `needsHairpin`     | boolean   | `false`                  | The app calls its own public URL from the server side.            |

## 16. `smoke[]`

At most 20; `name` unique. Smoke requests never follow redirects, so `expect.status` judges the first
response (CONTRACTS §1).

| Field                    | Type     | Default                    | Rules                      |
| ------------------------ | -------- | -------------------------- | -------------------------- |
| `http.method`            | enum     | `GET`                      | `GET` · `HEAD` · `POST`.   |
| `http.path`              | HttpPath | **required**               |                            |
| `http.body`              | JSON     | —                          | ≤ 16 KiB, `POST` only.     |
| `component`              | Name     | `domains.primaryComponent` | Must be `web`.             |
| `expect.status`          | int[]    | `[200]`                    | 1–10 codes.                |
| `expect.bodyContains`    | string[] | `[]`                       | ≤ 5 × 200 chars.           |
| `expect.bodyNotContains` | string[] | `[]`                       | ≤ 5 × 200 chars.           |
| `expect.maxLatencyMs`    | integer  | `10000`                    | 100–60000.                 |
| `when`                   | enum     | `always`                   | `always` · `first-deploy`. |

## 17. `checks[]`

Quality gates for Tasks on this App Work; run sandboxed (README §7 rule 9). At most 20; `name` unique.

| Field            | Type    | Default      | Rules                                                                      |
| ---------------- | ------- | ------------ | -------------------------------------------------------------------------- |
| `name`           | Name    | **required** |                                                                            |
| `command`        | string  | **required** | 1–500 chars, at least one non-whitespace character, no control characters. |
| `required`       | boolean | `true`       | `false` is warning `advisory_check` — an advisory check verifies nothing.  |
| `timeoutSeconds` | integer | `1800`       | 60–7200.                                                                   |

## 18. `agents`

| Field                        | Type      | Default | Rules                                                                                                                                                                                                                                                  |
| ---------------------------- | --------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `instructionFiles`           | RelPath[] | `[]`    | ≤ 10.                                                                                                                                                                                                                                                  |
| `maxPullRequestChangedLines` | integer   | `500`   | 50–5000.                                                                                                                                                                                                                                               |
| `maxPullRequestChangedFiles` | integer   | `50`    | 1–500.                                                                                                                                                                                                                                                 |
| `requireHumanMergePaths`     | Glob[]    | `[]`    | ≤ 50 entries. Paths whose changes **only a person may merge**, whatever the merge policy says (semantics: APW-08; declared in CONTRACTS §1 "Additions (APW-08)". Removals from this list are reported by `diffGuardedSpecBlocks` — see CONTRACTS §2A). |

## 19. `upstreamSync`

Forbidden when `source.relation` is `link` (`upstream_sync_requires_upstream`).

| Field      | Type    | Default                  | Rules                                                                  |
| ---------- | ------- | ------------------------ | ---------------------------------------------------------------------- |
| `enabled`  | boolean | `true`                   |                                                                        |
| `schedule` | Cron    | `0 6 * * 1`              | Consecutive fires at least 60 minutes apart (`schedule_too_frequent`). |
| `mode`     | enum    | `merge`                  | `merge` only.                                                          |
| `branch`   | string  | `upstream.defaultBranch` | Git ref name.                                                          |

## 20. `upstreamPullRequests` and `provisioning`

| Field             | Type    | Default | Rules                                                                  |
| ----------------- | ------- | ------- | ---------------------------------------------------------------------- |
| `enabled`         | boolean | `false` | `true` requires `source.relation: fork` (`upstream_prs_require_fork`). |
| `requireApproval` | boolean | `true`  | **Only `true` is valid** (`upstream_pr_approval_required`).            |
| `maxOpen`         | integer | `3`     | 1–10.                                                                  |

**`provisioning`** (CONTRACTS §1, APW-04 addition; the App Provisioner never writes it):

| Field             | Type    | Default | Rules                                                                                         |
| ----------------- | ------- | ------- | --------------------------------------------------------------------------------------------- |
| `autoReprovision` | boolean | `false` | The owner's opt-in to automatic re-provisioning when an Upstream sync breaks the smoke tests. |

---

## 21. Reference syntax

```
Reference   := DomainRef | DepRef | PlatformRef | BuildRef | ComponentRef
DomainRef   := "domains.primary." ( "url" | "host" )
BuildRef    := "build.commitSha"                   ; CONTRACTS §1, APW-13 addition
ComponentRef := "components." Name ".internalUrl"   ; CONTRACTS §1, APW-13 addition
DepRef      := "deps." DepKind "." Output
DepKind     := "postgres" | "redis" | "objectStorage" | "smtp"
Output      := Identifier | "bucket." Name          ; bucket.<name> for objectStorage only
PlatformRef := "platform.smtp." ( "host" | "port" | "user" | "password" | "from" | "secure" )
Template    := { Literal | "{{" Space* ( Reference | EnvRef ) Space* "}}" }
EnvRef      := "env." EnvName
FromEnv     := EnvName                              ; build.args[].fromEnv only
```

| Construct                    | Resolves when                                                             | Otherwise                                 |
| ---------------------------- | ------------------------------------------------------------------------- | ----------------------------------------- |
| `domains.primary.*`          | at least one `web` component exists                                       | `reference_unresolved`                    |
| `deps.<kind>.<out>`          | `dependencies.<kind>` is declared and `<out>` is one of its outputs (§11) | `reference_unresolved`                    |
| `platform.smtp.*`            | `dependencies.smtp` is declared                                           | `reference_unresolved`                    |
| `build.commitSha`            | `build.strategy` is `dockerfile` or `auto` (a Build produces the image)   | `reference_unresolved`                    |
| `components.<n>.internalUrl` | a component named `<n>` exists and is `web`                               | `reference_unresolved`                    |
| `env.<NAME>`                 | an `env` entry named `<NAME>` exists and is not the entry itself          | `reference_unresolved` / `template_cycle` |
| `fromEnv`                    | an `env` entry exists with `phase` `build` or `both`                      | `reference_unresolved` / `phase_mismatch` |
| any placeholder              | matches the grammar                                                       | `reference_syntax`                        |

**Secrecy propagates.** An entry whose `from` names a † output, or whose `template` references a †
output or an `env` entry with `secret: true`, must itself be `secret: true` (error
`secret_reference_not_secret`). **Phase propagates.** A `runtime` entry cannot template a `build`-only
entry and vice versa (`phase_mismatch`). **Cycles** among `template` entries are error `template_cycle`
naming every entry in the cycle. Resolution depth ≤ 10 (`template_too_deep`).

## 22. Cross-field rules

| #   | Rule                                                                                                                                                                                                                                                                                                                                                                                                         | Code                                                                                            | Severity                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| R1  | A `web` component declares `port`.                                                                                                                                                                                                                                                                                                                                                                           | `web_component_needs_port`                                                                      | error                                                      |
| R2  | `build.strategy` ≠ `none` ⇒ at least one component; components ⇒ strategy declared.                                                                                                                                                                                                                                                                                                                          | `strategy_requires_components` / `components_require_strategy`                                  | error                                                      |
| R3  | `domains.primaryComponent` names a `web` component; required with 2+ `web` components.                                                                                                                                                                                                                                                                                                                       | `primary_component_invalid`                                                                     | error                                                      |
| R4  | Names are unique within `components`, `jobs`, `cron`, `smoke`, `checks`; `env` names unique, counting the implicit `<NAME>_PUBLIC` of each keypair entry.                                                                                                                                                                                                                                                    | `duplicate_name`                                                                                | error                                                      |
| R5  | Every `from:` / `template:` / `fromEnv:` resolves (§21).                                                                                                                                                                                                                                                                                                                                                     | `reference_unresolved`                                                                          | error                                                      |
| R6  | Secrecy and phase propagate (§21).                                                                                                                                                                                                                                                                                                                                                                           | `secret_reference_not_secret` / `phase_mismatch`                                                | error                                                      |
| R7  | Each `env` entry has exactly one value source.                                                                                                                                                                                                                                                                                                                                                               | `env_source_count`                                                                              | error                                                      |
| R8  | A `secret: true` entry has no `value`.                                                                                                                                                                                                                                                                                                                                                                       | `literal_secret_value`                                                                          | error                                                      |
| R9  | `generate` and `validate` agree: `validate.length` equals the generated length (§12); `minLength ≤ generated ≤ maxLength`; `pattern` matches 3 sample values generated from a fixed seed.                                                                                                                                                                                                                    | `generate_validate_conflict`                                                                    | error                                                      |
| R10 | `build.args[].value` contains no secret: the platform secret scanner matches the value, or the arg name contains `SECRET`, `TOKEN`, `PASSWORD`, `PASSWD`, `PRIVATE`, `CREDENTIAL`, `APIKEY` or `API_KEY` and the literal is non-empty. The value is never echoed.                                                                                                                                            | `literal_secret_in_build_args`                                                                  | error                                                      |
| R11 | `build.args[].fromEnv` naming a `secret: true` entry — the value is baked into image layers.                                                                                                                                                                                                                                                                                                                 | `secret_build_arg`                                                                              | warning                                                    |
| R12 | `upstreamPullRequests.requireApproval` is `true`.                                                                                                                                                                                                                                                                                                                                                            | `upstream_pr_approval_required`                                                                 | error                                                      |
| R13 | `source.relation: link` ⇒ no `source.upstream`, no `upstreamSync`, `upstreamPullRequests.enabled` not `true`.                                                                                                                                                                                                                                                                                                | `upstream_forbidden_for_link` · `upstream_sync_requires_upstream` · `upstream_prs_require_fork` | error                                                      |
| R14 | `jobs[].component`, `cron[].component`, `smoke[].component` name existing components; `smoke` targets `web`.                                                                                                                                                                                                                                                                                                 | `component_ref_unknown`                                                                         | error                                                      |
| R15 | `http.authEnv` names a `secret: true` entry.                                                                                                                                                                                                                                                                                                                                                                 | `auth_env_not_secret`                                                                           | error                                                      |
| R16 | `domains.publicUrlEnv[]` names existing `env` entries.                                                                                                                                                                                                                                                                                                                                                       | `reference_unresolved`                                                                          | error                                                      |
| R17 | `memoryLimit ≥ memory`, `cpuLimit ≥ cpu`.                                                                                                                                                                                                                                                                                                                                                                    | `limit_below_request`                                                                           | error                                                      |
| R18 | A component with `volumes` and `replicas > 1` — a volume cannot attach to two pods (aligned with APW-06).                                                                                                                                                                                                                                                                                                    | `volume_replicas`                                                                               | error                                                      |
| R19 | `build.strategy: image` with a tag-only reference.                                                                                                                                                                                                                                                                                                                                                           | `image_not_pinned`                                                                              | warning (error in `blueprint` mode for `verified` entries) |
| R20 | `checks[].required: false`.                                                                                                                                                                                                                                                                                                                                                                                  | `advisory_check`                                                                                | warning                                                    |
| R21 | `upstreamSync.schedule` fires at most once per 60 minutes.                                                                                                                                                                                                                                                                                                                                                   | `schedule_too_frequent`                                                                         | error                                                      |
| R22 | `display.protectedPaths` and every `RelPath` are relative and stay inside the repository.                                                                                                                                                                                                                                                                                                                    | `path_outside_repository`                                                                       | error                                                      |
| R23 | No `env` entry is named `EVER_WORKS_*` — that prefix is reserved for platform-injected values.                                                                                                                                                                                                                                                                                                               | `reserved_env_name`                                                                             | error                                                      |
| R24 | `license.class: green` declared while `license.spdx` maps to another class in the registry.                                                                                                                                                                                                                                                                                                                  | `license_declared_mismatch`                                                                     | warning                                                    |
| R25 | `generate.keypair.format: base64url-raw` is used only with `type` `ed25519` or `ec-p256` (R-11).                                                                                                                                                                                                                                                                                                             | `keypair_format_unsupported`                                                                    | error                                                      |
| R26 | `generate.keypair.passwordEnv` is present exactly when `format: pkcs12`, and names another `secret: true` entry generated with `kind` `base64`, `hex` or `chars` (R-11).                                                                                                                                                                                                                                     | `keypair_password_invalid`                                                                      | error                                                      |
| R27 | `license.sourceOfferUrl` is **required whenever the Work Repository is not public** (private fork or private copy), because the Source link is the licence's network-source-offer condition; a public repository satisfies it by being public. Added 2026-09-17: `ACC-03-36` already asserted `sourceOfferMissing`, but that code existed in no rule table and no code list, so the scenario could not pass. | `sourceOfferMissing`                                                                            | error                                                      |

**Server-only rules** (need platform state, so editors cannot run them): `source_relation_mismatch`
(§5), `blueprint_unknown` (§6), `license_declared_mismatch` against detection (§7),
`build_strategy_unavailable` (no enabled `build` plugin lists the strategy — for example `auto` — among its
supported strategies — warning),
`dependency_unavailable` (no enabled `app-dependency` provider for the kind on the selected target —
warning), `tracked_branch_missing` (error).

**The context those rules read (`RuleContext`)** — this table is the whole of it, and the validator reads nothing
else:

| Field                 | Type                                                                   | Who fills it                                                                       | Rule it serves                                         |
| --------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `recordedRelation`    | `link` · `fork` · `private-copy`                                       | the Work's `sourceRepository.type`                                                 | `source_relation_mismatch` (§5)                        |
| `catalogIds`          | `string[]`, or `null` when the catalog is unreachable                  | APW-03's catalog registry                                                          | `blueprint_unknown` (§6)                               |
| `catalogUnavailable`  | boolean                                                                | the same read                                                                      | suppresses `blueprint_unknown` instead of reporting it |
| `buildStrategies`     | `string[]`, or `null` when no `build` plugin is enabled                | `IBuildPlugin.supportedStrategies` over the enabled build plugins                  | `build_strategy_unavailable`                           |
| `dependencyProviders` | providers by kind for the Work's deploy target, or `null` when unknown | `IAppDependencyProvider.supports(kind, target, ctx)` over the configured providers | `dependency_unavailable`                               |
| `trackedBranchExists` | boolean, or `null` when the branch could not be read                   | `GitFacadeService.getLatestCommit` on the tracked branch                           | `tracked_branch_missing`                               |

**A field left `null` (unknown) skips its rule** — nothing is reported for state the platform could not read.
That is what keeps a valid App spec from showing "valid, with warnings" just because APW-05 or APW-07 has not
merged yet, and it is why `build_strategy_unavailable` applies only to strategies that need a builder
(`dockerfile` and `auto`): `image` and `none` name no builder, so an empty plugin list never warns about them.

**Which structural problems suppress the rules.** The rule set (§21, §22) runs **whenever the document parses**.
Only these suppress it completely: `yaml_syntax`, `file_too_large`, `yaml_alias_limit` and the depth limit. Every
other structural problem (`unknown_field`, `invalid_type`, `out_of_range`, `pattern`, …) is reported **together
with** the rule findings, which are computed over a best-effort copy of the document with the offending keys and
invalid leaves removed — so §24.4 reports `unknown_field` and its five rule codes in one response, and a single
invalid leaf never produces a duplicate report for the same path. When a subtree cannot be copied at all, the
issue that names it records which rules were skipped in its `params`.

## 23. Issue object and codes

```json
{
	"code": "web_component_needs_port",
	"severity": "error",
	"path": "spec.components[0].port",
	"pointer": "/spec/components/0/port",
	"displayPath": "components › web › port",
	"line": 41,
	"column": 7,
	"message": "Web components must declare the port they listen on.",
	"hint": "Add `port: <number>` under the `web` component.",
	"params": { "component": "web" }
}
```

- `path` uses array indexes; `displayPath` uses component/job/env **names** where they exist.
- `line`/`column` are 1-based and point at the key when present, else at the nearest parent key.
- `message` and `hint` are English and never contain a value from the file for `secret` entries,
  `build.args`, or `prompt.example`.
- Codes are append-only. Removing or renaming a code is a breaking change (Constitution X).

**Structural codes**: `yaml_syntax`, `file_too_large`, `yaml_alias_limit`, `duplicate_key`, `kind_mismatch`,
`required`, `invalid_type`, `invalid_enum`, `out_of_range`, `pattern`, `unknown_field`,
`unknown_field_newer_version`, `blueprint_mode_forbidden_key`, `pattern_unsupported`,
`prompt_example_secret`, `generated_not_secret`, `worker_port_forbidden`, `worker_probe_without_port`, `http_job_requires_web_component`,
`public_bucket_undeclared`, `extension_unavailable`, `cron_invalid`, `reference_syntax`, `template_cycle`,
`template_too_deep`, `blueprint_repo_outside_org`.
**Rule codes**: every code in §22.

## 24. Examples

### 24.1 Single container with Postgres — Cal.diy (the program's running example)

```yaml
version: 2
kind: app
name: Cal.diy (community build)
spec:
    source: { relation: fork, upstream: { repo: calcom/cal.diy, defaultBranch: main }, branch: main }
    blueprint: { id: cal, version: 1.0.0, repo: ever-works/cal-template, sha: 0123456789abcdef0123456789abcdef01234567 }
    license: { spdx: MIT, class: green, source: blueprint, notice: 'Cal.diy® is a trademark of Cal.com, Inc.' }
    display: { name: 'Cal.diy (community build)', protectedPaths: ['apps/web/public/brand/**'] }
    build:
        strategy: dockerfile
        dockerfile: Dockerfile
        target: runner
        args:
            - { name: NEXT_PUBLIC_WEBAPP_URL, value: 'http://NEXT_PUBLIC_WEBAPP_URL_PLACEHOLDER' }
            - { name: CALENDSO_ENCRYPTION_KEY, fromEnv: CALENDSO_ENCRYPTION_KEY } # R11 warning, accepted
        services:
            [
                {
                    name: postgres,
                    image: 'postgres:16',
                    port: 5432,
                    env: [{ name: POSTGRES_PASSWORD, value: build-only }]
                }
            ]
        resources: { cpu: 4, memory: 12Gi, timeoutMinutes: 60 }
    components:
        - name: web
          role: web
          command: ['/calcom/scripts/start.sh']
          port: 3000
          writableRootFilesystem: true
          probes:
              startup: { http: /api/version, periodSeconds: 10, failureThreshold: 60 }
              readiness: { http: /auth/login }
              liveness: { http: /api/version, periodSeconds: 30 }
          resources: { cpu: 500m, memory: 1Gi, memoryLimit: 3Gi }
    dependencies:
        postgres: { version: '16', directUrl: true }
        smtp: { required: true }
    env:
        - { name: NEXTAUTH_SECRET, secret: true, generate: { kind: base64, bytes: 32 } }
        - {
              name: CALENDSO_ENCRYPTION_KEY,
              secret: true,
              phase: both,
              generate: { kind: chars, length: 32, alphabet: alnum },
              validate: { length: 32 }
          }
        - { name: CRON_API_KEY, secret: true, generate: { kind: hex, bytes: 32 } }
        - { name: DATABASE_URL, secret: true, from: deps.postgres.url }
        - { name: DATABASE_DIRECT_URL, secret: true, from: deps.postgres.directUrl }
        - { name: NEXT_PUBLIC_WEBAPP_URL, from: domains.primary.url }
        - { name: NEXTAUTH_URL, template: '{{domains.primary.url}}/api/auth' }
        - { name: EMAIL_SERVER_HOST, from: deps.smtp.host }
        - { name: EMAIL_SERVER_PASSWORD, secret: true, from: deps.smtp.password }
        - {
              name: GOOGLE_API_CREDENTIALS,
              secret: true,
              prompt: { description: 'Google Calendar OAuth JSON', required: false }
          }
        - { name: CALCOM_TELEMETRY_DISABLED, value: '1' }
    jobs:
        - {
              name: migrate,
              when: pre-deploy,
              component: web,
              command: ['npx', 'prisma', 'migrate', 'deploy'],
              timeoutSeconds: 900
          }
    cron:
        - {
              name: booking-reminder,
              schedule: '*/15 * * * *',
              http: { method: POST, path: /api/cron/bookingReminder, authEnv: CRON_API_KEY, authScheme: raw }
          }
    domains:
        {
            primaryComponent: web,
            publicUrlEnv: [NEXT_PUBLIC_WEBAPP_URL, NEXTAUTH_URL],
            onChange: restart,
            needsHairpin: true
        }
    smoke:
        - { name: version, http: { path: /api/version }, expect: { status: [200] } }
        - { name: login, http: { path: /auth/login }, expect: { status: [200], bodyNotContains: ['localhost:3000'] } }
    checks:
        - { name: type-check, command: 'yarn type-check:ci --force', timeoutSeconds: 1800 }
    agents: { instructionFiles: [AGENTS.md], maxPullRequestChangedLines: 500 }
    upstreamSync: { schedule: '0 6 * * 1', mode: merge }
    upstreamPullRequests: { enabled: false, requireApproval: true }
```

### 24.2 Prebuilt image — a small analytics app (illustrative)

```yaml
version: 2
kind: app
spec:
    source: { relation: fork, upstream: { repo: example-org/analytics, defaultBranch: main } }
    build:
        {
            strategy: image,
            image: 'ghcr.io/example-org/analytics@sha256:9f2c1e0b7a4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0f9e8d7c6b5a49'
        }
    components:
        - name: web
          role: web
          port: 3000
          probes: { startup: { http: /api/heartbeat, failureThreshold: 30 }, readiness: { http: /api/heartbeat } }
          resources: { cpu: 250m, memory: 512Mi, memoryLimit: 1Gi }
    dependencies: { postgres: { version: '16' } }
    env:
        - { name: DATABASE_URL, secret: true, from: deps.postgres.url }
        - { name: APP_SECRET, secret: true, generate: { kind: hex, bytes: 32 }, validate: { length: 64 } }
        - { name: ADMIN_PASSWORD, secret: true, generate: { kind: chars, length: 24, alphabet: alnum-symbols } }
        - { name: DISABLE_TELEMETRY, value: '1' }
    jobs:
        - name: set-admin-password
          when: first-deploy
          component: web
          http:
              {
                  method: POST,
                  path: /api/setup/admin,
                  body: { password: '{{env.ADMIN_PASSWORD}}' },
                  expect: { status: [200, 201] }
              }
    smoke:
        - { name: heartbeat, http: { path: /api/heartbeat }, expect: { status: [200], maxLatencyMs: 2000 } }
```

`build.strategy: image` means no Build runs (APW-05); the checks, Upstream sync and evolve loop still work on
the fork, but a code change only reaches production once the image is built by some other means.

### 24.3 Web + worker with Redis — a help-desk app (illustrative)

```yaml
version: 2
kind: app
spec:
    source: { relation: private-copy, upstream: { repo: example-org/helpdesk, defaultBranch: main } }
    build: { strategy: dockerfile, dockerfile: docker/Dockerfile, context: ., resources: { memory: 6Gi } }
    components:
        - {
              name: web,
              role: web,
              command: ['node', 'dist/server.js'],
              port: 8080,
              probes: { readiness: { http: /healthz }, liveness: { http: /healthz, periodSeconds: 30 } },
              resources: { cpu: 500m, memory: 768Mi, memoryLimit: 1536Mi }
          }
        - {
              name: worker,
              role: worker,
              command: ['node', 'dist/worker.js'],
              replicas: 2,
              resources: { cpu: 250m, memory: 512Mi }
          }
    dependencies:
        postgres: { version: '16' }
        redis: { version: '7', maxmemoryPolicy: noeviction }
        objectStorage: { buckets: [attachments] }
    env:
        - { name: DATABASE_URL, secret: true, from: deps.postgres.url }
        - { name: REDIS_URL, secret: true, from: deps.redis.url }
        - { name: S3_ENDPOINT, from: deps.objectStorage.endpoint }
        - { name: S3_BUCKET, from: deps.objectStorage.bucket.attachments }
        - { name: S3_ACCESS_KEY_ID, secret: true, from: deps.objectStorage.accessKeyId }
        - { name: S3_SECRET_ACCESS_KEY, secret: true, from: deps.objectStorage.secretAccessKey }
        - { name: SESSION_SECRET, secret: true, generate: { kind: base64, bytes: 48 }, validate: { length: 64 } }
        - { name: PUBLIC_URL, from: domains.primary.url }
        - { name: SIGNUP_ENABLED, value: 'false' }
    jobs:
        - { name: migrate, when: pre-deploy, component: web, command: ['node', 'dist/migrate.js'] }
    cron:
        - { name: purge-trash, schedule: '30 3 * * *', component: worker, command: ['node', 'dist/purge.js'] }
    smoke:
        - { name: health, http: { path: /healthz }, expect: { status: [200] } }
    upstreamSync: { schedule: '0 5 * * *' }
    upstreamPullRequests: { enabled: false } # a private copy cannot open upstream pull requests (D2)
```

### 24.4 What an invalid file reports

```yaml
spec:
    source: { relation: fork, upstream: { repo: example-org/helpdesk } }
    build: { strategy: dockerfile, args: [{ name: PAYMENTS_SECRET_KEY, value: '<a real key pasted here>' }] }
    components: [{ name: web, role: web, replica: 2 }]
    env: [{ name: DATABASE_URL, from: deps.postgres.url }]
    upstreamPullRequests: { requireApproval: false }
```

| Code                            | displayPath                                | Message                                                                            |
| ------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------- |
| `literal_secret_in_build_args`  | build › args › PAYMENTS_SECRET_KEY › value | Build arguments are stored in image layers. Reference an env entry with `fromEnv`. |
| `unknown_field`                 | components › web › replica                 | Unknown field `replica`. Did you mean `replicas`?                                  |
| `web_component_needs_port`      | components › web › port                    | Web components must declare the port they listen on.                               |
| `reference_unresolved`          | env › DATABASE_URL › from                  | `deps.postgres.url` needs `dependencies.postgres`.                                 |
| `secret_reference_not_secret`   | env › DATABASE_URL › secret                | `DATABASE_URL` reads a secret output, so it must be `secret: true`.                |
| `upstream_pr_approval_required` | upstreamPullRequests › requireApproval     | Upstream pull requests always need a person's approval.                            |

## 25. Publication

| Artifact                                   | Location                                                                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Runtime validator (source of truth)        | `packages/agent/src/works-config/schema/app-spec.schema.ts` (plan §2.2)                                                     |
| Envelope JSON Schema with the `app` branch | `packages/agent/src/works-config/schema/works.v2.schema.json` (committed, drift-guarded)                                    |
| Stand-alone App spec JSON Schema           | `packages/agent/src/works-config/schema/app-spec.v1.schema.json` (committed, drift-guarded)                                 |
| Served                                     | `GET /api/schema/works.yml.schema.json`, `GET /api/schema/app-spec.schema.json`                                             |
| Vendored copy for Blueprint CI             | `ever-works/apps` → `schema/app-spec.schema.json` ([catalog.md §6](./catalog.md#6-ci-validation-in-the-catalog-repository)) |

JSON Schema cannot express §21–§22; editors validate structure, the platform validates everything.

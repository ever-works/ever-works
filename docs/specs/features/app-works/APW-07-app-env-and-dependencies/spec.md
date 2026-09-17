# Feature Specification: App env & dependencies

> Behaviour-first spec per [Constitution Principle IX](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> Describes **what** the system does for the user. Implementation lives in [`plan.md`](./plan.md).

**Feature ID**: `APW-07-app-env-and-dependencies`
**Program**: [App Works](../README.md) — Wave 1 (P1) · Wave 2 (P2)
**Branch**: `feat/apw-07-app-env-and-dependencies`
**Status**: `Draft`
**Created**: 2026-09-17
**Last updated**: 2026-09-17
**Owner**: Product
**Size**: L · **Depends on**: APW-03 (App spec `env` + `dependencies` schema and validation), APW-06 (deploy target,
cluster access, domains) · **Depended on by**: APW-05 (build-phase values), APW-06 (runtime values, dependency
outputs, deploy preconditions), APW-10 (managed data servers, P2)

> **Program audit resolutions applied** ([CONTRACTS §0](../CONTRACTS.md#0-program-audit-resolutions-binding-2026-09-17-against-develop-ee45946e5)):
> R-5 (managed dependencies only while APW-10's tier is open, asked through its tier policy), R-10 (ephemeral values for
> verification), R-11 (keypair formats), R-12 (deploy target **None**), R-15 (deleting an App Work keeps data unless
> confirmed), R-2 (Activity naming), R-22.

> **Additive-only (program rule #1).** The existing per-Work runtime env for generated directory sites — its
> allow-listed payment keys, the minted `AUTH_SECRET` / `COOKIE_SECRET`, the per-Work `DATABASE_URL` and the shared
> "Ever Works DB" provisioner — keeps working exactly as today, for exactly the Works it serves. App Works get a
> separate store. Nothing here reads, writes or migrates the existing one.

---

## 1. Overview

An open-source app needs configuration before it can run: secrets it expects someone to generate, addresses it
derives from its own domain, credentials only the owner can supply, and a database, cache, bucket or mail server to
talk to. The App spec already **declares** all of it. This epic makes the declaration real. **Settings ▸
Environment** lists every variable the app reads, with where its value comes from — **generated** once by the
platform with the exact shape the app needs (for example "exactly 32 characters"), **derived** from the app's domain
or a dependency, **prompted** from the owner, **set by you**, or a **default** written in the App spec — whether it
is needed at build time or run time, and whether it is set. Values go in and never come out: no screen, endpoint,
log or Activity entry ever shows one. Missing required values block a Build or Deploy with a message that names each
one. A pasted `.env` file is imported in one step. **Settings ▸ Dependencies** shows each database, cache, bucket and
mail server as a card: which provider serves it, its version, whether it is ready, and — stated plainly — whether
anything backs its data up. On **Your cluster**, the platform creates them in the app's namespace (using a Postgres
operator when the cluster has one), or accepts the owner's own external SMTP and object storage. On **Ever Works
Apps** (Wave 2), they live on dedicated tenant data servers in the isolated hosting zone, never on the platform's own
data servers. No data is ever deleted unless the owner types the App Work's slug to confirm.

## 2. Why now

### 2.1 The user's question

> _"This app wants 23 environment variables, a Postgres, a Redis and SMTP. Which ones do I actually have to fill in,
> which can you make for me — and where does my data live?"_

### 2.2 What they do today instead

| The need                                    | What Ever Works offers today                                                                                                      | What the user actually does                                           |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Set arbitrary env for a deployed app        | A fixed allow-list of 8 payment keys per Work; any other name is refused.                                                         | Cannot. Forks the deploy workflow and hard-codes values.              |
| Generate a secret with an exact shape       | Two platform-minted 32-byte base64 secrets for directory sites only.                                                              | Runs a random generator locally, pastes, sometimes with wrong length. |
| Know which values are missing before deploy | Nothing; a missing value surfaces as a crash after deploy.                                                                        | Reads pod logs.                                                       |
| Get a database for an app                   | One database per Work on a platform-managed server or the user's own server — Postgres only, and not designed for untrusted apps. | Installs a chart by hand; forgets backups.                            |
| Get a cache, bucket or mail server          | Nothing.                                                                                                                          | Signs up for three services and copies credentials around.            |
| Know whether data is backed up              | Nothing.                                                                                                                          | Finds out the day they need a restore.                                |

### 2.3 The gaps, all of them ours

1. **The allow-list is the wrong model for arbitrary apps.** It exists to stop users overriding platform-managed keys on
   platform templates; an App Work has no platform-managed keys except the reserved `EVER_WORKS_*` ones.
2. **Secret shape is a correctness problem, not a nicety.** An app whose cipher key must be exactly 32 characters
   boots happily with 44 and fails on the first encrypt; rotating that key silently makes stored data unreadable.
3. **Dependencies are provisioned nowhere, and backups are promised nowhere.** A single-replica database with no
   backup is fine if the owner knows; it is a disaster if they assume otherwise.

### 2.4 What this epic changes

```
 App spec env[] + dependencies ──► Environment table (name · origin · phase · required · set/unset)
        │ generate once · derive at deploy · prompt the owner · import .env         values never come out
        ▼
 Build (APW-05) ◄── build-phase values as masked secrets      Deploy (APW-06) ◄── runtime values as a Secret
                                                                   ▲
 Dependencies ── provision before first deploy ── outputs (encrypted) ┘   backup status on every card
   Your cluster: operator-backed or single-replica + volume · external SMTP / S3 · platform relay (if offered)
   Ever Works Apps (P2): tenant data servers in the isolated zone — never the platform's own
```

## 3. User scenarios

### 3.1 Primary

- **S1 — The Environment table after the App spec lands.** **Given** an App Work whose App spec declares 18 env
  entries (6 generated, 5 derived, 3 prompted of which 2 required, 4 defaults), **when** the owner opens **Settings ▸
  Environment**, **then** 18 rows show name, origin chip, phase, required and set/unset; the 6 generated rows read
  **Set** (generated within 60 seconds of the App spec being applied); the 2 required prompted rows read **Needed
  before deploy**; and the summary says **"2 values need you before this app can deploy."**
- **S2 — A value with an exact shape.** **Given** an entry generated as base64 of 24 bytes with validation "exactly 32
  characters", **when** it is generated, **then** it is 32 characters long, stored encrypted, marked **Generated ·
  never rotates**, and identical on every later Build and Deploy.
- **S3 — Set a prompted value.** **Given** `SMTP_PASSWORD` unset, **when** the owner clicks **Set**, pastes a value and
  saves, **then** the row reads **Set · by you · just now**, the dialog closes with the field cleared, no screen ever
  shows the value again, and Activity records **"Environment value SMTP_PASSWORD set"** with no value.
- **S4 — Deploy blocked by missing values.** **Given** two required values unset, **when** anyone presses **Deploy**,
  **then** the Deploy is refused with **"Deploy is blocked: 2 required values are missing — `SMTP_PASSWORD` (SMTP
  password), `LICENSE_KEY` (Your license key). Set them in Settings ▸ Environment."** with a **Set them** link.
- **S5 — Import a `.env` file.** **Given** a pasted file of 12 lines, **when** the owner imports it, **then** 9 declared
  names are set, 2 undeclared names are stored as **Set by you** with the warning **"The App spec doesn't declare
  `FOO`, `BAR`. They will still be passed to the app."**, 1 malformed line is refused as **"Line 7: not a valid
  NAME=value line"**, and the paste itself is never stored or logged.
- **S6 — Rotate a never-rotate value.** **Given** a generated value marked never rotates, **when** the owner clicks
  **Rotate**, **then** a dialog warns **"This app says this value must never change. Rotating it can make existing
  data unreadable — for example, credentials the app encrypted with it."** and rotation requires typing the variable
  name; the new value is used from the next Build and Deploy, and Activity records **"rotated"**.
- **S7 — A derived value follows the domain.** **Given** `NEXT_PUBLIC_WEBAPP_URL` derived from the primary domain,
  **when** a custom domain becomes primary, **then** the next Deploy resolves the new address; because the entry is
  build-phase, the row shows **"Changed since the last build — rebuild to apply"**.
- **S8 — Build values reach the Build.** **Given** 2 build-phase entries, **when** a Build starts, **then** exactly those
  2 values are handed to it as masked secrets and runtime-only values are not.
- **S9 — Postgres on a cluster without an operator.** **Given** **Your cluster** without a Postgres operator and an App
  spec declaring `postgres` 16, **when** the App spec is applied, **then** a card reads **"PostgreSQL 16 · In your
  cluster · Ready"** within 10 minutes, with the warning **"No automatic backups. If this volume is lost, the data is
  gone."**
- **S10 — Postgres on a cluster with an operator.** **Given** a cluster where the CloudNativePG operator is installed and
  usable in the app's namespace, **when** Postgres is provisioned, **then** the card reads **"PostgreSQL 16 · Managed by
  the CloudNativePG operator in your cluster"** and its backup line reports the operator's backup records: **"Backups:
  last completed 5 hours ago"**, **"Backups: not configured"** or **"Backups: last attempt failed"**.
- **S11 — External SMTP.** **Given** `smtp` declared, **when** the owner chooses **Your own SMTP server** and enters host,
  port, user, password and from address, **then** the connection is tested (connect, secure channel, sign-in — no email
  sent) within 30 seconds and the card reads **Ready** or names what failed.
- **S12 — Object storage.** **Given** `objectStorage` with buckets `uploads` and `avatars`, **when** the owner keeps **In
  your cluster**, **then** an S3-compatible server and both buckets are created; **when** they choose **Your own S3
  storage** instead, **then** they map each declared bucket to an existing bucket and every mapping is checked.
- **S13 — Managed tier (Wave 2).** **Given** an App Work on **Ever Works Apps**, **when** its dependencies are provisioned,
  **then** each card reads **"Ever Works Apps · Backups: last completed 3 hours ago"**, and the database accepts
  connections only from that App Work.
- **S14 — Deleting keeps data unless confirmed.** **Given** an App Work with a Postgres card, **when** the owner removes
  the app without ticking **Also delete stored data**, **then** the database and its volume remain and the card reads
  **"Kept — no longer managed"**; ticking it requires typing the App Work's slug exactly and lists every dependency
  that will be destroyed.
- **S28 — Deleting the App Work itself.** **Given** an App Work on Your cluster with Postgres and Redis, **when** the owner
  deletes the App Work with **Also delete stored data** unticked, **then** both dependencies and their volumes stay on the
  cluster, stopped and still closed to other pods; Activity records one **"PostgreSQL kept — no longer managed"** and one
  **"Redis kept — no longer managed"** entry listing the kept resources by name; and the dialog has warned that
  **"Generated values, like encryption keys, are deleted with the App Work. Data they protect may become unreadable."**
  With the box ticked and the slug typed, both dependencies' data is deleted before the App Work is.
- **S29 — Throwaway values for a verification.** **Given** the App Provisioner verifies a proposal, **when** values are
  needed for the verification, **then** generated values are made fresh for that run and never stored, dependencies are
  created without persistent storage, a prompted value is used only if the owner already set it, and the Environment
  table shows no change.
- **S30 — A key in the format the app expects.** **Given** an entry generated as a keypair with format `base64url-raw`
  (as web-push libraries expect), **when** it is generated, **then** the private key is the raw key in base64url, the
  public half is delivered as `<NAME>_PUBLIC` in the same format, and **Copy public key** copies exactly that text.

### 3.2 Unhappy paths

- **S15 — Wrong shape.** **Given** `validate.length: 32`, **when** a 44-character value is saved, **then** it is refused
  with **"`CALENDSO_ENCRYPTION_KEY` must be exactly 32 characters (this one has 44)."** and nothing is stored.
- **S16 — Pattern mismatch.** **Given** a pattern, **when** a value does not match, **then** it is refused with **"`NAME`
  doesn't match the format the app expects."** — the value is never echoed.
- **S17 — Importing over a generated value.** **Given** a paste containing a generated name, **then** that line is
  **skipped** with **"`NAME` is generated by Ever Works. Rotate it instead."** unless the owner ticks **Replace generated
  values** and confirms the never-rotate warning.
- **S18 — No storage for a volume.** **Given** a cluster with no default storage class, **when** Postgres is provisioned,
  **then** within 10 minutes the card reads **Failed — "Your cluster has no default storage class. Choose one in
  Dependency settings."**
- **S19 — The cluster is unreachable.** **Then** the card reads **"Couldn't reach your cluster"** with **Retry**, and
  nothing is marked failed until 3 attempts over 15 minutes have failed.
- **S20 — The platform relay is not offered.** **Given** the operator has not configured a mail relay, **then** the SMTP
  card offers only **Your own SMTP server**; the relay option is absent, not disabled.
- **S21 — Secure storage unavailable.** **Given** the platform's encryption key is not configured, **when** a value is
  saved, **then** it is refused with **"Secure storage isn't configured on this installation."** — never stored in
  plain text.
- **S22 — A dependency removed from the App spec.** **Then** its card reads **"No longer used by the App spec — data
  kept"** with **Delete data** (typed confirmation); nothing is deprovisioned automatically.
- **S23 — Someone else's App Work.** **Then** every route in this epic answers **not found**.

### 3.3 Race and permission edges

- **S24 — Two first deploys at once.** **Given** two Deploys of a new App Work within 1 second, **then** each generated
  entry gets exactly one value, used by both.
- **S25 — Two members set the same value.** **Then** the later save wins, both see **Set · by <later member>**, no error.
- **S26 — Rotation during a Deploy.** **Given** a running Deploy, **when** a value is rotated, **then** that Deploy keeps
  the value it started with; the next one uses the new value; the row shows **"Changed since the last deploy"**.
- **S27 — A viewer.** **Given** view-only access, **then** names, origins and states are visible; **Set**, **Rotate**,
  **Import**, **Configure**, **Retry** and **Delete data** are disabled with **"You need edit access to do this."**

---

## 4. Functional requirements

Every threshold below is a number on purpose.

### 4.1 The Environment table

- **FR-1.** The table lists every `env` entry of the App Work's effective App spec, plus every undeclared name the owner
  set, ordered by prompt group, then required-and-unset first, then name.
- **FR-2.** Each row shows: name, origin (**Generated**, **Derived**, **Prompted**, **Set by you**, **Default**), phase
  (**Build**, **Run**, **Build and run**), required, set/unset, description, last change time and actor, and whether the
  value changed since the last Build (build-phase) or last Deploy.
- **FR-3.** Declared entries keep their origin from the App spec. A stored value overriding a derived or default entry
  shows **Set by you (overrides derived)** / **(overrides default)** and can be **Reset** to follow the App spec again.
- **FR-4.** Per-deploy-target values are not supported in Wave 1: one set of values per App Work serves every target.

### 4.2 Secrecy

- **FR-5.** No stored or resolved value is returned by any endpoint, rendered on any screen, written to any log, placed
  in Activity or telemetry, or included in an error message. The only exceptions are text already public in the App
  spec file (a `value` literal, a `from`/`template` expression) and keypair public halves (FR-15).
- **FR-6.** There is no **Reveal** action. The set dialog's field is empty on every open and cleared after save.
- **FR-7.** Values are stored encrypted per App Work. When encryption is not configured, saving and generating are
  refused (S21); nothing is stored in plain text, including in development.
- **FR-8.** Activity records `app.env.changed` with the names changed and the action (set, unset, reset, imported), and
  `app.env.rotated` with the name — never a value, a length or a hash.

### 4.3 Generated values

- **FR-9.** A generated entry is produced once per App Work, within 60 seconds of the App spec that declares it being
  applied, and before any Build or Deploy that needs it. Concurrent requests produce exactly one value (S24).
- **FR-10.** Generators produce exactly: **base64** — standard base64 of `bytes` random bytes (16–128), length
  `4 × ceil(bytes / 3)`; **hex** — lower-case, `2 × bytes` characters; **chars** — `length` characters (16–256) drawn
  without bias from the chosen alphabet (**alnum** 62 characters; **alnum-symbols** alnum plus `!#%+,-.:=?@^_~`;
  **hex-lower**; **base64url**); **uuid** — a random version-4 UUID (36 characters); **keypair** — FR-14.
- **FR-11.** Randomness comes from the operating system's cryptographically secure source.
- **FR-12.** A generated value is never regenerated implicitly — not on redeploy, rebuild, App spec re-apply, upstream
  sync or restore. When the App spec's generator for an existing value changes, the row shows **"The App spec now asks
  for a different kind of value. Rotate to regenerate."** and the old value stays in use.
- **FR-13.** **Rotate** exists only for generated entries, requires edit access, and for `rotate: never` (the only value in
  App spec version 1) requires typing the variable name after the S6 warning. Rotation is limited to 10 per App Work per
  hour.

### 4.4 Keypairs and public halves

- **FR-14.** A keypair entry generates an `ed25519`, `ec-p256`, `rsa-2048` or `rsa-4096` key pair in the entry's format
  (default `pem`): **pem** — the private key (PKCS#8 PEM) is the entry's value and the public key is SPKI PEM;
  **base64url-raw** — the raw private key and the raw public key, each base64url without padding (`ed25519` and
  `ec-p256` only; an RSA type with this format is refused by the App spec); **pkcs12** — the value is the base64 of a
  PKCS#12 bundle holding the private key and a self-signed certificate, encrypted with the value of the generated password
  entry the App spec names for it (`passwordEnv`, stored as its own env entry like any generated value), and the public
  half is the certificate's SPKI PEM. In every format the public half is delivered only as the variable `<NAME>_PUBLIC`, in the
  same phase.
- **FR-15.** The public half is the one value the platform shows: the row offers **Copy public key** and the API returns it,
  up to 16 KB. The private half follows FR-5 like any other value. Rotating the pair rotates both halves together.
- **FR-16.** An App spec that also declares `<NAME>_PUBLIC` as an env entry is reported as a conflict and the keypair is
  not generated until it is resolved.

### 4.5 Validation

- **FR-17.** Every value is validated before it is stored: exact `length`, `minLength`, `maxLength`, and `pattern`, which
  must match the whole value. Patterns come from the repository and are untrusted: they run in linear time and never
  longer than 50 milliseconds per value.
- **FR-18.** Names match `^[A-Z_][A-Z0-9_]{0,127}$`; values are at most 65,536 bytes and contain no NUL character. Names
  starting with `EVER_WORKS_` are refused (reserved for the platform).
- **FR-19.** A value that fails validation is refused with a message naming the rule and, for length, the actual length —
  never the value (S15, S16).
- **FR-20.** A secret entry whose name starts with a browser-exposed prefix (`NEXT_PUBLIC_`, `VITE_`, `PUBLIC_`,
  `REACT_APP_`, `NUXT_PUBLIC_`, `EXPO_PUBLIC_`) shows the warning **"Values with this prefix are sent to every visitor's
  browser."**

### 4.6 Derived values and resolution

- **FR-21.** Derived and templated entries are resolved when a Build or Deploy starts, from the App Work's current primary
  domain, its dependency outputs, the platform mail relay, the Build's commit and component addresses, and other env
  entries. They are not stored.
- **FR-22.** During a Build, a dependency output resolves to the Build's ephemeral service of the same dependency (APW-05);
  a build-phase reference with no such service is reported as a missing build value. A Build never receives live
  dependency outputs.
- **FR-23.** A resolution failure names the entry and the reference that could not resolve (for example **"`DATABASE_URL`:
  the postgres dependency isn't ready yet"**) and blocks that Build or Deploy.
- **FR-24.** A build-phase entry whose resolved value differs from the one the last deployable Build used is flagged
  **Changed since the last build**; a runtime entry whose value differs from the current Deployment's is flagged **Changed
  since the last deploy**. Neither flag reveals a value.

### 4.7 Delivery and gating

- **FR-25.** Build-phase and build-and-run values are handed to Builds as masked secrets (APW-05). Run-phase values and
  dependency outputs referenced by env entries are handed to Deployments, which render them into a secret in the app's
  namespace (APW-06).
- **FR-26.** A Build is blocked while any required build-phase value is unset; a Deploy is blocked while any required
  value of any phase is unset or any referenced dependency is not **Ready**. The message lists every missing name with
  its description (S4).
- **FR-27.** Changes reach a running app only through the next Deployment; the table says so after every save.

### 4.8 Import from `.env`

- **FR-28.** Import accepts pasted text up to 64 KiB and 500 lines: `NAME=value`, optional `export ` prefix, `#` comments,
  blank lines, single-quoted values taken literally, double-quoted values with `\n`, `\t`, `\"`, `\\` escapes and line
  breaks inside quotes.
- **FR-29.** Each line reports exactly one outcome: **set**, **created (undeclared)**, **skipped** (generated, or identical
  name twice — last wins, earlier ones skipped), or **refused** (malformed, invalid name, reserved name, validation) with
  its line number.
- **FR-30.** Import is all-or-nothing for storage errors and line-by-line for content errors: every valid line is stored;
  no invalid line is. Values are encrypted as they arrive; the pasted text is never stored, logged or echoed.

### 4.9 Limits, scope and permissions

- **FR-31.** At most 300 stored values per App Work (declared plus undeclared) and 1 MiB of values in total.
- **FR-32.** Reading the table needs view access; set, unset, reset, import and rotate need edit access. Every route is
  scoped to the caller's account; another account's App Work is **not found**.
- **FR-33.** Saving is last-writer-wins per name and idempotent; the response lists what changed.
- **FR-34.** `PUT` is limited to 30 requests per minute per member.

### 4.10 Dependencies — declaration and providers

- **FR-35.** Each declared dependency (`postgres`, `redis`, `objectStorage`, `smtp`) has one card served by one provider
  chosen for the App Work's deploy target. **None** ("None — don't deploy yet") provisions nothing.
- **FR-36.** Default provider on **Your cluster**: Postgres → the cluster's CloudNativePG operator when its resources exist
  **and** the platform's access may create them in the app's namespace, otherwise a single-replica database with a
  persistent volume; Redis → a single-replica cache (with a volume only when persistence is declared); object storage → a
  single-replica S3-compatible server with a volume; SMTP → **Your own SMTP server**. The owner may switch object
  storage to **Your own S3 storage** and SMTP to **Ever Works mail relay** when the operator offers one.
- **FR-37.** Default sizes on Your cluster: Postgres volume 10 GiB, object storage volume 20 GiB, Redis volume 1 GiB;
  editable per App Work before first provisioning; growing later is allowed, shrinking is refused.
- **FR-38.** Every in-cluster dependency is reachable only from the App Work's own pods: the platform creates a network
  policy allowing only them, and exposes no dependency outside the cluster.
- **FR-39.** The mail relay option exists only when the operator has configured a relay that issues a separate credential
  per App Work. It is never the operator's own credential, sends only from an address on the App Work's domain or the
  relay's no-reply domain, and allows at most 200 messages per App Work per day by default. **Added 2026-09-17
  (XC-21):** it is offered only to an account with a verified email, an account and an organization daily ceiling apply
  on top of the per-App-Work limit (1 000 and 5 000 by default), a bounce or complaint rate above 5 % suspends further
  credential issuance for that account and raises a mail signal for an operator, an operator can stop issuance without
  stopping anything already issued, and relay messages are metered and appear in the daily receipt. Relay use never
  requires the app to reach a mail port: the app talks to the relay endpoint over HTTPS.
- **FR-61.** On **Ever Works Apps** every declared dependency has a provider, including **mail**: an app that declares
  `smtp` gets a per-App-Work credential for the platform's mail relay, so an app that requires SMTP reaches **Ready** on
  the managed tier. The tier's block on outbound mail ports (25, 465, 587) is **not** relaxed for it — the relay is
  reached over its own HTTPS endpoint, and the app is handed that endpoint, its credential and its from-address as
  ordinary dependency outputs. This applies to the same relay as FR-39, with the same per-App-Work daily limit.
- **FR-62.** A dependency whose provider needs something only the owner can supply starts in **Needs your settings** and
  is provisioned only after they save it; it never fails for a deadline the owner could not have met. When the App spec
  marks `smtp` **not** required and no mail provider is configured, the entries that would read from it are left unset
  with a warning instead of blocking a Build or Deploy; when it **is** required, they block, naming the missing entry.
- **FR-63.** A dependency's size can be chosen per App Work before it is first provisioned, increased later when its
  storage supports it, and never decreased — a smaller value is refused with **"A dependency's storage can't be shrunk.
  Delete its data first if you need a smaller one."**, and a storage class that cannot grow is refused with a message
  naming the class. Every size change is recorded in Activity by name and amount.
- **FR-40.** Dependency outputs are exactly those the App spec may reference: **postgres** `url`, `directUrl` (only when
  declared), `host`, `port`, `database`, `user`, `password`; **redis** `url`, `host`, `port`, `password`;
  **objectStorage** `endpoint`, `region`, `accessKeyId`, `secretAccessKey`, `bucket.<name>`; **smtp** `host`, `port`,
  `user`, `password`, `from`, `secure`. `url`, `directUrl`, `password`, `accessKeyId` and `secretAccessKey` are secret.

### 4.11 Dependencies — lifecycle

- **FR-41.** Dependencies are provisioned automatically after an App spec that declares them is applied on a target that
  needs them, and at the latest before the first Deployment. Readiness deadlines: Postgres and object storage 10 minutes,
  Redis 5 minutes, external connection tests 30 seconds.
- **FR-42.** All work against a user's cluster or external server runs in the background; the Dependencies page never
  waits on it. Opening the page refreshes a card whose status is older than 15 minutes.
- **FR-43.** A transient failure (cluster unreachable, timeout) is retried 3 times over 15 minutes before the card reads
  **Failed**; a definite failure (no storage class, authentication refused, bucket missing) fails at once with its reason.
- **FR-44.** Outputs are stored encrypted and change only when the provider reports new ones; each change is announced to
  Deployments so the app restarts with the new values on its next Deployment.
- **FR-45.** Removing a dependency from the App spec, removing the app from its cluster, changing the deploy target or
  deleting the App Work never deletes data. The card shows **Kept — no longer managed** (or **No longer used by the App
  spec — data kept**) and lists the kept resources by name.
- **FR-46.** Deleting a dependency's data requires edit access, the typed App Work slug, and a dialog listing every volume,
  database and bucket that will be destroyed. It runs in the background, records `app.dependency.data_deleted`, and cannot
  be undone.
- **FR-47.** Credentials of a dependency are never rotated implicitly. Rotating them is out of scope in Wave 1.

### 4.12 Backup status

- **FR-48.** Every card carries exactly one backup state: **No automatic backups** (single-replica in-cluster providers —
  shown as a warning), **Not configured**, **Last completed {time}**, **Overdue — last completed {time}** (older than 26
  hours), **Last attempt failed**, **Managed by your mail/storage provider** (external SMTP and S3), or **Couldn't check**.
- **FR-49.** With an operator, the state is read from the operator's individual backup records, never from a summary
  field that can report success while backups fail.
- **FR-50.** On Ever Works Apps (Wave 2), every database and bucket is backed up at least once every 24 hours and the card
  shows the last completed time.

### 4.13 Wave 2 — dependencies on Ever Works Apps

- **FR-51.** Postgres and object storage live on tenant data servers inside the isolated hosting zone that hold no
  platform or production data; Redis is a dedicated instance per App Work there (a shared cache cannot isolate one app's
  keys from another's); **mail is served by the platform relay of FR-61, never by a tenant-reachable mail port.**
- **FR-52.** Each App Work's database has its own owner role, is closed to every other role, accepts at most 20
  connections for that role, and applies a 60-second default statement timeout and a 60-second idle-in-transaction
  timeout the app may lower but not remove.
- **FR-53.** Each App Work's buckets are prefixed with its own identifier and readable only with its own credential;
  default quota 10 GiB storage.
- **FR-54.** Provisioning refuses any server that is one of the platform's own data servers.
- **FR-55.** Managed dependencies are offered only while the Ever Works Apps tier is open for this installation, as the
  tier itself reports it; no other switch is consulted.

### 4.14 Deleting an App Work

- **FR-56.** Deleting an App Work never deletes a dependency's data unless the owner ticked **Also delete stored data** and
  typed the App Work's slug. Without it, every dependency is released: in-cluster dependency workloads are stopped, their
  volumes, secrets and network isolation stay, and Activity records `app.dependency.released` per dependency with the kept
  resources by name. With it, every dependency's data is deleted (as FR-46) before the App Work is, and Activity records
  `app.dependency.data_deleted` per dependency.
- **FR-57.** The delete dialog warns that generated values — for example encryption keys — are deleted with the App Work
  and that data they protect in kept dependencies may become unreadable.
- **FR-58.** Deleting an App Work whose target is None, or whose dependencies were never provisioned, deletes no data and
  records no dependency event.

### 4.15 Values for a verification

- **FR-59.** A verification of an App Provisioner proposal gets its values without touching the Environment table: generated
  values are made fresh in memory for that verification only; derived values point at the verification's own throwaway
  dependencies; a prompted value is included only when the owner already set it, and a required prompted value that is not
  set is reported by name; no value is stored, logged or shown.
- **FR-60.** A verification's dependencies are created without persistent storage and without storing their outputs, and are
  destroyed with the verification.

---

## 5. Key entities

### 5.1 Already in Ever Works — extended here

| Entity                            | Today                                                                                | This epic adds                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| **App Work**                      | A Work of kind `app` with an App spec.                                               | An Environment table and Dependencies cards.                                                     |
| **Per-Work runtime env**          | Allow-listed payment keys and platform-minted secrets for directory sites.           | Nothing. It stays exactly as it is and is never used for App Works.                              |
| **Per-Work database provisioner** | One database + role per Work on a shared or user server, with idempotent statements. | Nothing changes in it; its idempotent pattern is reused, hardened, for tenant data servers (P2). |
| **Plugin settings**               | Per-scope settings with encrypted secret fields.                                     | Provider settings: storage class, default sizes, relay configuration (operator).                 |
| **Activity**                      | The account's event log.                                                             | `app.env.*` and `app.dependency.*` events, names only.                                           |

### 5.2 New

| Entity             | Why it must exist                                                                                                                                                                                                                | Shape                                                                                                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **App env value**  | The only existing per-Work env store is a single encrypted map guarded by a fixed allow-list, with no origin, no per-name history and no generation state. App Works need per-name origin, generation-once and version tracking. | One row per App Work × name: encrypted value, origin (generated, prompted, user, derived for keypair public halves), version, generator fingerprint, who and when.         |
| **App dependency** | A dependency's provider, lifecycle, encrypted outputs and backup state must outlive a Deployment and survive the app being removed from its cluster.                                                                             | One row per App Work × dependency kind: provider, status and reason, versions, encrypted prompted configuration and outputs, kept-resource names, backup policy and state. |

> **No other new noun.** A generator is an App spec field, a provider is a plugin, a backup state is an attribute.

### 5.3 States and transitions

```
 Env entry:   unset ──set/generate/import──► set ──set──► set (version + 1)
                ▲                              │ unset / reset (non-generated)
                └──────────────────────────────┘          generated: rotate (typed) ──► set (version + 1)

 Dependency:  awaiting_config ──owner saves settings──► pending ──► provisioning ──► ready ◄──► degraded (reason)
                                                          │  └──► failed (reason) ── Retry ──► provisioning
               ready ── removed from App spec / app removed / target changed ──► kept (no longer managed)
               kept or ready ── Delete data (typed slug) ──► deleting ──► deleted
               ready ── size increased (FR-63) ──► provisioning ──► ready (never smaller)
```

---

## 6. UX

All copy below is final English copy, ready to be keyed for translation.

### 6.1 Settings ▸ Environment

```
╔══════════════════════════════════════════════════════════════════════════════════════════╗
║  Environment                                                [ Import .env ] [ + Add ]     ║
║  2 values need you before this app can deploy.     Changes apply on the next deploy.      ║
╟──────────────────────────────────────────────────────────────────────────────────────────╢
║  NAME                        ORIGIN              PHASE          REQ   STATE                ║
║  SMTP_PASSWORD           🔒  Prompted            Run            ●     Needed before deploy [Set]║
║  LICENSE_KEY             🔒  Prompted            Build and run  ●     Needed before deploy [Set]║
║  CALENDSO_ENCRYPTION_KEY 🔒  Generated · never rotates  Build and run  Set · 2 days ago  [Rotate]║
║  VAPID_PRIVATE_KEY       🔒  Generated keypair   Run                  Set  [Copy public key] [Rotate]║
║  DATABASE_URL            🔒  Derived · deps.postgres.url   Run        Resolved at deploy   ║
║  NEXT_PUBLIC_WEBAPP_URL      Derived · domains.primary.url  Build     Changed since the last build║
║  CALCOM_TELEMETRY_DISABLED   Default from App spec  Run               "1"    [Override]   ║
║  FOO                     🔒  Set by you (not in App spec)  Run         Set · by Maya [Set][Remove]║
╚══════════════════════════════════════════════════════════════════════════════════════════╝
```

| Element               | Copy                                                                                                                                                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Origin chips          | `Generated` · `Generated · never rotates` · `Generated keypair` · `Derived` · `Prompted` · `Set by you` · `Set by you (overrides derived)` · `Set by you (overrides default)` · `Default from App spec` · `Set by you (not in App spec)` |
| Phase                 | `Build` · `Run` · `Build and run`                                                                                                                                                                                                        |
| State                 | `Set · {time}` · `Set · by {name}` · `Needed before deploy` · `Needed before build` · `Not set (optional)` · `Resolved at deploy` · `Changed since the last build` · `Changed since the last deploy`                                     |
| Summary               | `{count, plural, =0 {Everything this app needs is set.} =1 {1 value needs you before this app can deploy.} other {# values need you before this app can deploy.}}`                                                                       |
| No reveal (tooltip)   | `Values can't be shown again. Set a new one to replace it.`                                                                                                                                                                              |
| Generator changed     | `The App spec now asks for a different kind of value. Rotate to regenerate.`                                                                                                                                                             |
| Public prefix warning | `Values with this prefix are sent to every visitor's browser.`                                                                                                                                                                           |

### 6.2 Set, rotate and import dialogs

```
SET                                                    ROTATE (never-rotate)
╔══════════════════════════════════════════════╗       ╔══════════════════════════════════════════════════╗
║ Set SMTP_PASSWORD                       [×]  ║       ║ Rotate CALENDSO_ENCRYPTION_KEY?             [×]  ║
║ SMTP password                                ║       ║ This app says this value must never change.     ║
║ Value [ ••••••••••••••••••••        ] 👁 hold ║       ║ Rotating it can make existing data unreadable — ║
║ Must be 8–128 characters.                    ║       ║ for example, credentials the app encrypted with it.║
║ You won't be able to see it again.           ║       ║ Type CALENDSO_ENCRYPTION_KEY to confirm         ║
║                       [ Cancel ] [ Save ]    ║       ║ [                                  ]            ║
╚══════════════════════════════════════════════╝       ║ Used from the next build and deploy.            ║
                                                       ║                    [ Cancel ] [ Rotate ]        ║
IMPORT .env                                            ╚══════════════════════════════════════════════════╝
╔══════════════════════════════════════════════════════════════╗
║ Import from a .env file                                 [×]  ║
║ [ paste here …                                           ]   ║
║ ☐ Replace generated values (asks you to confirm)             ║
║                                     [ Cancel ] [ Import ]    ║
║ RESULT: 9 set · 2 added (not in App spec) · 1 refused        ║
║   Line 7: not a valid NAME=value line                        ║
║   FOO, BAR: The App spec doesn't declare them. They will     ║
║   still be passed to the app.                                ║
╚══════════════════════════════════════════════════════════════╝
```

The 👁 control shows the typed characters only while held, and only before saving.

### 6.3 Settings ▸ Dependencies

```
╔══════════════════════════════════════════════╗  ╔══════════════════════════════════════════════╗
║ PostgreSQL 16                     ● Ready    ║  ║ Object storage · 2 buckets        ● Ready    ║
║ In your cluster · single instance · 10 GiB   ║  ║ Your own S3 storage                          ║
║ ⚠ No automatic backups. If this volume is    ║  ║ uploads → acme-uploads · avatars → acme-av   ║
║   lost, the data is gone.                    ║  ║ Backups: managed by your storage provider    ║
║ Outputs: url 🔒 · host · port · database …   ║  ║                        [ Configure ] [ ⋯ ]   ║
║                       [ Configure ] [ ⋯ ]    ║  ╚══════════════════════════════════════════════╝
╚══════════════════════════════════════════════╝
╔══════════════════════════════════════════════╗  ╔══════════════════════════════════════════════╗
║ Redis 7                     ⟳ Provisioning   ║  ║ SMTP                      ✗ Failed           ║
║ In your cluster · no persistence             ║  ║ Your own SMTP server · smtp.example.com:587  ║
║ Started 2 minutes ago (up to 5 minutes)      ║  ║ Sign-in was refused by the server.           ║
╚══════════════════════════════════════════════╝  ║                        [ Configure ] [ Retry ]║
                                                  ╚══════════════════════════════════════════════╝
 ⋯ menu: Retry · Delete data…
```

| Element         | Copy                                                                                                                                                                                                                                                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider lines  | `In your cluster · single instance` · `Managed by the CloudNativePG operator in your cluster` · `Your own SMTP server` · `Your own S3 storage` · `Ever Works mail relay` · `Ever Works Apps`                                                                                                                    |
| Status          | `Needs your settings` · `Pending` · `Provisioning` · `Ready` · `Degraded` · `Failed` · `Kept — no longer managed` · `No longer used by the App spec — data kept` · `Deleting` · `Deleted`                                                                                                                       |
| Backup          | `No automatic backups. If this volume is lost, the data is gone.` · `Backups: not configured` · `Backups: last completed {time}` · `Backups: overdue — last completed {time}` · `Backups: last attempt failed` · `Backups: managed by your {kind} provider` · `Backups: couldn't check`                         |
| Failure reasons | `Your cluster has no default storage class. Choose one in Dependency settings.` · `Couldn't reach your cluster.` · `Sign-in was refused by the server.` · `Bucket {bucket} doesn't exist or can't be read.` · `The volume didn't become ready within {minutes} minutes.` · `Extensions not available: {names}.` |

### 6.4 Delete data dialog and blocked Deploy banner

```
╔══════════════════════════════════════════════════════════════════╗
║ Delete PostgreSQL data?                                     [×]  ║
║ This destroys, permanently:                                      ║
║   • database volume  data-cal-diy-postgres-0 (10 GiB)            ║
║   • secret           cal-diy-postgres                            ║
║ There is no undo. Type cal-diy to confirm.                       ║
║ [                    ]                  [ Cancel ] [ Delete data ]║
╚══════════════════════════════════════════════════════════════════╝

Deleting the App Work (APW-01's dialog, APW-06's Stored data section) shows the same per-dependency list and adds:
"Generated values, like encryption keys, are deleted with the App Work. Data they protect may become unreadable."

⊘ Deploy is blocked: 2 required values are missing — SMTP_PASSWORD (SMTP password), LICENSE_KEY (Your license key).
  [ Set them ]
```

### 6.5 Empty, loading, error and keyboard

- No env entries: **"This App spec declares no environment variables."** with **+ Add** still available.
- No dependencies: **"This app doesn't need a database, cache, storage or mail server."**
- Deploy target None: **"Dependencies are created when you choose where this app runs."**
- Loading: 6 skeleton rows / 2 skeleton cards; load error: **"Environment couldn't be loaded. Try refreshing the page."**
- Keyboard: `↑` `↓` move rows, `Enter` opens **Set**, `Esc` closes dialogs returning focus, `/` focuses the name filter.
  Status and origin are text plus icon, never colour alone.

---

## 7. Out of scope

- **Per-deploy-target or per-branch values** (one set per App Work in Wave 1) and **preview-deployment values** (APW-06 P3).
- **Reading values back** in any form, including export or download.
- **Rotating dependency credentials**, **migrating data between providers**, **point-in-time restore** and **high
  availability** for in-cluster dependencies.
- **Configuring an operator's backups** on the user's cluster — the card reports, it does not configure.
- **Dependencies beyond the four kinds** (search engines, queues, analytics stores).
- **Changing the existing per-Work runtime env** or its runbook.

---

## 8. Acceptance criteria

- [ ] **ACC-07-01** — Applying the fixture App spec creates exactly its generated values within 60 seconds; each has the
      declared length (base64 of 24 bytes → 32 characters; hex of 32 bytes → 64; chars 40 → 40; uuid → 36).
- [ ] **ACC-07-02** — 20 concurrent generation requests for one entry store one value; every consumer receives it.
- [ ] **ACC-07-03** — Redeploy, rebuild, App spec re-apply and upstream sync never change a generated value.
- [ ] **ACC-07-04** — Rotating a never-rotate value without the typed name is refused; with it, the version increases and
      Activity records `app.env.rotated` with the name only.
- [ ] **ACC-07-05** — No endpoint response, log line, Activity row or telemetry event produced by the suite contains any
      stored value (checked by scanning captured output for every value the suite set or generated).
- [ ] **ACC-07-06** — A keypair entry exposes its public half through the API and as `<NAME>_PUBLIC`; the private half is
      never returned.
- [ ] **ACC-07-07** — A 44-character value for `length: 32` is refused with the stated message; a pattern of catastrophic
      shape evaluates a 65,536-byte value in under 50 milliseconds.
- [ ] **ACC-07-08** — `EVER_WORKS_FOO` and `bad-name` are refused; a 65,537-byte value is refused.
- [ ] **ACC-07-09** — A Deploy with 2 unset required values is refused listing both names with descriptions; a Build with
      an unset required build-phase value is blocked naming it.
- [ ] **ACC-07-10** — Only build-phase values reach a Build; a build-phase `deps.postgres.url` resolves to the build service.
- [ ] **ACC-07-11** — Importing the 12-line fixture yields exactly 9 set, 2 created with the warning, 1 refused with its line
      number; a generated name is skipped unless replacement is confirmed; the paste is absent from logs.
- [ ] **ACC-07-12** — Encryption not configured → saving and generating are refused; the table has zero rows written.
- [ ] **ACC-07-13** — A derived build-phase entry flags **Changed since the last build** after the primary domain changes.
- [ ] **ACC-07-14** — On a cluster without the operator, Postgres 16 becomes Ready within 10 minutes with the no-backup
      warning, and a pod outside the app cannot connect to it.
- [ ] **ACC-07-15** — On a cluster with the operator usable in the namespace, Postgres is created through it and the backup
      line reflects the newest backup record (completed, failed, none).
- [ ] **ACC-07-16** — Redis ready within 5 minutes; object storage ready within 10 minutes with every declared bucket.
- [ ] **ACC-07-17** — External SMTP with a wrong password fails within 30 seconds with the sign-in message; no email is sent.
- [ ] **ACC-07-18** — External S3 with a missing bucket fails naming that bucket.
- [ ] **ACC-07-19** — The mail relay option is absent when the operator has not configured one.
- [ ] **ACC-07-20** — A cluster with no default storage class fails Postgres with the stated reason; an unreachable cluster
      is retried 3 times over 15 minutes before **Failed**.
- [ ] **ACC-07-21** — Removing the app from its cluster, removing the dependency from the App spec and changing the deploy
      target each leave the database volume in place.
- [ ] **ACC-07-22** — Delete data without the exact slug is refused; with it, the listed volume, secret and database are gone
      and `app.dependency.data_deleted` is recorded.
- [ ] **ACC-07-23** — Another account's App Work id answers not found on every route; a viewer sees every action disabled
      with the stated reason.
- [ ] **ACC-07-24** — The existing per-Work runtime env tests and payment-key flow pass unchanged.
- [ ] **ACC-07-25** — Every visible string resolves through translation; both pages and all dialogs pass an automated
      accessibility check with no new violations.
- [ ] **ACC-07-26** — _(Wave 2)_ A managed database refuses connections from another App Work's role, caps its role at 20
      connections, and a 70-second statement is cancelled at 60 seconds by default.
- [ ] **ACC-07-27** — _(Wave 2)_ Provisioning against a server configured as one of the platform's own is refused.
- [ ] **ACC-07-28** — _(Wave 2)_ Managed cards show a last completed backup within the past 24 hours.
- [ ] **ACC-07-29** — A keypair in each format produces the stated shapes: `pem` (PKCS#8 + SPKI PEM), `base64url-raw` for
      `ed25519` (32-byte keys, 43 characters each), `pkcs12` (a bundle that opens with the value of its password entry and with no other); in every
      format the public half is exposed only as `<NAME>_PUBLIC` and verifies a signature made with the private half.
- [ ] **ACC-07-30** — Deleting an App Work without **Also delete stored data** leaves every dependency's volume and secret
      in place, stops its workloads, and records one `app.dependency.released` per dependency and no
      `app.dependency.data_deleted`; with the box ticked and the slug typed, each dependency's data is deleted first and
      `app.dependency.data_deleted` is recorded per dependency.
- [ ] **ACC-07-31** — A verification's values are produced with zero writes to stored env values (a second verification
      gets different generated values), an unset required prompted value is reported by name, and its dependencies have no
      persistent volume claim and no stored outputs.
- [ ] **ACC-07-32** — An App Work on **Ever Works Apps** whose App spec declares `smtp` reaches **Ready** with a
      per-App-Work relay credential, and the tier's outbound ports 25, 465 and 587 remain refused; the app never needs a
      mail port (FR-61, GAP-22).
- [ ] **ACC-07-33** — A provider that needs owner-supplied settings starts **Needs your settings**, is not dispatched and
      does not fail on a deadline; saving the settings provisions it. With `smtp.required: false` and no mail provider
      configured, a Deploy proceeds with the SMTP-sourced entries unset and a warning; with `smtp.required: true` the
      Deploy names the missing entry (FR-62, S20).
- [ ] **ACC-07-34** — Increasing a dependency's size above its current size is refused with the stated message; a
      storage class that cannot expand is refused naming the class; a successful increase is recorded in Activity with
      the two amounts (FR-63).

---

## 9. Open questions

- **Resolved (CONTRACTS R-11): keypair formats.** `format: pem | base64url-raw | pkcs12` (default `pem`), public half
  only as `<NAME>_PUBLIC` (FR-14).
- **Resolved (APW-03 schema `generate.keypair.passwordEnv`, rule R26): PKCS#12 passphrase.** A `pkcs12` keypair names a
  separate generated secret entry as its password; that entry is stored and delivered like any other generated value, and
  no bundle is written with an empty passphrase.
- **[NEEDS CLARIFICATION: which S3-compatible server in the cluster.]** Community distribution of the most common
  self-hosted S3 server has changed. _Default: the provider's image is an operator-pinned setting; the platform ships a
  tested default and documents alternatives._
- **[NEEDS CLARIFICATION: browser-reachable storage.]** Apps that hand out upload links need an object storage address the
  browser can reach; in-cluster storage is internal only. _Default: Wave 1 in-cluster storage is internal; apps needing
  browser uploads use Your own S3 storage._
- **[NEEDS CLARIFICATION: kept data after an App Work is deleted (Wave 1).]** Released in-cluster dependencies stay on the
  owner's cluster with no card left to manage them. _Default: Activity lists them by name and the owner removes them by
  hand._
- **[NEEDS CLARIFICATION: kept managed data after an App Work is deleted (Wave 2).]** Keeping tenant data indefinitely
  costs money; deleting it on a timer contradicts "never delete without confirmation". _Default: kept until the owner
  deletes it; storage beyond 30 days after deletion is billed._
- **[NEEDS CLARIFICATION: exporting generated values.]** An owner leaving the platform may need the generated values that
  encrypt their data. There is no reveal today by design. _Default: none in Wave 1; the values remain in the app's secret
  on the owner's own cluster._
- **[NEEDS CLARIFICATION: statement timeout on the managed tier.]** 60 seconds can cut long migrations that do not override
  it per session. _Default: 60 seconds for the role; migration jobs (APW-06) set their own session timeout up to 15 minutes._

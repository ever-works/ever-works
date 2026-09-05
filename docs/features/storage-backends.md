---
id: storage-backends
title: Upload Storage Backends
sidebar_label: Storage Backends
description: Where uploaded bytes actually land — local disk, AWS S3, MinIO, or a GitHub repository with Git LFS — how an operator picks one with STORAGE_BACKEND, and why vector stores are a separate setting.
---

# Upload Storage Backends

Every file that enters Ever Works — a PDF dropped into a [Knowledge Base](./knowledge-base.md), a screenshot pasted into the prompt composer, a spreadsheet filed under [Memory](./memory.md), an [Agent's](./agents.md) avatar image — is written through **one storage backend**, chosen by whoever runs the installation.

Nothing else in the platform talks to a disk or a bucket directly. The API resolves a single storage plugin at boot and calls `putObject` / `getObject` / `deleteObject` on it, so moving from local disk to S3 is an environment-variable change, not a feature migration.

:::tip When to change this
`local-fs` is the right answer for a laptop, a demo, or a single API node. Move to **S3** or **MinIO** as soon as you run more than one API replica (each replica has its own disk) or need uploads to survive a container restart. Choose **GitHub storage** when you want uploads versioned in Git, next to everything else the platform already hands you.
:::

## What goes through the storage backend

| Producer                        | Where you meet it                                                                                      | Route                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| **Prompt composer attachments** | The **+** button on `/missions`, `/ideas`, `/agents`, `/new`, `/works/new` and the dashboard chat      | `POST /api/uploads/file`                                          |
| **Entity attachments**          | The **Attachments** section on a Task, Mission, Idea or Agent                                          | `POST /api/uploads/file`                                          |
| **Knowledge Base originals**    | The KB workbench at `/works/:id/kb` — the raw source file behind each document                         | KB upload pipeline                                                |
| **Memory files**                | `/memory` — files filed into a folder, then downloaded again from `GET /api/memory/files/:id/download` | `POST /api/memory/files/upload`                                   |
| **Skill files**                 | Files attached to a [Skill](./skills-catalog.md)                                                       | `POST /api/skills/:id/files`                                      |
| **Agent avatar images**         | Agent → **Avatar** → _Image_ — the image is stored as a KB upload row and referenced by its id         | KB upload pipeline                                                |
| **Pre-signup visitor uploads**  | Files attached to a prompt on the marketing site, before anyone has an account                         | `POST /api/uploads/anonymous`, `POST /api/uploads/anonymous/file` |
| **Images**                      | Any image-only upload path                                                                             | `POST /api/uploads`, `POST /api/uploads/image`                    |

Anonymous uploads mint an anonymous user inline and inherit that user's lifetime (`ANONYMOUS_USER_TTL_DAYS`, default 3 days). When the anonymous-user cleanup schedule reaps the user, the backend's `deleteAllByOwner` sweeps the objects under that owner prefix.

### Two upload spines, one backend

Uploads are booked into two different tables. The account-scoped spine records `user_uploads` rows — prompt-composer and entity attachments, Memory files, Skill files, every `POST /api/uploads*` route. The Work-scoped spine records `work_knowledge_uploads` rows — Knowledge Base originals, and the Agent avatar images that point at them by id.

The split matters for ownership and cleanup, not for configuration: **both spines resolve the same backend**, because the API binds the KB pipeline's storage plugin from the same boot-time factory `UploadsService` uses. One `STORAGE_BACKEND` value, one place every byte lands.

### What the backend never decides

Validation is identical on every backend, because it happens in the API layer before the plugin is called:

- **Magic-byte sniffing.** The declared `Content-Type` is not trusted — PNG, JPEG, GIF, WEBP, PDF, ZIP (including `.docx` / `.xlsx` / `.pptx`) and gzip are matched against their real signatures, and a mismatch is a `400`. Text-like MIMEs (markdown, CSV, JSON, code) have no signature, so they are checked for UTF-8 shape instead.
- **SVG is deliberately rejected** on the image path — it can carry inline `<script>`.
- **Content-addressed keys.** The storage key is `<sha256>.<ext>`; the client-supplied filename never reaches the filesystem or the bucket.
- **Owner-gated reads.** `GET /api/uploads/:userId/:filename` requires the requester to be the owner, and serves with `X-Content-Type-Options: nosniff` and a locked-down `Content-Security-Policy`.

| Route                                          | Default size cap         | Env var                  |
| ---------------------------------------------- | ------------------------ | ------------------------ |
| `POST /api/uploads`, `POST /api/uploads/image` | 5 MiB                    | `UPLOADS_MAX_BYTES`      |
| `POST /api/uploads/file`                       | 25 MiB (50 MiB hard cap) | `UPLOADS_FILE_MAX_BYTES` |

## The four backends

| `STORAGE_BACKEND` | Where the bytes land                                                               | Presigned upload | Packaging                  |
| ----------------- | ---------------------------------------------------------------------------------- | ---------------- | -------------------------- |
| `local-fs`        | `<UPLOADS_DIR>/<ownerId>/<sha256>.<ext>` on the API node's disk                    | no               | Bundled — always available |
| `aws-s3`          | `uploads/<ownerId>/<sha256>.<ext>` in an S3 bucket                                 | **yes**          | Loaded on demand           |
| `minio`           | Same layout against a custom S3-compatible endpoint, path-style URLs forced        | **yes**          | Loaded on demand           |
| `github-storage`  | `<pathPrefix>/<ownerId>/<sha256>.<ext>` committed to a GitHub repo, optionally LFS | no               | Loaded on demand           |

"Loaded on demand" means the API resolves the plugin package with a dynamic `import()` at boot, so a deployment that only ever uses `local-fs` never pays for the AWS SDK or Octokit. The flip side: the package has to be present in the image. If it is missing, the API refuses to start rather than silently falling back to local disk.

```mermaid
flowchart LR
    A[Prompt composer / KB / Memory / Skills] --> B[UploadsService<br/>MIME sniff · size cap · sha256 key]
    B --> C{STORAGE_BACKEND}
    C -->|local-fs| D[UPLOADS_DIR on disk]
    C -->|aws-s3| E[S3 bucket]
    C -->|minio| F[MinIO endpoint]
    C -->|github-storage| G[GitHub repo<br/>blob or LFS pointer]
    D --> H[GET /api/uploads/:userId/:filename<br/>owner-only]
    E --> H
    F --> H
    G --> H
```

## This is an operator setting, not a user setting

`STORAGE_BACKEND` is read from the API process environment. There is **no per-user, per-Work, or per-tenant storage picker** — one installation, one backend, and every upload in it goes to the same place. On the hosted platform the choice is made for you; on a self-hosted install it is yours.

Backend-specific credentials follow the same rule: they are environment variables on the API, not per-account settings. The plugin settings schemas do declare a settings UI (each field carries its `x-envVar`), but the code paths that actually write objects resolve their configuration from the environment on every call.

You will not normally find a **Storage** page under **Settings → Plugins**, either. `local-fs` ships as a hidden system plugin — enabled everywhere, nothing to configure — and `aws-s3`, `minio` and `github-storage` are registry plugins that no installation enables by default. The canonical block of variables to copy is in `.env.compose`, under the heading _Object storage / file uploads_.

Two consequences worth knowing before you switch:

- **Existing keys are not migrated.** Objects written under one backend stay where they are; the new backend starts empty and old URLs stop resolving. Move the bytes yourself if you need continuity.
- **The backend is probed at boot.** After loading the plugin, the API calls `isAvailable()` — local-fs ensures its data directory, S3 and MinIO issue a `HeadBucket`, GitHub validates the token and repo. A failure throws at startup with the reason, instead of surfacing as a confusing SDK error on someone's first upload.

## `local-fs` — the default

Writes to `<UPLOADS_DIR>/<ownerId>/<sha256>.<ext>`, creating the directory on demand. When `UPLOADS_DIR` is unset it falls back to `<tmpdir>/ever-works-uploads` — fine for a dev machine, **not** somewhere you want production uploads, because a container restart takes the temp directory with it.

| Variable            | Default                       | Notes                         |
| ------------------- | ----------------------------- | ----------------------------- |
| `UPLOADS_DIR`       | `<tmpdir>/ever-works-uploads` | Absolute path on the API node |
| `UPLOADS_MAX_BYTES` | `5242880` (5 MiB)             | Per-object cap for images     |

**How to use it**

1. Set `STORAGE_BACKEND=local-fs` (or leave it unset — this is the default).
2. Point `UPLOADS_DIR` at a path that outlives the process, and mount it as a volume if you run in Docker or Kubernetes.
3. Restart the API and upload a file from the prompt composer on `/works/new`; the file appears under `<UPLOADS_DIR>/<your user id>/`.

:::warning Multiple API replicas
`local-fs` writes to the disk of whichever replica handled the request. A second replica serving the read will 404. If you scale the API past one instance, use S3, MinIO, or GitHub storage.
:::

## `aws-s3` and `minio`

MinIO is the same plugin as S3 — it extends `AwsS3StoragePlugin` and only overrides where the endpoint points and how URLs are shaped (path-style is forced, because MinIO does not always accept virtual-hosted-style bucket names).

Both support **presigned PUT**, so the browser can upload straight to the bucket and skip the API process entirely. `POST /api/uploads/presign` returns `{ url, key, fields?, expiresAt, ownerId }` when the active backend supports it, and `501 PresignNotSupported` when it does not. `fields` only appears for POST-policy style presigning — S3 and MinIO sign a plain PUT, so it is undefined on both — and the route is public by design, so an anonymous caller (the marketing site presigning before the visitor has an account) also gets `anonAccessToken` and `anonymousExpiresAt` for the anonymous user minted inline. Presigned keys are random rather than content-addressed — the browser cannot know the sha256 of its own bytes before sending them.

Reads still route through the API's owner-gated serve endpoint. `putObject` never returns a presigned GET URL, because that would leak read access through the database.

:::warning Presigned uploads skip the API's validation
Bytes uploaded through a presigned PUT never pass through the API process, so the magic-byte sniff, the MIME allow-list and the size cap described above **do not run on them**. The request body is capped at 2 GiB by the presign DTO, and that is the only server-side limit. Use presigning for your own trusted clients; for untrusted visitors, keep them on the multipart `POST /api/uploads` route so the API can inspect the bytes.
:::

| Variable                         | Backend  | Notes                                                                     |
| -------------------------------- | -------- | ------------------------------------------------------------------------- |
| `AWS_S3_REGION`                  | `aws-s3` | Bucket region, e.g. `us-east-1`. Required.                                |
| `AWS_S3_BUCKET`                  | `aws-s3` | Bucket name. Required.                                                    |
| `AWS_ACCESS_KEY_ID`              | `aws-s3` | Omit to use the default AWS credential chain (IAM role, instance profile) |
| `AWS_SECRET_ACCESS_KEY`          | `aws-s3` | Omit to use the default AWS credential chain                              |
| `AWS_S3_PRESIGN_EXPIRES_SECONDS` | `aws-s3` | Presigned URL TTL. Default `600`, range 60–3600.                          |
| `MINIO_ENDPOINT`                 | `minio`  | Full URL, e.g. `https://minio.example.com:9000`. Required.                |
| `MINIO_BUCKET`                   | `minio`  | Bucket name. Required.                                                    |
| `MINIO_REGION`                   | `minio`  | Region label the SDK insists on. MinIO ignores it. Default `us-east-1`.   |
| `MINIO_ACCESS_KEY`               | `minio`  | Access key.                                                               |
| `MINIO_SECRET_KEY`               | `minio`  | Secret key.                                                               |
| `MINIO_PRESIGN_EXPIRES_SECONDS`  | `minio`  | Presigned URL TTL. Default `600`.                                         |

**How to switch to S3**

1. Create the bucket and keep it **private**. Reads are proxied by the API; the bucket never needs public access.
2. Grant the credentials `HeadBucket`, `PutObject`, `GetObject`, `DeleteObject`, `ListObjectsV2` and `DeleteObjects` on that bucket. `HeadBucket` is what the boot probe uses, and `ListObjectsV2` + `DeleteObjects` are what the anonymous-user cleanup sweep needs.
3. Set `STORAGE_BACKEND=aws-s3`, `AWS_S3_REGION` and `AWS_S3_BUCKET`. Leave the key pair unset if the API runs with an IAM role.
4. Restart the API. A wrong region, a missing bucket, or credentials without `HeadBucket` fails the boot probe with an explicit message.
5. Upload a file from `/works/new` and confirm the object appears under `uploads/<your user id>/` in the bucket.

For MinIO, the steps are identical with `STORAGE_BACKEND=minio`, `MINIO_ENDPOINT`, `MINIO_BUCKET`, `MINIO_ACCESS_KEY` and `MINIO_SECRET_KEY`.

## `github-storage` — uploads as Git objects

This backend commits every uploaded object into a GitHub repository, which fits the platform's Git-native posture: the bytes live where you can clone them, audit them, and take them with you.

### Two modes

| Mode                      | Where uploads land                                                                                 | Auth                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `separate-repo` (default) | One operator-owned repo holds every upload, under `<pathPrefix>/<ownerId>/`                        | `GITHUB_STORAGE_TOKEN` (a PAT with `contents:write`) |
| `data-repo`               | Each Work's **existing data repo**, resolved per upload from the Work's owner and storage settings | The OAuth token of the user who owns the Work        |

`data-repo` mode requires every upload to carry a `workId`. The dashboard threads it through as `?workId=` on the upload routes; **anonymous uploads are not supported in this mode** and the plugin raises a configuration error instead of guessing a destination. Keys minted in this mode encode the Work id, so a later read or delete can recover the repository coordinates without a second lookup.

Reads always go through the owner-gated `GET /api/uploads/:userId/:filename` route (with `?workId=` in `data-repo` mode). Earlier builds accepted a `GITHUB_STORAGE_PUBLIC_URL_BASE` for CDN passthrough; the plugin no longer reads it. If you serve a public storage repo from a CDN, build those URLs yourself from the storage key.

### Git LFS

With `lfsEnabled` on, the plugin uploads the blob to GitHub's LFS storage through the **LFS Batch API** and commits a three-line pointer file into the tree instead of the bytes:

```text
version https://git-lfs.github.com/spec/v1
oid sha256:<64-char lowercase hex digest>
size <bytes>
```

It also maintains a root `.gitattributes` entry tracking `<pathPrefix>/**` through LFS, added idempotently. Without LFS, a 50 MB PDF lives in the pack forever and every clone pays for it.

Defaults are deliberately conservative: `lfsEnabled` is **`true`** for fresh deployments, and **`false`** for a deployment that already had the legacy `GITHUB_STORAGE_OWNER` / `GITHUB_STORAGE_REPO` variables set without an explicit `GITHUB_STORAGE_MODE` — so existing installations keep their exact commit shape until they opt in.

LFS deletes are best-effort by design: removing the pointer takes the file out of the branch tree, but the underlying LFS object stays referenced by older commits, and GitHub's public API exposes no purge endpoint. This matches what `git rm` does to an LFS-tracked file — the pointer leaves the tree, the object stays reachable from history.

| Transport setting              | Values                                             | What it does                                                                                                                                                           |
| ------------------------------ | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_STORAGE_LFS_TRANSPORT` | `api` (default), `git-cli`                         | `api` calls the LFS Batch API over HTTPS — no binaries needed. `git-cli` shells out to `git` + `git-lfs`, which must both be on `PATH` or the plugin refuses to start. |
| `GITHUB_STORAGE_TRANSPORT`     | `auto` (default), `contents-api`, `clone-and-push` | How the pointer or raw blob is committed. `auto` picks `contents-api` for `separate-repo` and `clone-and-push` for `data-repo`.                                        |

| Variable                          | Default              | Notes                                                                                                    |
| --------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------- |
| `GITHUB_STORAGE_MODE`             | `separate-repo`      | `separate-repo` or `data-repo`.                                                                          |
| `GITHUB_STORAGE_TOKEN`            | —                    | PAT with `contents:write`. Required in `separate-repo` mode.                                             |
| `GITHUB_STORAGE_OWNER`            | —                    | User or org owning the storage repo. `separate-repo` mode.                                               |
| `GITHUB_STORAGE_REPO`             | —                    | Storage repository name. `separate-repo` mode.                                                           |
| `GITHUB_STORAGE_BRANCH`           | `main`               | Branch that receives the commits.                                                                        |
| `GITHUB_STORAGE_PATH_PREFIX`      | `uploads`            | Prefix on every object path. `..` components are rejected.                                               |
| `GITHUB_STORAGE_LFS_ENABLED`      | see above            | `true` / `false`.                                                                                        |
| `GITHUB_STORAGE_LFS_TRANSPORT`    | `api`                | `git-cli` needs `git` ≥ 2.40 and `git-lfs` ≥ 3.4 on `PATH`.                                              |
| `GITHUB_STORAGE_TRANSPORT`        | `auto`               | `contents-api` or `clone-and-push` to override.                                                          |
| `GITHUB_STORAGE_API_HOST`         | `https://github.com` | LFS Batch host for GitHub Enterprise Server. Must be `https://`.                                         |
| `GITHUB_STORAGE_DATA_REPO_BRANCH` | probed per repo      | `data-repo` mode only: pins the branch for every Work's data repo instead of probing its default branch. |

**How to switch to GitHub storage**

1. Create a **private** repository to hold uploads, or decide to reuse each Work's data repo.
2. Mint a token with `contents:write` on that repository. In `data-repo` mode you do not need one — the Work owner's connected GitHub OAuth token is used instead. See [Repositories](./repositories.md) for how Work repos and connections are set up.
3. Set `STORAGE_BACKEND=github-storage` plus `GITHUB_STORAGE_TOKEN`, `GITHUB_STORAGE_OWNER` and `GITHUB_STORAGE_REPO` (for `separate-repo`), or `GITHUB_STORAGE_MODE=data-repo`.
4. Decide on LFS. Leave `GITHUB_STORAGE_LFS_ENABLED` unset on a fresh install to get LFS on; set it to `false` if you want plain blobs in the tree.
5. Restart the API — the boot probe validates the token against the repository — then upload a file and confirm the commit under `uploads/<your user id>/` on the configured branch.

:::note Spec status
The dual-mode + Git LFS design is tracked in the internal spec `docs/specs/features/github-storage-lfs`, which is still marked **Draft**. The behaviour described on this page is what the shipped plugin code does today; the spec is the design record, not the source of truth for what runs.
:::

## Checking a backend from the command line

Every backend answers the same two routes, so one round trip tells you whether the switch took. Authenticate with an [API key](./api-keys.md) — `Authorization: Bearer` or the `x-api-key` header.

```bash
# 1 — upload (multipart field name is `file`)
curl -X POST http://localhost:3100/api/uploads/file \
  -H "Authorization: Bearer ew_live_your_key_here" \
  -F "file=@./brand-guide.pdf"
# → { "id": "<sha256>", "url": "/api/uploads/<userId>/<sha256>.pdf",
#     "filename": "<sha256>.pdf", "size": 402113,
#     "mimeType": "application/pdf", "hash": "<sha256>", "key": "<backend key>" }

# 2 — read it back through the owner-gated serve route
curl -H "Authorization: Bearer ew_live_your_key_here" \
  -o /tmp/roundtrip.pdf \
  http://localhost:3100/api/uploads/<userId>/<sha256>.pdf

# 3 — ask whether this backend can mint presigned PUTs (S3 / MinIO only)
curl -X POST http://localhost:3100/api/uploads/presign \
  -H "Content-Type: application/json" \
  -d '{"filename":"clip.mp4","mimeType":"video/mp4","size":10485760}'
# → { url, key, fields?, expiresAt, ownerId }  on S3 / MinIO
# → 501 PresignNotSupported                    on local-fs / github-storage
```

The `key` field in the upload response is the backend's own key — a bare `<ownerId>/<sha256>.<ext>` on `local-fs`, `uploads/<ownerId>/<sha256>.<ext>` on S3 and MinIO, `<pathPrefix>/<ownerId>/<sha256>.<ext>` (or a `workId`-encoded form in `data-repo` mode) on GitHub storage. Reading it tells you exactly which backend served the request.

## Vector stores are a different setting

A recurring confusion: **storage backends hold files; vector stores hold embeddings.** They are configured separately and one never implies the other. You can run `local-fs` uploads with a remote Qdrant cluster, or S3 uploads with embeddings in your own Postgres.

Vector stores are ordinary plugins, so they are configured in the dashboard rather than by a single env switch: **Settings → Plugins → Vector Stores** (`/settings/plugins/vector-store`). See the [Settings map](./settings-map.md) for how that section is built.

| Vector store | Default? | Where embeddings live                                                               | Key settings                                                                                        |
| ------------ | -------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `pgvector`   | yes      | The API's own Postgres, in `work_knowledge_chunks`, isolated per Work by row filter | Embedding model, dimensions, `ivfflat` vs `hnsw` index, tuning knobs                                |
| `qdrant`     | no       | A Qdrant cluster — managed or self-hosted — with one collection per Work            | `QDRANT_URL`, `QDRANT_API_KEY`, `QDRANT_COLLECTION_PREFIX`, `QDRANT_VECTOR_SIZE`, `QDRANT_DISTANCE` |

Which one a Knowledge Base query uses is decided by a selection chain: a caller-pinned provider, then the operator pin `KB_VECTOR_STORE_PROVIDER_ID`, then the vector-store plugin enabled for that Work, then the registry default (`pgvector`). If none resolves, the facade raises a "vector store not configured" error rather than silently degrading.

:::warning Changing embedding settings is not free
The embedding model and vector dimensions must match the vectors already stored. Changing either leaves you retrieving from a mixed vector space with badly degraded recall — plan a full re-embed sweep (and, for pgvector, a column-altering migration) alongside the change.
:::

## Troubleshooting

| Symptom                                                                           | What it means                                                                                                                                                |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API refuses to boot: `STORAGE_BACKEND="…" is not a supported backend`             | Typo. Valid values are `local-fs`, `aws-s3`, `minio`, `github-storage` (case-insensitive).                                                                   |
| Boot error: `… loaded but isAvailable() returned false`                           | Credentials or coordinates are wrong. For S3/MinIO the bucket must exist and the credentials must allow `HeadBucket`; for GitHub the token needs repo write. |
| Boot error: `STORAGE_BACKEND=aws-s3 but @ever-works/aws-s3-plugin failed to load` | The optional plugin package is not present in the deployment image.                                                                                          |
| `501 PresignNotSupported` from `POST /api/uploads/presign`                        | The active backend has no presigned upload (local-fs, github-storage). Use the multipart `POST /api/uploads` instead.                                        |
| `github-storage mode 'data-repo' requires StoragePutInput.workId`                 | Something tried an anonymous or Work-less upload while in `data-repo` mode. Use `separate-repo` if you need anonymous uploads.                               |
| Uploads succeed but reads 404 intermittently                                      | Classic multi-replica `local-fs` symptom — one replica wrote, another served. Move to a shared backend.                                                      |
| `400` on an upload that "looks fine"                                              | Magic-byte mismatch, an unsupported MIME, or non-UTF-8 bytes on a text-declared file. The declared type must match the real bytes.                           |

## Related

- [Knowledge Base & Memory](./knowledge-base.md) — what the KB stores, and where the originals go
- [Memory (Org-Wide)](./memory.md) — the `/memory` files surface that uses the same pipeline
- [Data Management (Export / Import / GitHub Sync)](./data-management.md) — moving configuration between installations
- [Plugins](./plugins.md) · [Settings Map](./settings-map.md) — where plugin categories live in the dashboard
- [Repositories](./repositories.md) — Work data repos, the destination for `data-repo` mode
- [Kubernetes Deployment](./k8s-deployment.md) — the multi-replica case that rules out `local-fs`
- [Environment Variables Reference](../environment-variables.md) · [Installation](../installation.md)

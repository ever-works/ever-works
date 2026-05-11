# Onboarding Wizard v2 — Deployment & operator runbook

> **Status**: env keys + provider services are in code. Both feature flags
> default to `false` and the catalog renders the cards as **Planned** until
> the steps below are completed.
>
> **Owner**: `ever@ever.co`. Files touched: this runbook + the cluster
> secrets + GitHub PAT vault entry.

This runbook covers the ops work needed to flip the **Ever Works Git**
(storage) and **Ever Works Deploy** (k8s) defaults from Planned to live.

---

## 1. Ever Works Git — `STORAGE_EVER_WORKS_GIT_ENABLED`

Pushes new user-Work repos to the platform-owned GitHub org so the user
doesn't need their own GitHub.

### 1.1 Org status

The org **already exists** as
[`ever-works-cloud`](https://github.com/ever-works-cloud).

- Created `2026-05-11`
- Plan: Free (10000 private repos quota)
- Billing email: `ever@ever.co`
- Currently empty (0 repos)
- Members can create both public and private repos
- Owner: `evereq`

### 1.2 PAT — why this step is manual

GitHub does **not** allow Personal Access Tokens to be created via the
REST API, the `gh` CLI, or any other automated path — even for the org
owner. Both classic PATs (`github.com/settings/tokens`) and fine-grained
PATs (`github.com/settings/personal-access-tokens`) require the user to
interact with the web UI to confirm scopes and expiry. This is a
deliberate GitHub security control and is the same reason CI-only PATs
in the rest of the platform are also rotated by hand.

> **Long-term move:** swap the PAT for an installation token issued by
> the existing GitHub App (the one the platform already uses for user
> repos via `apps/api/src/integrations/github-app/`). Install the App on
> `ever-works-cloud` and have `EverWorksGitProvider` ask the App for a
> short-lived installation token instead of reading a PAT. This is a
> follow-up — out of scope for EW-608.

### 1.3 Create the PAT (2 minutes, web UI)

While signed in as **`evereq`** (the org owner):

1. Open <https://github.com/settings/personal-access-tokens/new>.
2. **Token name**: `ever-works-cloud — platform storage provider (prod)`.
3. **Expiration**: 1 year (set a calendar reminder on `2027-05-11`).
4. **Resource owner**: `ever-works-cloud` (the org, NOT your personal
   account).
5. **Repository access**: **All repositories** under `ever-works-cloud`.
6. **Permissions** (these map to fine-grained scopes; choose **Read &
   write** for each unless noted):
    - **Repository → Administration** — for repo creation/deletion.
    - **Repository → Contents** — for pushing generated Work content.
    - **Repository → Workflows** — only if the manifests reference one.
    - **Repository → Metadata** — auto-included by GitHub.
7. **Generate token** and copy the resulting `github_pat_*` string.

The token is org-scoped: it can only operate on `ever-works-cloud`
repositories. That's the property we want — the same secret will never
accidentally touch the `ever-works` source org.

### 1.4 Store the PAT

Three deployment surfaces need the value:

| Surface                                                                  | Where                                                                    | Key                               |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------ | --------------------------------- |
| DigitalOcean k8s `default` namespace, `do-sfo2-k8s-gauzy`                | Secret `ever-works-secrets` (used by the `ever-works-api-*` deployments) | `EVER_WORKS_CUSTOMERS_GITHUB_PAT` |
| GitHub Actions repo secrets (for CI deploys that template the manifests) | `https://github.com/ever-works/ever-works/settings/secrets/actions`      | `EVER_WORKS_CUSTOMERS_GITHUB_PAT` |
| Local `.env` for ad-hoc dev                                              | `C:/Coding/Workspace/.config/ever-works.env` (gitignored)                | same                              |

```powershell
# DO k8s secret update (Windows shell)
$env:KUBECONFIG = "C:\Coding\Workspace\.config\k8s-gauzy-kubeconfig.yaml"
kubectl --context do-sfo2-k8s-gauzy -n default `
  patch secret ever-works-secrets `
  -p "{\"stringData\":{\"EVER_WORKS_CUSTOMERS_GITHUB_PAT\":\"github_pat_xxx\"}}"
```

```bash
# GitHub Actions repo secret
gh secret set EVER_WORKS_CUSTOMERS_GITHUB_PAT \
  -R ever-works/ever-works \
  -b 'github_pat_xxx'
```

### 1.5 Flip the flags

Also set in the same secret / GH Actions secrets / `.env`:

```env
STORAGE_EVER_WORKS_GIT_ENABLED=true
EVER_WORKS_CUSTOMERS_GITHUB_ORG=ever-works-cloud
EVER_WORKS_CUSTOMERS_GITHUB_VISIBILITY=private
```

Then `kubectl rollout restart deploy/ever-works-api -n default` (and
`-stage` / `-dev` per env). The catalog endpoint flips the **Ever Works
Git** card from Planned to live within seconds — the wizard refreshes on
next dashboard load.

---

## 2. Ever Works Deploy — `DEPLOY_EVER_WORKS_ENABLED`

Deploys generated Works to a platform-owned k8s cluster so the user
doesn't need their own Vercel or Kubernetes credentials. Capped at
**3 active Works per user**.

### 2.1 Cluster choice

We already operate two managed DO clusters in `sfo2`
(see [`EVER_WORKS_K8S.md`](../../../../../Workspace/knowledge/infrastructure/EVER_WORKS_K8S.md)
in the operator workspace):

| Cluster             | Purpose today                                                                     | Suitability for Ever Works Deploy                                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `do-sfo2-k8s-gauzy` | The Ever Works platform itself (web / api / mcp) + Gauzy + Teams + Rec + CLOC + … | OK but already busy. Mixing user-workloads with platform workloads is risky.                                                                                 |
| `do-sfo2-k8s-ever`  | CMS / marketing sites (`website-cms.*.ever.works`, etc.)                          | **Recommended.** Already serves `*.ever.works` subdomains, same naming pattern user Works will produce. Light load, fits the directory-web-template profile. |

**Decision**: use `do-sfo2-k8s-ever` as the tenant cluster for Ever
Works Deploy. Works will land alongside the marketing-site CMSs they
sit closest to functionally.

### 2.2 Per-user namespace

The provider creates one namespace per user (`ever-works-tenants-{userId}`)
the first time that user picks Ever Works Deploy. The cluster
administrator does not have to pre-create them — `EverWorksK8sDeployProvider.ensureNamespace()`
handles it.

### 2.3 Kubeconfig

The current kubeconfig for `do-sfo2-k8s-ever` lives at
`C:\Coding\Workspace\.config\k8s-ever-kubeconfig.yaml` (gitignored,
per-host). For production we need the same kubeconfig stored as a k8s
Secret in `do-sfo2-k8s-gauzy` (the cluster where the API runs).

```powershell
# 1. Read the YAML into a variable
$kc = Get-Content "C:\Coding\Workspace\.config\k8s-ever-kubeconfig.yaml" -Raw

# 2. Push into the API's deployment secret
$env:KUBECONFIG = "C:\Coding\Workspace\.config\k8s-gauzy-kubeconfig.yaml"
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($kc))
kubectl --context do-sfo2-k8s-gauzy -n default patch secret ever-works-secrets `
  -p "{`"data`":{`"EVER_WORKS_DEPLOY_KUBECONFIG`":`"$b64`"}}"
```

The platform reads `EVER_WORKS_DEPLOY_KUBECONFIG` as the **full inline
YAML**, base64-decoded out of the k8s Secret automatically by the
TypeORM-driven config reader.

For the `*_PATH` variant (used in dev/local), mount a file at
`/var/secrets/ever-works-deploy-kubeconfig` and set
`EVER_WORKS_DEPLOY_KUBECONFIG_PATH` instead. Inline value wins when both
are set.

### 2.4 Env values to set

```env
DEPLOY_EVER_WORKS_ENABLED=true
EVER_WORKS_DEPLOY_KUBECONFIG=<inline yaml — set via kubectl patch above>
EVER_WORKS_DEPLOY_NAMESPACE=ever-works-tenants
EVER_WORKS_DEPLOY_INGRESS_HOST_TEMPLATE={slug}.ever.works
EVER_WORKS_DEPLOY_INGRESS_CLASS=nginx
EVER_WORKS_DEPLOY_TLS_ISSUER=letsencrypt-prod
EVER_WORKS_DEPLOY_REGISTRY=registry.digitalocean.com/ever
EVER_WORKS_DEPLOY_MAX_WORKS_PER_USER=3
```

`{slug}` in the ingress host template is substituted to the Work's slug
at provision time, so a user with `slug = my-tools` gets
`my-tools.ever.works`. The cluster's ingress already terminates
`*.ever.works`; no per-deploy DNS work required if the Work uses an
ever.works subdomain (custom domains follow the existing
`WorkCustomDomain` flow).

### 2.5 Wildcard DNS + TLS

`*.ever.works` already resolves to `157.230.74.104` (the
`do-sfo2-k8s-ever` ingress LB) per Cloudflare DNS. `letsencrypt-prod`
issues per-host certs automatically through `cert-manager` already
installed on the cluster.

### 2.6 Quota guarantees

`works.deployProvider = 'ever-works'` plus the partial index
`idx_works_user_deploy_active` (added in EW-608) keep the
`countActiveByDeployProvider` query cheap. The DB-level cap (3 per
user) is enforced at the application layer in
`WorkLifecycleService.createWork` before any side-effect kicks in;
hitting the cap returns a typed `EverWorksDeployQuotaExceededError`
that the API surfaces as `429 quota_exceeded`.

---

## 3. Roll-forward checklist

After flipping both flags:

- [ ] `GET /api/onboarding/catalog` returns `ai/storage/deploy[i].available = true`
      for `ever-works-git` and `ever-works`.
- [ ] Wizard side-bar shows **Ever Works Git** and **Ever Works** as the
      default selected cards (no "Coming soon" badge).
- [ ] Create a Work as a test user with the defaults — verify a repo
      appears in `https://github.com/ever-works-cloud/<user-slug>-<work-slug>`.
- [ ] Verify the Work deploys to `<work-slug>.ever.works` and the cert
      provisions inside 2 minutes.
- [ ] Create 3 more Works as the same user — fourth attempt with
      `ever-works` deploy returns 429 `quota_exceeded`. Switching to Vercel
      for the fourth succeeds.

## 4. Roll-back

Flip both flags back to `false` and `kubectl rollout restart` the API
pods. The catalog re-renders the cards as Planned within seconds.
Existing user Works keep functioning — their `storageProvider` /
`deployProvider` column values remain unchanged, and the providers
themselves don't read the flags at runtime (only the catalog endpoint
does, so the UI gates new selections while the backend keeps serving
the old ones).

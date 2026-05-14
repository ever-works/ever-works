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

**The deploy pipeline does NOT use a k8s `Secret` resource.** The
`ever-works-api` deployment on `do-sfo2-k8s-gauzy` has its env values
inlined directly into the Deployment spec, which is rendered at
release time by `envsubst < .deploy/k8s/k8s-manifest.<env>.yaml` inside
the `Deploy to DO <env>` GitHub Actions workflow. The substitution
source is **GitHub Actions repo secrets** plus inlined non-secret
values in the workflow `env:` block.

Two surfaces need the PAT value:

| Surface                         | Where                                                                                                                                                 | Key                               |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| **GitHub Actions repo secrets** | `https://github.com/ever-works/ever-works/settings/secrets/actions` (consumed by all three `deploy-do-{dev,stage,prod}.yml` workflows via `envsubst`) | `EVER_WORKS_CUSTOMERS_GITHUB_PAT` |
| **Local `.env` for ad-hoc dev** | `C:/Coding/Workspace/.config/ever-works.env` (gitignored, loaded manually before `pnpm dev:api`)                                                      | same                              |

```bash
# GitHub Actions repo secret (only step that ships the PAT to prod/stage/dev pods)
gh secret set EVER_WORKS_CUSTOMERS_GITHUB_PAT \
  -R ever-works/ever-works \
  -b 'github_pat_xxx'
```

The non-secret companions (`STORAGE_EVER_WORKS_GIT_ENABLED`,
`EVER_WORKS_CUSTOMERS_GITHUB_ORG`, `EVER_WORKS_CUSTOMERS_GITHUB_VISIBILITY`)
are checked in as plain values in each `deploy-do-<env>.yml` workflow's
`env:` block — they're config, not secrets, so no need to roundtrip
them through `secrets.*`.

### 1.5 Roll out the change

The wiring lives in the repo. Each `deploy-do-<env>.yml` workflow already
contains:

```yaml
env:
    STORAGE_EVER_WORKS_GIT_ENABLED: 'true'
    EVER_WORKS_CUSTOMERS_GITHUB_ORG: ever-works-cloud
    EVER_WORKS_CUSTOMERS_GITHUB_PAT: ${{ secrets.EVER_WORKS_CUSTOMERS_GITHUB_PAT }}
    EVER_WORKS_CUSTOMERS_GITHUB_VISIBILITY: private
```

and each `.deploy/k8s/k8s-manifest.<env>.yaml` references those via
`$VAR` placeholders that `envsubst` fills.

To roll out: merge to the target branch. The post-build `Deploy to DO <env>`
workflow runs, `envsubst`s the new env values into the Deployment spec,
applies the manifest, and the trailing `kubectl rollout restart deployment/ever-works-api`
picks up the new env. The catalog endpoint flips the **Ever Works Git**
card from Planned → live within seconds — the wizard refreshes on next
dashboard load.

To verify after the deploy workflow finishes:

```bash
KUBECONFIG=C:/Coding/Workspace/.config/k8s-gauzy-kubeconfig.yaml \
  kubectl --context do-sfo2-k8s-gauzy -n default \
  get deploy ever-works-api \
  -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="STORAGE_EVER_WORKS_GIT_ENABLED")].value}'
# should print: true
```

To roll back without a code revert: clear the GH Actions secret or set
the workflow's `STORAGE_EVER_WORKS_GIT_ENABLED` to `'false'` and rerun
the deploy workflow.

---

## 2. Ever Works Deploy — `DEPLOY_EVER_WORKS_ENABLED`

Deploys generated Works to a platform-owned k8s cluster so the user
doesn't need their own Vercel or Kubernetes credentials. Capped at
**3 active Works per user**.

### 2.1 Cluster choice

**Decision (owner, 2026-05-12):** a dedicated **`k8s-works`** cluster is
the target. It is **not yet provisioned** as of this commit — the owner
will stand up the cluster and configure SSL termination / ingress
separately. Until that lands, `DEPLOY_EVER_WORKS_ENABLED` stays `false`
and the wizard renders the **Ever Works** deploy card as Planned.

For context on the existing clusters we run today (which are explicitly
**not** the target — the application cluster is busy and the CMS cluster
hosts unrelated marketing sites), see
[`EVER_WORKS_K8S.md`](../../../../../Workspace/knowledge/infrastructure/EVER_WORKS_K8S.md)
in the operator workspace. Both `do-sfo2-k8s-gauzy` and
`do-sfo2-k8s-ever` were considered but ruled out so user Works workloads
get their own isolation boundary.

When `k8s-works` is up:

1. Generate a kubeconfig with `kubectl-readonly`-equivalent permissions
   scoped to the tenant namespace prefix (so a leaked PAT can't escape
   into other clusters).
2. Install `cert-manager` + the chosen ingress controller. Use a
   wildcard cert for `*.ever.works` issued via `letsencrypt-prod` (the
   DNS-01 challenge keeps things simple; the existing Cloudflare zone
   for `ever.works` makes this a few clicks).
3. Add a `ClusterIssuer` named `letsencrypt-prod` so the env value below
   resolves at deploy time.
4. Follow §2.3 to push the kubeconfig into the API's `ever-works-secrets`.

### 2.2 Per-user namespace

The provider creates one namespace per user (`ever-works-tenants-{userId}`)
the first time that user picks Ever Works Deploy. The cluster
administrator does not have to pre-create them — `EverWorksK8sDeployProvider.ensureNamespace()`
handles it.

### 2.3 Kubeconfig

Once `k8s-works` is up, drop its kubeconfig at
`C:\Coding\Workspace\.config\k8s-works-kubeconfig.yaml` (gitignored,
per-host, mirroring the convention used for the other two clusters).
Production reads it from the `ever-works-secrets` Secret in
`do-sfo2-k8s-gauzy` (the cluster the API runs on).

```powershell
# 1. Read the YAML into a variable
$kc = Get-Content "C:\Coding\Workspace\.config\k8s-works-kubeconfig.yaml" -Raw

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
`my-tools.ever.works`. Custom domains follow the existing
`WorkCustomDomain` flow.

### 2.5 Wildcard DNS + TLS

When `k8s-works` is provisioned, point `*.ever.works` (or a sub-zone
like `*.works.ever.works`) at its ingress LB in Cloudflare. The owner
will install **cert-manager** and configure SSL termination on the
cluster as a separate step — until then, the `Ever Works` deploy card
stays Planned in the wizard and the `letsencrypt-prod` `ClusterIssuer`
referenced by `EVER_WORKS_DEPLOY_TLS_ISSUER` will not yet exist. Once
SSL is in place, flipping `DEPLOY_EVER_WORKS_ENABLED=true` is all that's
needed to surface the card.

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

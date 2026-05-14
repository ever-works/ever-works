# EW-617 G5 — Subdomain ingress + Cloudflare DNS automation

> Sub-task: **EW-622**. Parent epic: **EW-617**. Pairs with platform PRs
> #752 (G6 default deploy provider), #758 (G4 quick-create).

## Goal

When a Work deploys via the Ever Works pipeline (`deployProvider ===
'ever-works'`), the platform MUST automatically:

1. Template the Kubernetes ingress host as `${work.slug}.ever.works`
   (so the work is reachable at a stable subdomain).
2. Provision a Cloudflare CNAME pointing that hostname at the
   `k8s-works` cluster ingress load balancer.
3. Tear the CNAME down when the Work is deleted.

Net effect: a fresh Work with `slug=foo` is reachable at
`https://foo.ever.works/` within ~2 min of deploy with a wildcard TLS
cert.

## Functional requirements

- **FR-G5-1** A new `CloudflareDnsProvider` class wraps the Cloudflare
  v4 REST API. Methods:
    - `ensureWorkSubdomain(slug)` — idempotent upsert of a CNAME
      `<slug>.<rootDomain> → <targetHostname>`.
    - `removeWorkSubdomain(slug)` — best-effort delete; no-op when the
      record doesn't exist.
- **FR-G5-2** Slugs that fail `^[a-z0-9]+(?:-[a-z0-9]+)*$` MUST be
  rejected before any HTTP call (same regex as `CreateWorkDto.slug`).
- **FR-G5-3** A `EverWorksDnsService` (Nest-injectable) reads env on
  first use and caches the result. It returns `null` from
  `getProvider()` when DNS automation is not configured so all
  consumers can no-op cleanly in dev/preview.
- **FR-G5-4** `DeployService.deploy()` MUST, when
  `work.deployProvider === 'ever-works'` AND `dnsService.getProvider()`
  is non-null:
    1. Merge `ingressHost = ${slug}.${EVER_WORKS_DOMAIN || 'ever.works'}`
       into the deploy settings before
       `plugin.getDeploymentSecrets(settings)` runs (so the k8s plugin
       picks it up as `K8S_INGRESS_HOST`).
    2. Fire `dnsService.ensureWorkSubdomain(slug)` asynchronously —
       errors are logged inside the service so they NEVER abort a
       deploy.
    3. Leave settings untouched for non-platform providers (Vercel,
       user's k8s) AND when DNS env is unset.
- **FR-G5-5** Authentication MUST be a Bearer token in the
  `Authorization` header. The token MUST be scoped (Cloudflare API
  token, DNS:Edit on the `ever.works` zone only — NOT a global API
  key).
- **FR-G5-6** All CNAMEs MUST be created with `proxied: false` and
  `ttl: 1` (auto). The ingress LB handles HTTPS termination via
  cert-manager + the `*.ever.works` wildcard issuer (ops-managed).

## Non-functional requirements

- **NFR-G5-1** A flaky DNS API MUST NOT block deploys. The original
  k8s plugin's LB hostname remains a working fallback while the CNAME
  catches up.
- **NFR-G5-2** No SDK dependency — the provider uses the global
  `fetch` (Node 22+) so the bundle stays small and the test harness
  can inject a mock `fetch`.
- **NFR-G5-3** All log output MUST be redacted of the API token —
  never log the `Authorization` header or its value.

## Configuration (operator runbook)

| Env var                         | Required | Description                                               |
| ------------------------------- | -------- | --------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`          | yes      | Scoped token, **DNS:Edit on the `ever.works` zone only**. |
| `CLOUDFLARE_ZONE_ID`            | yes      | The `ever.works` zone id (32-char hex).                   |
| `EVER_WORKS_DEPLOY_LB_HOSTNAME` | yes      | k8s-works ingress LB hostname (e.g. `lb.k8s-works.svc`).  |
| `EVER_WORKS_DOMAIN`             | no       | Root domain. Defaults to `ever.works`.                    |

When any of the required vars is missing, the provider no-ops cleanly
— deploys still succeed via the k8s plugin's existing LB hostname.

## Out of scope (other gaps / follow-ups)

- Per-Work custom domain support (e.g. `foo.com → foo.ever.works`).
  Tracked separately when there's customer demand.
- DNS automation on Work delete is implemented in
  `EverWorksDnsService.removeWorkSubdomain` but not yet wired into
  `WorkLifecycleService.deleteWork` — follow-up sub-task.
- Cert-manager wildcard issuer install on `k8s-works` is an ops task,
  not code; documented separately in the cluster runbook.

## Acceptance

- A fresh Work with `slug=foo` and `deployProvider='ever-works'`
  deploys, and within ~2 min:
    - `dig CNAME foo.ever.works` returns the configured LB hostname.
    - `curl -sI https://foo.ever.works/` returns 200 with a valid TLS
      chain.
- The same operation a second time (re-deploy) does not create a
  duplicate record — `ensureWorkSubdomain` is idempotent.

## Tests

- `cloudflare-dns.provider.spec.ts` covers: create-new path, drift
  detection + PUT update, idempotent already-in-sync path, slug
  validation, delete + delete-missing, error envelope on 401, Bearer
  header on every call, `EverWorksDnsService` env caching + override.
- `deploy.service.spec.ts` extended with three new tests: ingressHost
  override for ever-works + active DNS, no-override for non-platform
  providers, no-override when env is unset.

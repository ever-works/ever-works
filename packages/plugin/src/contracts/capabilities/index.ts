export * from './git-provider.interface.js';
// App Works fork lifecycle (APW-02 T9/T10) — the types the seven optional
// fork-lifecycle members of `IGitProviderPlugin` consume (`GitProviderRequestError`,
// `GitForkSyncResult`, `GitForkDivergence`, `GitRepositoryCopyInput`,
// `GitRepositoryCopyResult`, `GitWorkflowRef`, `GitActionsPermissionsInput`,
// `GitActionsPermissionsResult`, `GitWebhookInput`). Additive only: no existing
// git-provider surface changes, so every existing implementation compiles and
// behaves exactly as before.
export * from './git-provider.app-forks.js';
// PR insights (kanban run cockpit M5/M6) — pure CI rollup + diff-cap
// rules shared by every git-provider implementation and asserted by the
// conformance suite.
export * from './git-provider.pr-insights.js';
export * from './oauth.interface.js';
export * from './deployment.interface.js';
// App Works (APW-06 T2) — the App-deployment types the ten OPTIONAL App members
// of `IDeploymentPlugin` consume (`AppRenderInput`, `AppDeployHooks`,
// `AppDeployResult`, `AppStatusSnapshot`, `AppScaleResult`, …). Additive only:
// nothing here changes the pre-existing deployment surface, so the `k8s` and
// Vercel plugins compile and behave exactly as before.
export * from './app-deployment.types.js';
export * from './screenshot.interface.js';
export * from './search.interface.js';
export * from './content-extractor.interface.js';
export * from './data-source.interface.js';
export * from './ai-provider.interface.js';
export * from './pipeline-plugin.interface.js';
export * from './pipeline-modifier.interface.js';
export * from './code-edit-plugin.interface.js';
export * from './form-schema-provider.interface.js';
export * from './prompt-provider.interface.js';
export * from './device-auth-provider.interface.js';
export * from './storage.interface.js';
export * from './datastore.interface.js';
export * from './skills-provider.interface.js';
export * from './task-tracker.interface.js';
// Notifications v2 (EW-650 + siblings) — email + chat channel contracts.
export * from './email-provider.interface.js';
export * from './notification-channel.interface.js';
// Connectors ("Connector fabric") — first-party BIDIRECTIONAL comms
// plugins (outbound send + inbound route-to-Agent). Additive superset of
// the notification-channel contract; see `connector.interface.ts` and
// `docs/specs/features/connectors/spec.md`. Interface + types only for the
// inbound leg in this increment (routing/pairing runtime lands in P2).
export * from './connector.interface.js';
export * from './agent-memory.interface.js';
export * from './terminal-stream.interface.js';
export * from './workspace.interface.js';
// Headless browser drivers (audit item G22) — navigate / extract /
// screenshot / act behind a default-deny navigation allowlist that is
// re-checked on every redirect hop. First-party implementation:
// `@ever-works/browser-automation-plugin` (Playwright).
export * from './browser-automation.interface.js';
// Event-ingest spine (Wave 6) — pull-model event sources feeding the
// normalized `IngestedEventEnvelope` pipeline (webhook push lands with
// each concrete connector). See `event-source.interface.ts`.
export * from './event-source.interface.js';
// Org-wide Memory (Cortex P2) — pluggable ORG memory framework +
// multi-doc-type RAG pipeline contracts. Additive, beside the existing
// `agent-memory` / `vector-store` / `content-extractor` seams. See
// `docs/specs/features/memory/spec.md` §5.
export * from './memory.interface.js';
export * from './rag.interface.js';
// EW-642 — pluggable vector-store backends.
export * from './vector-store.interface.js';
// EW-734 / EW-735 — pluggable DNS providers (Cloudflare today; BYO Cloudflare
// + future Route53/etc. via the plugin registry). Additive — does NOT replace
// the existing `CloudflareDnsProvider` concrete class in @ever-works/agent.
export * from './dns.interface.js';
// EW-683 / EW-685 P0 — pluggable job-runtime providers (Trigger.dev today;
// Temporal / BullMQ / pg-boss / Inngest via plugin packages once EW-686+
// land). Additive contract-only — no call site is bound through this yet.
// See docs/specs/architecture/job-runtime-providers.md §2 (seam) + §3 (contract).
export * from './job-runtime.interface.js';
// EW-742 P3.2 follow-up — pluggable secret-store-resolver backends.
// `ISecretStoreProvider` plugin contract for Vault / k8s / Infisical /
// Doppler / future cloud-vendor resolvers. The `inline:` + `env:`
// default lives in @ever-works/agent (zero external deps); every other
// scheme ships as a plugin package under packages/plugins/secret-store-*/.
export * from './secret-store.interface.js';
// Goals feature PR-7 — read-only metrics collectors (custom-http, Stripe;
// PostHog + Google Analytics in PR-9). Consumed by MetricsFacadeService
// and, from PR-8 on, by Goal evaluation.
export * from './metrics-provider.interface.js';
// Capability & playbook catalogue (AW-21) — providers of Playbook catalogue
// entries. Consumed by PlaybookCatalogFacadeService.
export * from './playbook-provider.interface.js';
// AW-15 — optional plain-English access levels ("Read only" / "Read and
// write") a provider plugin declares; the platform writes the chosen level
// onto the existing tool-grant lattice. See `connection-scopes.interface.ts`.
export * from './connection-scopes.interface.js';
// App Works (APW-07 T3) — the `app-dependency` capability: one plugin serves
// several provider ids (`k8s-inline-postgres`, `smtp-external`, …), each with
// its own descriptor, prompt schema and backup policy. Additive: no existing
// capability, category or contract changes.
export * from './app-dependency.interface.js';
// App Works (APW-05 T2) — the `build` capability: `IBuildPlugin` and the shapes
// the workflow generator, the secret sync, the run observer and the registry
// check are written against (`PrepareRepositoryInput`/`Result`, `BuildSnapshot`,
// `ImageAccessResult`, `BuildRunRef`, `isBuildPlugin`). Additive: no existing
// capability, category or contract changes, and `BuildRunRef` /
// `AppBuildVerificationResult` / `BUILD_SERVICE_DEFAULTS` are re-exported from
// `@ever-works/contracts` (APW-05 T1) rather than redeclared (Resolution R-1).
export * from './build.interface.js';
// App Works (APW-12 T4) — the `identity-provider` capability: `IIdentityProviderPlugin`
// (the seven methods the OpenID Connect relying party implements), the seven
// `IdentityProviderCheck` ids **Test connection** renders, the verified token claim
// shapes and the closed `IdentityTokenRejectedError` code set. Additive: no existing
// capability, category or contract changes, and the category `'identity'` that goes
// with it (@see plugin-manifest.types.ts) lands in the same change; a plugin that
// never declares `identity-provider` compiles and behaves exactly as before.
export * from './identity-provider.interface.js';
// App Works (APW-10 T2) — the `apps-tier` capability: `IAppsTierProvider` (the
// eighteen required members a hosting-zone provider implements — zone info, the
// one desired-state write, quarantine, throttle, removal, dependencies,
// self-check, the credential review, heartbeat, metering, signals and owner
// logs — plus the two P3 build members) and every plugin-facing shape it names
// (`apps-tier.types.ts`). The wire-level model of the `Work` object itself is
// re-exported from `@ever-works/contracts` (APW-10 T1) rather than redeclared
// (Resolution R-1). Additive: no existing capability, category or contract
// changes, and T2 appends no category — the implementing plugin declares the
// existing `deployment` one (plan §5.2:602) — so a plugin that never declares
// `apps-tier` compiles and behaves exactly as before.
export * from './apps-tier.interface.js';
export * from './apps-tier.types.js';

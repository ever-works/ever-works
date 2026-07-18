export * from './git-provider.interface.js';
export * from './oauth.interface.js';
export * from './deployment.interface.js';
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
export * from './skills-provider.interface.js';
export * from './task-tracker.interface.js';
// Notifications v2 (EW-650 + siblings) — email + chat channel contracts.
export * from './email-provider.interface.js';
export * from './notification-channel.interface.js';
export * from './agent-memory.interface.js';
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

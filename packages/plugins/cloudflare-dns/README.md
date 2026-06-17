# @ever-works/cloudflare-dns

Cloudflare DNS provider plugin for the Ever Works platform.

## Plugin metadata

| Field        | Value                                                                                   |
| ------------ | --------------------------------------------------------------------------------------- |
| ID           | `cloudflare-dns`                                                                        |
| Category     | `dns`                                                                                   |
| Capabilities | `dns`, `dns-ensure-record`, `dns-remove-record`, `dns-record-exists`, `dns-root-domain` |
| Author       | Ever Works Team                                                                         |
| License      | AGPL-3.0                                                                                |
| Built-in     | yes                                                                                     |
| Auto-enable  | no                                                                                      |

## What is the Cloudflare DNS plugin?

This plugin lets Ever Works create, update, and remove DNS records on Cloudflare for the subdomains and custom domains your Works are served from. It implements the `IDnsProvider` capability (EW-735) and is the registry-resolved successor to the legacy concrete `CloudflareDnsProvider` in `@ever-works/agent` (which continues to operate unchanged — this plugin is **additive**).

## Operator modes

The plugin supports two modes side-by-side, distinguished by where the credentials live:

### Managed mode — `*.ever.works`

Platform operators wire credentials via environment variables. The plugin's `x-envVar` schema entries forward these to plugin settings transparently, so no per-user settings are needed for managed subdomains.

| Env var                         | Purpose                                               |
| ------------------------------- | ----------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`          | Scoped token with `DNS:Edit` on the `ever.works` zone |
| `CLOUDFLARE_ZONE_ID`            | `ever.works` zone id                                  |
| `EVER_WORKS_DOMAIN`             | Defaults to `ever.works`                              |
| `EVER_WORKS_DEPLOY_LB_HOSTNAME` | CNAME target — the k8s-works ingress LB hostname      |

### Bring-your-own (BYO) mode — custom apex/domain

Users supply their own Cloudflare token + zone for a domain they own (e.g. `acme.com`). Values are persisted to encrypted user-scoped plugin settings. Records are created with the Cloudflare proxy **off** by default so the user keeps serving their own TLS.

Required scopes for the Cloudflare API token: `DNS:Edit` for the target zone. Create one at https://dash.cloudflare.com/profile/api-tokens.

## Capabilities

| Capability          | Method                                           | Notes                                                                      |
| ------------------- | ------------------------------------------------ | -------------------------------------------------------------------------- |
| `dns-ensure-record` | `ensureRecord({ host, type, target, proxied? })` | Idempotent create-or-update. Patches drifted records in place.             |
| `dns-remove-record` | `removeRecord({ host, type? })`                  | Idempotent delete. Omitting `type` probes both `CNAME` and `A`.            |
| `dns-record-exists` | `recordExists(host)`                             | Uniqueness probe — `true` iff any `CNAME` or `A` record exists for `host`. |
| `dns-root-domain`   | `rootDomain()`                                   | Returns the zone's root domain (e.g. `ever.works`).                        |

## See also

- `docs/specs/features/cloudflare-dns-plugin/spec.md` — authoritative design doc.
- `packages/plugin/src/contracts/capabilities/dns.interface.ts` — `IDnsProvider` / `IDnsOperations` contracts.
- `packages/agent/src/ever-works-providers/cloudflare-dns.provider.ts` — legacy concrete provider this plugin runs alongside.

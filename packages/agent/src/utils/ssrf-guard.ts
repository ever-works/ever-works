// Re-exported from `@ever-works/plugin/helpers` so plugin packages can share
// the same implementation. See packages/plugin/src/helpers/ssrf-guard.ts for
// the actual code and rationale.
export {
    isSafeWebhookUrl,
    isPrivateIPv4,
    isPrivateIPv6,
    safeFetchWithDnsPin,
    SsrfBlockedError,
    type DnsLookupAddress,
    type DnsResolver,
    type SafeFetchOptions,
} from '@ever-works/plugin/helpers/ssrf-guard';

/**
 * The signed request in the URL fragment (`#intent=<compact JWS>`), or `null`: only
 * this exact shape, so nothing else in a fragment ever reaches the server.
 */
export function readProvisionFragment(hash: string): string | null {
    const match = /^#intent=([A-Za-z0-9_.-]{1,65536})$/.exec(hash);
    return match ? match[1] : null;
}

export type ProvisionFailureKey =
    | 'failure.incomplete'
    | 'failure.invalid'
    | 'failure.expired'
    | 'failure.used'
    | 'failure.unavailable'
    | 'failure.rateLimited'
    | 'failure.mismatch'
    | 'failure.tenantLinked'
    | 'failure.organizationLinked'
    | 'failure.inProgress'
    | 'failure.invalidValue'
    | 'failure.unreachable'
    | 'failure.failed';

/** The translation key of a failure, under `everConnect.provision`. */
export function everConnectProvisionFailureKey(failure: string): ProvisionFailureKey {
    switch (failure) {
        case 'incomplete':
            return 'failure.incomplete';
        case 'invalid':
            return 'failure.invalid';
        case 'expired':
            return 'failure.expired';
        case 'used':
            return 'failure.used';
        case 'unavailable':
            return 'failure.unavailable';
        case 'rate_limited':
            return 'failure.rateLimited';
        case 'mismatch':
            return 'failure.mismatch';
        case 'tenant_linked':
            return 'failure.tenantLinked';
        case 'organization_linked':
            return 'failure.organizationLinked';
        case 'in_progress':
            return 'failure.inProgress';
        case 'invalid_value':
            return 'failure.invalidValue';
        case 'unreachable':
            return 'failure.unreachable';
        default:
            return 'failure.failed';
    }
}

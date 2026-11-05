/**
 * The switches of creating a company a person asked for in Ever. Both default
 * off; only the exact value `true` (any case) turns one on.
 *
 * - `EVER_CONNECT_PROVISIONING_ENABLED`: the routes exist. Off, every
 *   `/api/ever-connect/provision*` route answers 404 like any unknown address.
 * - `EVER_CONNECT_PROVISION_STAFFING_ENABLED`: a company call also runs starter
 *   staff and the first Mission. Off, it creates the Company Work, the
 *   Organization and the link, and reports both as skipped (`disabled`).
 */
type Env = Readonly<Record<string, string | undefined>>;

function isOn(value: string | undefined): boolean {
    return value?.trim().toLowerCase() === 'true';
}

export function isProvisioningEnabled(env: Env = process.env): boolean {
    return isOn(env.EVER_CONNECT_ENABLED) && isOn(env.EVER_CONNECT_PROVISIONING_ENABLED);
}

export function isProvisionStaffingEnabled(env: Env = process.env): boolean {
    return isProvisioningEnabled(env) && isOn(env.EVER_CONNECT_PROVISION_STAFFING_ENABLED);
}

/** What the installation can do with a request from Ever Platform. */
export interface EverConnectProvisionCapabilities {
    /** A request can be received and a company created. */
    readonly provisionHandoff: boolean;
    /** The call also runs starter staff and the first Mission. */
    readonly provisionCompany: boolean;
}

export function provisionCapabilities(env: Env = process.env): EverConnectProvisionCapabilities {
    return {
        provisionHandoff: isProvisioningEnabled(env),
        provisionCompany: isProvisionStaffingEnabled(env),
    };
}

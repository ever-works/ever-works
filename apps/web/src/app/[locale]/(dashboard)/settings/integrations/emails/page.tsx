import { emailAddressesAPI } from '@/lib/api/email-addresses';
import { EmailAddressesSettings } from '@/components/settings/EmailAddressesSettings';

/**
 * EW-650 / EW-679 — Tenant email addresses settings page.
 */
export default async function EmailAddressesPage() {
    let initialAddresses: Awaited<ReturnType<typeof emailAddressesAPI.list>> = [];
    try {
        initialAddresses = await emailAddressesAPI.list(undefined, { includeDisabled: true });
    } catch {
        initialAddresses = [];
    }
    // EW-P4-3 — the inbound webhook URL the wizard shows must be the API's
    // PUBLIC origin (API_URL may be an in-cluster address).
    const apiOrigin = (
        process.env.NEXT_PUBLIC_API_URL ||
        process.env.API_URL ||
        'http://localhost:3100'
    )
        .replace(/\/+$/, '')
        .replace(/\/api$/, '');
    return <EmailAddressesSettings initialAddresses={initialAddresses} apiOrigin={apiOrigin} />;
}

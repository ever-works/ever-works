import { emailAddressesAPI } from '@/lib/api/email-addresses';
import { EmailAddressesSettings } from '@/components/settings/EmailAddressesSettings';

/**
 * EW-650 / EW-679 — Tenant email addresses settings page.
 */
export default async function EmailAddressesPage() {
    let initialAddresses: Awaited<ReturnType<typeof emailAddressesAPI.list>> = [];
    try {
        initialAddresses = await emailAddressesAPI.list();
    } catch {
        initialAddresses = [];
    }
    return <EmailAddressesSettings initialAddresses={initialAddresses} />;
}

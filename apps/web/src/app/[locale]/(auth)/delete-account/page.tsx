import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { DeleteAccountRequestForm } from './delete-account-request-form';

/**
 * Public "delete my account" request form. Signed-out: it only asks for an
 * email address; the account owner proves it by clicking the emailed link.
 * `referrer: no-referrer` + the proxy's `Cache-Control: no-store` for this
 * path; PostHog is not started here (see `PostHogProvider`).
 */
export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return {
        title: t('deleteAccount'),
        referrer: 'no-referrer',
        robots: { index: false, follow: false },
    };
}

export default function DeleteAccountRequestPage() {
    return <DeleteAccountRequestForm />;
}

import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { DeleteAccountConfirmClient } from './delete-account-confirm-client';

/**
 * Email-link landing page. The token arrives in the URL FRAGMENT
 * (`#token=…`), which the browser never sends to a server; the client reads
 * it, removes it from the address bar with `history.replaceState`, shows what
 * will be deleted, and deletes only on an explicit confirm. Opening the link
 * deletes nothing and signs nobody in.
 */
export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return {
        title: t('deleteAccount'),
        referrer: 'no-referrer',
        robots: { index: false, follow: false },
    };
}

export default function DeleteAccountConfirmPage() {
    return <DeleteAccountConfirmClient />;
}

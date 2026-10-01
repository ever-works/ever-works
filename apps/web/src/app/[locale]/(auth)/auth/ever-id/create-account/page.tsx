import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { authAPI, type TermsAcceptanceDocument } from '@/lib/api';
import { readEverIdPending } from '@/lib/auth/ever-id-cookies';
import { EverIdCreateAccountClient } from './create-account-client';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('auth.everId.createAccount');
    return { title: t('title') };
}

/**
 * APW-12 (Ever ID) — "Create your Ever Works account" (S2, spec §6.2, T25).
 *
 * The identity shown comes from the encrypted pending cookie the callback set,
 * never from the address bar. The terms come from the same source the register
 * page uses — the documents the API publishes, in the visitor's locale — and are
 * posted back exactly as displayed, so the web never invents a `documentId`.
 * Without a live pending value the page says "That took too long. Start again."
 */
export default async function EverIdCreateAccountPage() {
    const pending = await readEverIdPending('signUp');
    if (!pending) {
        return <EverIdCreateAccountClient identity={null} termsDocuments={[]} />;
    }

    // An empty list blocks the screen visibly (with a retry), exactly as on the
    // register page: there is nothing truthful to record an acceptance against.
    let termsDocuments: TermsAcceptanceDocument[] = [];
    try {
        termsDocuments = await authAPI.getRequiredTerms(await getLocale());
    } catch (error) {
        console.error('Failed to load the required legal documents', error);
    }

    return (
        <EverIdCreateAccountClient
            identity={{ name: pending.name, email: pending.email }}
            termsDocuments={termsDocuments}
        />
    );
}

import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import RegisterForm from './register-form';
import { getConfiguredAuthProviders } from '@/lib/auth/providers';
import { authAPI, type TermsAcceptanceDocument } from '@/lib/api';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('createAccount') };
}

/**
 * What ever.co/checkout/complete puts on the URL after a purchase.
 *
 * It reads the finished Stripe Checkout Session and forwards the identity Stripe
 * collected, so someone arriving from checkout is not asked a second time for
 * what they have already typed.
 */
interface RegisterSearchParams {
    email?: string;
    name?: string;
}

export default async function RegisterPage({
    searchParams,
}: {
    searchParams: Promise<RegisterSearchParams>;
}) {
    const availableSocialProviders = await getConfiguredAuthProviders();
    const { email, name } = await searchParams;

    // Resolve the documents this signup must accept on the server, in the user's
    // locale, and hand them to the form. The form posts them straight back on
    // submit, so the identity of the text shown next to the checkbox and the
    // identity of the text recorded as accepted are the same object.
    //
    // A failure here yields an empty list, which the form treats as "cannot
    // register": submitting with nothing to pin the acceptance to is exactly the
    // defect being fixed, so failing visibly beats failing silently.
    let termsDocuments: TermsAcceptanceDocument[] = [];

    try {
        termsDocuments = await authAPI.getRequiredTerms(await getLocale());
    } catch (error) {
        console.error('Failed to load the required legal documents', error);
    }

    return (
        <RegisterForm
            availableSocialProviders={availableSocialProviders}
            termsDocuments={termsDocuments}
            prefill={{ email, name }}
        />
    );
}

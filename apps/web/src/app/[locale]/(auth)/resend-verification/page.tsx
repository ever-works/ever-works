import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import ResendVerificationForm from './resend-verification-form';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('resendVerification') };
}

/**
 * EW-070 — the signed-out route back in.
 *
 * A user whose verification email never arrived had no path at all: login
 * answers 403 for an unverified address, the only resend action requires the
 * session that 403 withholds, and the two "Resend Verification Email" buttons
 * on /auth/error pointed at `/`. This page is what those buttons now point at.
 */
export default function ResendVerificationPage() {
    return <ResendVerificationForm />;
}

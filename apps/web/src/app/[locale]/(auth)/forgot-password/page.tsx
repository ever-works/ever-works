import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import ForgotPasswordForm from './forgot-password-form';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('forgotPassword') };
}

export default function ForgotPasswordPage() {
    return <ForgotPasswordForm />;
}

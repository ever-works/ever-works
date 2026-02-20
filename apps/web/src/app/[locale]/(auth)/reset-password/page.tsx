import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import ResetPasswordForm from './reset-password-form';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('resetPassword') };
}

export default function ResetPasswordPage() {
    return <ResetPasswordForm />;
}

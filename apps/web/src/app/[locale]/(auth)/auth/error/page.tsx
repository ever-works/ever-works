import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import AuthErrorClient from './auth-error-content';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('authError') };
}

export default function AuthErrorPage() {
    return <AuthErrorClient />;
}

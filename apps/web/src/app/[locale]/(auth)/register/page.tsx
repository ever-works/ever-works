import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import RegisterForm from './register-form';
import { getConfiguredAuthProviders } from '@/lib/auth/providers';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('createAccount') };
}

export default async function RegisterPage() {
    const availableSocialProviders = await getConfiguredAuthProviders();

    return <RegisterForm availableSocialProviders={availableSocialProviders} />;
}

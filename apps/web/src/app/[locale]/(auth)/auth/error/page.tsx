'use client';

import { useTranslations } from 'next-intl';

export default function AuthErrorPage() {
    const t = useTranslations('auth.error');

    return <div>{t('title')}</div>;
}

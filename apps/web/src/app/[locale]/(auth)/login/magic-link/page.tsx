import type { Metadata } from 'next';
import { Suspense } from 'react';
import { getTranslations } from 'next-intl/server';
import { MagicLinkRedeemClient } from './magic-link-redeem-client';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('signIn') };
}

export default function MagicLinkRedeemPage() {
    return (
        <Suspense
            fallback={
                <div className="min-h-screen bg-background dark:bg-background-dark flex items-center justify-center">
                    <div className="animate-pulse">
                        <div className="w-12 h-12 bg-surface-secondary dark:bg-surface-secondary-dark rounded-full"></div>
                    </div>
                </div>
            }
        >
            <MagicLinkRedeemClient />
        </Suspense>
    );
}

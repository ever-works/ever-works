import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { readEverIdPending } from '@/lib/auth/ever-id-cookies';
import { ConnectEverIdClient } from './connect-ever-id-client';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.settings.security.connectedIdentities');
    return { title: t('confirmTitle') };
}

/**
 * APW-12 (Ever ID) — "Connect Ever ID to this account?" (S4, spec §6.4, T26).
 *
 * Reached from the provider round trip of "Connect Ever ID". Both addresses come
 * from the encrypted pending cookie the callback set — never from the address
 * bar — and a missing or expired value renders "That took too long. Start again."
 */
export default async function ConnectEverIdPage() {
    const pending = await readEverIdPending('connect');

    return (
        <ConnectEverIdClient
            everIdEmail={pending?.email ?? null}
            accountEmail={pending?.accountEmail ?? null}
        />
    );
}

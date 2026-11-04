import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ProvisionLandingClient } from './provision-landing-client';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('everConnect.provision');
    return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * Where Ever sends a person who asked for a company in Ever Works, with the signed
 * request in the URL fragment (`#intent=…`): a fragment never reaches a server or a
 * proxy log. Public, because the person may have no account yet; it grants nothing
 * by itself.
 */
export default function EverConnectProvisionPage() {
    return <ProvisionLandingClient />;
}

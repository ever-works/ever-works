import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { getAuthFromCookie } from '@/lib/auth';
import CampaignFormClient from './campaign-form-client';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.workCreation.campaign');
    return { title: t('title') };
}

/**
 * "Start a campaign" — the activation surface for the `campaign` Work kind
 * (roadmap 14.1). Deliberately a separate route from `/works/new`: a
 * campaign is not a website, so none of the git/deploy provider selection
 * on that page applies. One brief in, a whole go-to-market setup out.
 */
export default async function NewCampaignPage() {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect('/login');
    }

    return <CampaignFormClient />;
}

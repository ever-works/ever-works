import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { workAPI } from '@/lib/api';
import { ActivityFeedClient } from '@/components/works/detail/activity/ActivityFeedClient';
import type { FeedCategory } from '@/lib/api/works/activity-feed.types';
import { FEED_CATEGORIES } from '@/lib/api/works/activity-feed.types';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.workDetail.activity');
    return { title: t('title') };
}

type Params = {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ category?: string }>;
};

function parseCategory(value: string | undefined): FeedCategory {
    if (value && (FEED_CATEGORIES as readonly string[]).includes(value)) {
        return value as FeedCategory;
    }
    return 'all';
}

export default async function WorkActivityPage({ params, searchParams }: Params) {
    const { id } = await params;
    const { category } = await searchParams;

    try {
        await workAPI.get(id);
    } catch {
        notFound();
    }

    return <ActivityFeedClient workId={id} initialCategory={parseCategory(category)} />;
}

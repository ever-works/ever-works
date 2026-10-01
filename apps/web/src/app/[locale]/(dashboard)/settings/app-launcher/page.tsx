import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import {
    APP_LAUNCHER_PIN_LIMIT,
    type AppLauncherItem,
    type AppLauncherListResponse,
} from '@ever-works/contracts';
import { AppLauncherSettings } from '@/components/settings/AppLauncherSettings';
import { getAuthFromRequest } from '@/lib/auth';
import { appLauncherAPI, APP_LAUNCHER_SETTINGS_PAGE_SIZE } from '@/lib/api/app-launcher';
import { isAppLauncherEnabled } from '@/lib/feature-flags/app-launcher';

/**
 * APW-11 T16 — `/settings/app-launcher`, **Manage apps** (plan §7, FR-27,
 * FR-63).
 *
 * A server component: it reads the person's list once, with `includeHidden=true`
 * so hidden and not-live rows are editable too (FR-27), and hands it to the
 * client editor. Every write after that is the editor's Server Action.
 *
 * ## Disabled means `notFound()`
 *
 * FR-54/FR-65: with the launcher switched off there is no page, no route and no
 * entry point — the tab is filtered out of the nav by `settings/layout.tsx` and
 * the API answers `404` for the routes behind it. A page that rendered a
 * "not enabled" message would be a surface a switched-off installation does not
 * have, and `notFound()` is the same answer the API gives.
 *
 * The flag is resolved **again** here rather than being received from a layout:
 * an App Router layout cannot pass props into the page it wraps (APW11-G13),
 * which is exactly why `settings/layout.tsx` resolves its own copy for the nav.
 * Both halves fail closed, so the two answers cannot disagree in the direction
 * that matters: the worst case is one redundant evaluation during a flag
 * outage, and the page — the surface that can read a person's apps — is the one
 * that refuses.
 *
 * ## A failed read renders the failure, not an empty list
 *
 * `loadFailed` reaches the editor, which shows the read error. An empty editor
 * would tell a person their apps are gone, and — worse — invite them to
 * "re-add" rows the API would then reject as `unknownItem`.
 */

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.settings.tabs');
    return { title: t('appLauncher') };
}

export default async function AppLauncherSettingsPage() {
    const auth = await getAuthFromRequest();
    const enabled = await isAppLauncherEnabled(auth.isAuthenticated ? auth.user?.sub : undefined);
    if (!enabled) {
        notFound();
    }

    let items: AppLauncherItem[] = [];
    let meta: AppLauncherListResponse['meta'] | null = null;
    let loadFailed = false;

    try {
        const list = await appLauncherAPI.list({
            includeHidden: true,
            limit: APP_LAUNCHER_SETTINGS_PAGE_SIZE,
        });
        items = list.items;
        meta = list.meta;
    } catch (error) {
        loadFailed = true;
        console.error('Failed to read the App Launcher list:', error);
    }

    // The editor's contract needs `meta` (the pin limit, the eligible count and
    // the truncation flag). When the read failed there is nothing to describe,
    // so the failure state carries the contract's own defaults instead of a
    // fabricated count — and the editor renders the read error rather than any
    // of these numbers, so none of them is ever shown to a person.
    const emptyMeta: AppLauncherListResponse['meta'] = {
        environment: 'production',
        catalogVersion: null,
        catalogAvailable: false,
        scopeKey: '',
        worksTotal: 0,
        total: 0,
        truncated: false,
        pinLimit: APP_LAUNCHER_PIN_LIMIT,
        appWorksAvailable: false,
    };

    return (
        <AppLauncherSettings
            initialItems={items}
            initialMeta={meta ?? emptyMeta}
            loadFailed={loadFailed}
        />
    );
}

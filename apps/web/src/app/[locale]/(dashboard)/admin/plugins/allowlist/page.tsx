/**
 * EW-693 / T35 — Admin allowlist management page.
 *
 * Lists every row in `plugin_allowlist`, lets a platform admin add /
 * patch / delete entries. First-party `@ever-works/*` plugins are
 * implicitly permitted by the installer and don't appear here.
 *
 * Gated server-side by `IsPlatformAdminGuard` on the controller
 * (apps/api/src/plugins/allowlist.controller.ts).
 *
 * That guard answers 403, and this page used to let the rejection
 * escape: `pluginAllowlistAPI.list()` was awaited unguarded, so for
 * every non-admin the Server Component threw and the route answered
 * **HTTP 500** with a blank content area. The docstring claimed the
 * auth boundary also lived "in whatever Next.js admin-area layout wraps
 * `/admin/*`" — there is no such layout, and never was; both sibling
 * admin pages implement the boundary themselves.
 *
 * So it now does what `/admin/usage` and the tenant runtime-allowlist
 * page do: translate "not allowed" into `notFound()`. A regular user
 * gets the ordinary 404 page, which keeps the route invisible instead
 * of advertising it with a distinctive crash.
 *
 * The page is a minimal CRUD surface — table + add-row form + per-row
 * actions. v1 is intentionally sparse; future iterations can layer
 * filters, integrity inspection, and bulk import on top without
 * touching the data path.
 */

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { authAPI } from '@/lib/api';
import { pluginAllowlistAPI } from '@/lib/api/plugins';
import { AllowlistManager } from './allowlist-manager.client';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
    title: 'Plugin allowlist',
};

export default async function PluginAllowlistAdminPage() {
    // Defense-in-depth, mirroring `/admin/usage`: when the profile DTO
    // carries `isPlatformAdmin`, short-circuit for non-admins without an
    // admin-API round-trip.
    //
    // Check for an EXPLICIT `false`, not a falsy split: `/api/auth/profile`
    // is a whitelist projection that currently strips `isPlatformAdmin`
    // altogether, so the field is `undefined` for everyone — a truthy test
    // would 404 the page for real admins too. The API guard below stays the
    // authoritative gate.
    const profile = await authAPI.getProfile().catch(() => null);
    if (profile?.isPlatformAdmin === false) {
        notFound();
    }

    let initial: Awaited<ReturnType<typeof pluginAllowlistAPI.list>>;
    try {
        initial = await pluginAllowlistAPI.list();
    } catch {
        notFound();
    }

    return (
        <main className="mx-auto max-w-4xl px-4 py-8">
            <header className="mb-6">
                <h1 className="text-2xl font-semibold">Plugin allowlist</h1>
                <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                    Non-first-party packages permitted for runtime install (EW-693). First-party{' '}
                    <code>@ever-works/*</code> plugins are implicitly allowed and are not listed
                    here.
                </p>
            </header>

            <AllowlistManager initial={initial.entries as never} />
        </main>
    );
}

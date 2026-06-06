/**
 * EW-693 / T35 — Admin allowlist management page.
 *
 * Lists every row in `plugin_allowlist`, lets a platform admin add /
 * patch / delete entries. First-party `@ever-works/*` plugins are
 * implicitly permitted by the installer and don't appear here.
 *
 * Gated server-side by `IsPlatformAdminGuard` on the controller
 * (apps/api/src/plugins/allowlist.controller.ts). This page only
 * renders the data + forms; the auth boundary lives in the API layer
 * and in whatever Next.js admin-area layout wraps `/admin/*` routes.
 *
 * The page is a minimal CRUD surface — table + add-row form + per-row
 * actions. v1 is intentionally sparse; future iterations can layer
 * filters, integrity inspection, and bulk import on top without
 * touching the data path.
 */

import { pluginAllowlistAPI } from '@/lib/api/plugins';
import { AllowlistManager } from './allowlist-manager.client';

export const dynamic = 'force-dynamic';

export default async function PluginAllowlistAdminPage() {
    const initial = await pluginAllowlistAPI.list();

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

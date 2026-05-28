'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Building2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useOrganizations } from '@/lib/hooks/use-organizations';
import { CreateOrganizationModal } from './CreateOrganizationModal';

/**
 * EW-661 (Tenants & Organizations Phase 9) — Settings → Account banner
 * surfacing the "Create your first Organization" CTA per spec §5.5
 * (empty-state entry points list).
 *
 * Renders ONLY when `organizations.length === 0` (and we're not still
 * doing the initial fetch). Once the user has at least one Org the
 * banner quietly disappears.
 *
 * Drop this at the top of any settings/account-style page — currently
 * wired into `<ProfileSettings>`.
 */
export function CreateFirstOrgBanner() {
    const t = useTranslations('organizations.banner');
    const { organizations, isLoading } = useOrganizations();
    const [isModalOpen, setIsModalOpen] = useState(false);

    // Hide the banner UI while loading or once at least one Org
    // exists, BUT keep the modal mounted unconditionally so the
    // post-create upgrade dialog has a place to render. If the modal
    // shared this guard, creating-the-first-Org would flip
    // `organizations.length` to 1 and immediately unmount the modal
    // before the UpgradeOrCreateDialog could appear. (Codex P1 on PR
    // #1063.)
    const shouldShowBanner = !isLoading && organizations.length === 0;

    return (
        <>
            {shouldShowBanner && (
                <div className="flex items-start gap-4 rounded-lg border border-primary/20 bg-primary/5 p-4">
                    <div className="shrink-0 w-10 h-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
                        <Building2 className="w-5 h-5 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-text dark:text-text-dark">
                            {t('title')}
                        </p>
                        <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                            {t('description')}
                        </p>
                    </div>
                    <Button size="sm" onClick={() => setIsModalOpen(true)}>
                        {t('cta')}
                    </Button>
                </div>
            )}
            <CreateOrganizationModal open={isModalOpen} onOpenChange={setIsModalOpen} />
        </>
    );
}

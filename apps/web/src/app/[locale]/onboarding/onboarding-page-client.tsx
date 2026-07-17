'use client';

import { useCallback, useState } from 'react';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { EverWorksOnboardingWizard } from '@/components/onboarding/EverWorksOnboardingWizard';
import type { OnboardingCatalogResponse, OnboardingStateResponse } from '@ever-works/contracts/api';
import type { UserPlugin } from '@/lib/api/plugins';
import type { OAuthConnectionInfo } from '@/lib/api/plugins-capabilities/oauth';
import type { GitProviderConnectionInfo } from '@/lib/api/plugins-capabilities/git-providers';
import type { PluginDeviceAuthStatus } from '@/lib/api/plugins-capabilities/device-auth';

interface Props {
    initialState: OnboardingStateResponse;
    catalog: OnboardingCatalogResponse;
    plugins: ReadonlyArray<UserPlugin>;
    initialConnections: Record<string, OAuthConnectionInfo | GitProviderConnectionInfo | null>;
    initialDeviceAuthStatuses: Record<string, PluginDeviceAuthStatus | null>;
}

export function OnboardingPageClient(props: Props) {
    const router = useRouter();
    // Force open regardless of works count / prior dismissal. This standalone
    // page is an explicit "start onboarding" surface, so open === true — that is
    // the fix for the logged-in-WITH-works case (the owner's 404), with NO edit
    // to the dashboard auto-open logic.
    const [open, setOpen] = useState(true);

    const handleClose = useCallback(() => {
        setOpen(false);
        // Nothing sits behind the modal here — route into the app. Anonymous
        // users hold a valid session, so the dashboard renders for them too.
        router.push(ROUTES.DASHBOARD);
    }, [router]);

    // The wizard reads #prompt/#corrId from window.location.hash on mount,
    // sanitizes, setPrompt, jumps to the create-work step, then strips the hash
    // — no extra wiring needed here.
    return (
        <main className="min-h-screen bg-surface dark:bg-surface-dark">
            <EverWorksOnboardingWizard
                open={open}
                initialState={props.initialState}
                catalog={props.catalog}
                plugins={props.plugins}
                initialConnections={props.initialConnections}
                initialDeviceAuthStatuses={props.initialDeviceAuthStatuses}
                onClose={handleClose}
            />
        </main>
    );
}

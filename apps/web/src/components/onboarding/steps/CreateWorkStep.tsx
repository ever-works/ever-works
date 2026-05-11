'use client';

import { ArrowRight, FolderPlus } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';

export interface CreateWorkStepProps {
    readonly onLeave: () => void;
}

/**
 * Final step — navigates the user into the Create Work flow. The wizard
 * closes once the user clicks the action; the parent fires the
 * `onboarding_completed` telemetry event and marks the server flag.
 */
export function CreateWorkStep({ onLeave }: CreateWorkStepProps) {
    return (
        <div className="space-y-5 max-w-lg">
            <div className="flex items-start gap-4">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface-secondary dark:bg-white/5">
                    <FolderPlus className="w-5 h-5 text-text-secondary dark:text-text-secondary-dark" />
                </div>
                <div>
                    <h3 className="text-lg font-semibold text-text dark:text-text-dark">
                        Create your first work
                    </h3>
                    <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                        You&apos;re all set. Hit the button below to start building — your
                        choices above are saved and any new work will pick them up.
                    </p>
                </div>
            </div>
            <div className="rounded-xl border border-dashed border-border dark:border-border-dark bg-surface-secondary/40 dark:bg-surface-secondary-dark/30 p-5">
                <Link
                    href={ROUTES.DASHBOARD_WORKS_NEW}
                    onClick={onLeave}
                    className="inline-flex items-center gap-2 rounded-lg bg-black dark:bg-button-primary-dark px-4 py-2.5 text-sm font-medium text-white dark:text-black transition-colors hover:bg-button-primary-hover dark:hover:bg-button-primary-hover-dark"
                >
                    Create your first work
                    <ArrowRight className="w-4 h-4" />
                </Link>
            </div>
        </div>
    );
}

'use client';

import { useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { rotateAppEnvAction } from '@/app/actions/dashboard/app-env';
import type { AppEnvRotateView, AppEnvVariableView } from '@/lib/api/app-env.types';

export interface AppEnvRotateDialogProps {
    workId: string;
    entry: AppEnvVariableView;
    onOpenChange: (open: boolean) => void;
    onRotated: (answer: AppEnvRotateView) => void;
}

/** The refusals with their own sentence → `environment.rotate.refusals.*`. */
const ROTATE_REFUSALS = {
    rotateConfirmationMismatch: 'mismatch',
    notGenerated: 'notGenerated',
    generatorUnavailable: 'generatorUnavailable',
    secureStorageUnavailable: 'secureStorageUnavailable',
    rotateRateLimited: 'rateLimited',
    editAccessRequired: 'forbidden',
} as const;
type RotateRefusalLeaf = (typeof ROTATE_REFUSALS)[keyof typeof ROTATE_REFUSALS];

/**
 * Lane aw-ops (APW-07 T24, FR-13/FR-15, S6) — **Rotate** a generated value: Ever Works makes a
 * fresh one (a key pair as a pair), and the app picks it up on its next Deployment.
 *
 * Rotating can make data the app encrypted or signed with the old value unreadable, so the member
 * types the name to confirm — the API checks it again (`rotateConfirmationMismatch`). Nothing about
 * the value is ever shown: not the old one, not the new one.
 */
export function AppEnvRotateDialog({ workId, entry, onOpenChange, onRotated }: AppEnvRotateDialogProps) {
    const t = useTranslations('dashboard.workDetail.appDeploy.environment.rotate');
    const inputId = useId();
    const [typed, setTyped] = useState('');
    const [pending, setPending] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const inFlight = useRef(false);
    const matches = typed === entry.name;

    const submit = async () => {
        if (!matches || inFlight.current) return;
        inFlight.current = true;
        setPending(true);
        setMessage(null);
        try {
            const result = await rotateAppEnvAction(workId, entry.name, typed);
            if (result.success && result.data) {
                toast.success(t('rotated', { name: entry.name }));
                onRotated(result.data);
                return;
            }
            if (result.httpStatus === 429) {
                setMessage(t('refusals.rateLimited'));
                return;
            }
            const leaf = result.code
                ? (ROTATE_REFUSALS as Readonly<Record<string, RotateRefusalLeaf>>)[result.code]
                : undefined;
            setMessage(leaf ? t(`refusals.${leaf}`) : t('failed', { reason: result.error ?? result.code ?? '' }));
        } finally {
            inFlight.current = false;
            setPending(false);
        }
    };

    return (
        <Dialog open onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg">
                <DialogClose onClose={() => onOpenChange(false)} />
                <div className="space-y-4" data-testid="app-env-rotate-dialog">
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                            {t('title', { name: entry.name })}
                        </DialogTitle>
                        <DialogDescription>{t('description')}</DialogDescription>
                    </DialogHeader>
                    <p className="rounded border border-amber-300 bg-amber-50/60 p-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-900/10 dark:text-amber-300">
                        {t('warning')}
                    </p>
                    <label htmlFor={inputId} className="block space-y-1 text-sm">
                        <span className="block text-xs text-text-secondary">{t('typeToConfirm', { name: entry.name })}</span>
                        <Input
                            id={inputId}
                            value={typed}
                            autoComplete="off"
                            spellCheck={false}
                            onChange={(event) => setTyped(event.target.value)}
                            data-testid="app-env-rotate-confirm"
                        />
                    </label>
                    {message && (
                        <p className="text-sm text-red-600 dark:text-red-400" role="alert" data-testid="app-env-rotate-error">
                            {message}
                        </p>
                    )}
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            {t('cancel')}
                        </Button>
                        <Button
                            type="button"
                            variant="danger"
                            onClick={() => void submit()}
                            loading={pending}
                            disabled={!matches || pending}
                            data-testid="app-env-rotate-submit"
                        >
                            {t('confirm')}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

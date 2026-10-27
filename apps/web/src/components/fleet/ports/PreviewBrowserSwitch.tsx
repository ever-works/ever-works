'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import type { FleetNodeView } from '@ever-works/contracts';
import { Switch } from '@/components/ui/switch';
import { setFleetNodePreviewProfileAction } from '@/app/actions/settings/fleet';

/**
 * Servers and ports (FL-10, plan §8, FR-12, U8) — the computer Settings tab's
 * **Preview browser** switch (`previewProfileEnabled`, CONTRACTS §4.1):
 * "Lets Open show a page in a browser profile on this computer that no agent
 * uses." Owner only (the platform refuses anyone else); saved through the
 * fleet server action (`PATCH /api/fleet/nodes/:id`) like the star.
 */
export function PreviewBrowserSwitch({ node }: { node: FleetNodeView }) {
    const t = useTranslations('fleet.ports.settings');
    const [enabled, setEnabled] = useState(Boolean(node.previewProfileEnabled));
    const [saving, setSaving] = useState(false);

    const save = async (next: boolean) => {
        setSaving(true);
        setEnabled(next);
        try {
            const result = await setFleetNodePreviewProfileAction(node.id, next);
            if (!result.success) {
                setEnabled(!next);
                toast.error(result.error || t('failed'));
                return;
            }
            toast.success(t('saved'));
        } catch {
            setEnabled(!next);
            toast.error(t('failed'));
        } finally {
            setSaving(false);
        }
    };

    return (
        <section
            className="flex items-start justify-between gap-4"
            data-testid="fleet-preview-browser-switch"
        >
            <div>
                <h3 className="text-sm font-semibold">{t('title')}</h3>
                <p className="text-sm text-text-muted dark:text-text-muted-dark">{t('body')}</p>
            </div>
            <Switch
                checked={enabled}
                disabled={saving}
                onChange={(next) => void save(next)}
                data-testid="fleet-preview-browser-toggle"
            />
        </section>
    );
}

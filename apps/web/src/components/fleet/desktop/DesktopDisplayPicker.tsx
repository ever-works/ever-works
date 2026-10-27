'use client';

import { useTranslations } from 'next-intl';
import type { FleetDisplayView } from '@ever-works/contracts';
import { displaySize } from './desktop.shared';

/**
 * Desktop view & control (FL-07, spec §5.3, FR-10) — the display picker (`M`):
 * every display the machine reported, the primary first, and the note that the
 * choice is remembered for this person on this computer.
 */
export function DesktopDisplayPicker({
    nodeName,
    displays,
    value,
    disabled,
    onChange,
}: {
    nodeName: string;
    displays: readonly FleetDisplayView[];
    value: string | null;
    disabled?: boolean;
    onChange(displayId: string): void;
}) {
    const t = useTranslations('fleet.desktop.displays');
    if (displays.length <= 1) return null;
    return (
        <label className="flex items-center gap-2 text-sm">
            <span className="sr-only">{t('label')}</span>
            <select
                className="rounded-md border border-border bg-background px-2 py-1 text-sm"
                value={value ?? displays[0]?.id ?? ''}
                disabled={disabled}
                aria-keyshortcuts="M"
                title={t('remembered', { name: nodeName })}
                data-testid="desktop-display-picker"
                onChange={(event) => onChange(event.target.value)}
            >
                {displays.map((display, index) => (
                    <option key={display.id} value={display.id}>
                        {t('option', {
                            index: index + 1,
                            name: display.name,
                            size: displaySize(display),
                        })}
                        {display.primary ? ` · ${t('primary')}` : ''}
                        {display.virtual ? ` · ${t('virtual')}` : ''}
                    </option>
                ))}
            </select>
        </label>
    );
}

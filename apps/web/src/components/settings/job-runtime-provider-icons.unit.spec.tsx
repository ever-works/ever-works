// EW-742 — unit spec for the job-runtime provider brand-mark icons.
// Renders each icon to static markup (no DOM needed) and pins the badge
// shape (an <svg> with a brand colour + an accessible label per provider),
// plus the `providerIconMap` / unknown-provider contract.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TenantJobRuntimeProviderId } from '@/lib/api/tenant-job-runtime';
import { ProviderBrandIcon, providerIconMap } from './job-runtime-provider-icons';

const CASES: { id: TenantJobRuntimeProviderId; label: string; color: string }[] = [
    { id: 'trigger', label: 'Trigger.dev', color: '#16171D' },
    { id: 'temporal', label: 'Temporal', color: '#1F6BFF' },
    { id: 'bullmq', label: 'BullMQ', color: '#E11D48' },
    { id: 'pgboss', label: 'pg-boss', color: '#31648C' },
    { id: 'inngest', label: 'Inngest', color: '#6D28D9' },
];

describe('ProviderBrandIcon', () => {
    it.each(CASES)(
        'renders an svg badge for $id with its brand colour + label',
        ({ id, label, color }) => {
            const html = renderToStaticMarkup(<ProviderBrandIcon providerId={id} size={18} />);
            expect(html).toContain('<svg');
            expect(html).toContain(`aria-label="${label}"`);
            expect(html.toLowerCase()).toContain(color.toLowerCase());
            expect(html).toContain('width="18"');
            expect(html).toContain('height="18"');
        },
    );

    it('honours the requested size', () => {
        const html = renderToStaticMarkup(<ProviderBrandIcon providerId="trigger" size={24} />);
        expect(html).toContain('width="24"');
        expect(html).toContain('height="24"');
    });

    it('renders nothing for an unknown provider id', () => {
        const html = renderToStaticMarkup(
            <ProviderBrandIcon providerId={'nope' as TenantJobRuntimeProviderId} />,
        );
        expect(html).toBe('');
    });
});

describe('providerIconMap', () => {
    it('returns an entry for every known provider id', () => {
        const map = providerIconMap();
        expect(Object.keys(map).sort()).toEqual(
            ['bullmq', 'inngest', 'pgboss', 'temporal', 'trigger'].sort(),
        );
    });

    it('each entry renders to an svg badge', () => {
        const map = providerIconMap(16);
        for (const node of Object.values(map)) {
            const html = renderToStaticMarkup(<>{node}</>);
            expect(html).toContain('<svg');
            expect(html).toContain('width="16"');
        }
    });
});

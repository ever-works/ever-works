'use client';

import { useEffect, useState } from 'react';
import { Select } from '@/components/ui/select';
import { fetchClusterSources } from '@/app/actions/plugins';
import type { ClusterSourceOption } from '@/lib/api/plugins-capabilities/deploy';

/**
 * Admin-aware dropdown for the k8s plugin's `clusterSource` setting.
 *
 * The client is never told whether the user is a platform admin (the flag is
 * stripped from the profile response for security), so the allowed options are
 * computed server-side and fetched from `GET /api/deploy/cluster-sources` via
 * the `fetchClusterSources` server action. A non-admin's list never contains
 * the internal `k8s-works` option.
 *
 * Fail-closed: if the endpoint can't be reached, fall back to the non-admin-
 * safe subset (never surfacing `k8s-works`). The authoritative gate is the
 * server-side deploy matrix, so hiding here is purely cosmetic.
 */

// Non-admin-safe fallback — deliberately omits the admin-only `k8s-works`.
const FALLBACK_OPTIONS: readonly ClusterSourceOption[] = [
    { value: 'k8s-works-shared', label: 'Ever Works shared customer cluster' },
    { value: 'custom-kubeconfig', label: 'Custom — paste your own kubeconfig' },
];

// The allowed list is PER-USER (a platform admin sees `k8s-works`; nobody else
// does), so — unlike PluginModelSelect's provider-scoped model list — it must
// NOT be memoised at module scope. Caching across users (or seeding SSR/initial
// render from a module value) could leak one user's list to the next. We fetch
// fresh on each mount, client-side only.
async function loadClusterSources(): Promise<ClusterSourceOption[]> {
    try {
        const response = await fetchClusterSources();
        if (response.success && Array.isArray(response.data) && response.data.length > 0) {
            return response.data;
        }
    } catch {
        // fall through to the fail-closed fallback below
    }
    return [...FALLBACK_OPTIONS];
}

interface K8sClusterSourceSelectProps {
    value: string;
    onChange: (value: string) => void;
    /** Schema default, used when no value is set yet. */
    defaultValue?: string;
}

export function K8sClusterSourceSelect({
    value,
    onChange,
    defaultValue,
}: K8sClusterSourceSelectProps) {
    // Start empty (null) so SSR and the first client render never seed from a
    // module-level value; the client-side effect fetches the per-user list.
    const [options, setOptions] = useState<ClusterSourceOption[] | null>(null);

    useEffect(() => {
        let cancelled = false;
        void loadClusterSources().then((opts) => {
            if (!cancelled) setOptions(opts);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    const loading = options === null;
    const resolved = options ?? [...FALLBACK_OPTIONS];
    const current = String(value ?? defaultValue ?? '') || resolved[0]?.value || '';

    // If the persisted value isn't among the allowed options (e.g. a legacy or
    // now-hidden value), still surface it as an extra row rather than silently
    // switching the user's selection out from under them.
    const hasCurrent = resolved.some((option) => option.value === current);
    const selected = resolved.find((option) => option.value === current);

    return (
        <div className="space-y-1.5">
            <Select
                value={current}
                onValueChange={(v) => onChange(v)}
                disabled={loading}
                data-testid="k8s-cluster-source-select"
            >
                {!hasCurrent && current && <option value={current}>{current}</option>}
                {resolved.map((option) => (
                    <option key={option.value} value={option.value}>
                        {option.label}
                    </option>
                ))}
            </Select>
            {selected?.description && (
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    {selected.description}
                </p>
            )}
        </div>
    );
}

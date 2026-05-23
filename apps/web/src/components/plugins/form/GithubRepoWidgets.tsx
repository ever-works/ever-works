'use client';

/**
 * EW-644 — `github-owner` + `github-repo` widgets for plugin settings.
 *
 * Reuses the same OAuth-backed data layer the Work-creation
 * `RepositorySelector` uses, so the user picks from the orgs/repos
 * they're already connected to via the GitHub plugin's OAuth flow.
 *
 * Two widgets, one file:
 *
 *   - `<GithubOwnerWidget>` — a Select listing the personal account +
 *     every org from `getGitProviderOrganizations('github')`. Persists
 *     the chosen login string.
 *   - `<GithubRepoWidget>` — a Select listing the repos for the
 *     currently-selected owner (read from the sibling `owner` field
 *     via `siblings.get('owner')`). Persists the chosen repo name.
 *
 * Both fail gracefully when the user hasn't completed the GitHub
 * connection flow yet — the existing `RepositorySelector` already
 * surfaces a "connect GitHub" prompt; here we just show a
 * disabled-with-hint state because the plugin settings page can't
 * launch the connect flow inline.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Select } from '@/components/ui/select';
import { getGitProviderOrganizations } from '@/app/actions/dashboard/organizations';
import { getUserRepositories } from '@/app/actions/dashboard/works';

const PROVIDER_ID = 'github';

interface Organization {
    id: string;
    login: string;
    name?: string;
}

interface Repo {
    name: string;
    full_name: string;
    owner: string;
}

interface BaseWidgetProps {
    value: string;
    onChange: (next: string) => void;
    /**
     * Sibling field access from the form renderer. The repo widget
     * reads `owner` from here to know which repos to list; the owner
     * widget never needs to write to siblings but accepts the prop so
     * the renderer can pass it uniformly.
     */
    siblings?: {
        get: (name: string) => unknown;
        set: (name: string, value: unknown) => void;
    };
}

/**
 * Owner select. Loads orgs once on mount; pre-selects the personal
 * account if exactly one connected identity is found.
 */
export function GithubOwnerWidget({ value, onChange }: BaseWidgetProps) {
    const t = useTranslations('dashboard.plugins.settingsField');
    const [orgs, setOrgs] = useState<Organization[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [personalLogin, setPersonalLogin] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            try {
                const result = await getGitProviderOrganizations(PROVIDER_ID);
                if (cancelled) return;
                if (!result.success) {
                    setError(result.error ?? 'Failed to load orgs');
                    setOrgs([]);
                    return;
                }
                // The API splits personal vs. orgs: a single entry with
                // `personal: true` (when present) leads the list. Filter
                // it out for the org list and remember the login.
                const all = result.organizations as Array<Organization & { personal?: boolean }>;
                const personal = all.find((o) => o.personal);
                const realOrgs = all.filter((o) => !o.personal);
                setPersonalLogin(personal?.login ?? null);
                setOrgs(realOrgs);
                // Auto-select on first load when nothing's saved yet:
                // prefer the only connected org if there's exactly one,
                // otherwise the personal account.
                if (!value && !cancelled) {
                    if (realOrgs.length === 1) onChange(realOrgs[0].login);
                    else if (personal?.login) onChange(personal.login);
                }
            } catch (err) {
                if (!cancelled) {
                    setError(err instanceof Error ? err.message : String(err));
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
        // Only run on mount — `value` changes shouldn't refetch.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    if (error) {
        return (
            <div className="text-xs text-warning dark:text-warning-dark">
                {t('githubConnectHint')}
            </div>
        );
    }

    return (
        <Select value={value || ''} onValueChange={(v) => onChange(v)} disabled={loading} size="sm">
            {personalLogin && (
                <option value={personalLogin}>
                    {personalLogin} {t('personalAccount')}
                </option>
            )}
            {orgs.length > 0 && (
                <optgroup label={t('organizations')}>
                    {orgs.map((org) => (
                        <option key={org.id} value={org.login}>
                            {org.login}
                        </option>
                    ))}
                </optgroup>
            )}
        </Select>
    );
}

/**
 * Repo select. Reads the sibling `owner` field; when it changes, fetches
 * the matching repo list. Caches the last (owner, repos) pair so a
 * user toggling between two owners doesn't pay the round-trip again.
 */
export function GithubRepoWidget({ value, onChange, siblings }: BaseWidgetProps) {
    const t = useTranslations('dashboard.plugins.settingsField');
    const owner = useMemo(() => {
        const v = siblings?.get('owner');
        return typeof v === 'string' && v.length > 0 ? v : null;
    }, [siblings]);
    const [repos, setRepos] = useState<Repo[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const cache = useRef<Map<string, Repo[]>>(new Map());
    const lastOwnerRef = useRef<string | null>(null);

    const loadRepos = useCallback(async (forOwner: string) => {
        const cached = cache.current.get(forOwner);
        if (cached) {
            setRepos(cached);
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const result = await getUserRepositories({
                gitProvider: PROVIDER_ID,
                owner: forOwner,
                page: 1,
                perPage: 50,
            });
            if (!result.success || !result.data) {
                setError(result.error ?? 'Failed to load repos');
                setRepos([]);
                return;
            }
            const list = (result.data.repositories ?? []) as Repo[];
            cache.current.set(forOwner, list);
            setRepos(list);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (!owner) {
            setRepos([]);
            return;
        }
        // Owner changed — clear repo selection so we don't keep a stale
        // value referring to a different owner's repo.
        if (lastOwnerRef.current && lastOwnerRef.current !== owner && value) {
            onChange('');
        }
        lastOwnerRef.current = owner;
        void loadRepos(owner);
        // `value` and `onChange` intentionally excluded — we only react
        // to owner changes and clear once per change.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [owner, loadRepos]);

    if (!owner) {
        return (
            <div className="text-xs text-text-muted dark:text-text-muted-dark">
                {t('pickOwnerFirst')}
            </div>
        );
    }

    if (error) {
        return <div className="text-xs text-warning dark:text-warning-dark">{error}</div>;
    }

    return (
        <Select
            value={value || ''}
            onValueChange={(v) => onChange(v)}
            disabled={loading || repos.length === 0}
            size="sm"
        >
            <option value="">{loading ? t('loadingRepos') : t('selectRepo')}</option>
            {repos.map((r) => (
                <option key={r.full_name} value={r.name}>
                    {r.name}
                </option>
            ))}
        </Select>
    );
}

'use client';

import { useEffect, useState, useTransition } from 'react';
import type { Work } from '@/lib/api';
import { toast } from 'sonner';
import { useRouter } from '@/i18n/navigation';
import { getWorkRuntimeEnv, setWorkRuntimeEnv } from '@/app/actions/dashboard/deploy';
import { Database, Lock, Loader2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface RuntimeEnvManagementProps {
    work: Work;
}

/**
 * Per-Work runtime environment surface (Deploy tab).
 *
 * Shows + edits the one piece of deploy runtime env that is user-managed —
 * `DATABASE_URL` (e.g. the site's Postgres/Neon connection) — via the
 * `/deploy/works/:id/runtime-env` API. The value is shown **masked** (host/db
 * only, never the password) and applied on the next deploy. The auto-managed
 * secrets (AUTH_SECRET/COOKIE_SECRET) are listed read-only as "managed by
 * Ever Works" so it's clear what the platform handles vs what the owner sets.
 */
export function RuntimeEnvManagement({ work }: RuntimeEnvManagementProps) {
    return <RuntimeEnvContent key={work.id} work={work} />;
}

function RuntimeEnvContent({ work }: RuntimeEnvManagementProps) {
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    const [databaseUrl, setDatabaseUrl] = useState<{ configured: boolean; masked: string | null } | null>(
        null,
    );
    const [managed, setManaged] = useState<string[]>([]);
    const [value, setValue] = useState('');
    const [loadError, setLoadError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        getWorkRuntimeEnv(work.id).then((result) => {
            if (cancelled) return;
            if (result.success) {
                setDatabaseUrl(result.databaseUrl);
                setManaged(result.managed);
                setLoadError(null);
            } else {
                setDatabaseUrl({ configured: false, masked: null });
                setLoadError(result.error ?? 'Failed to load runtime env');
            }
        });
        return () => {
            cancelled = true;
        };
    }, [work.id]);

    const isLoading = databaseUrl === null;

    const handleSave = () => {
        const next = value.trim();
        if (!next) return;
        startTransition(async () => {
            const result = await setWorkRuntimeEnv(work.id, next);
            if (result.success) {
                setDatabaseUrl(result.databaseUrl);
                setValue('');
                toast.success('DATABASE_URL saved — redeploy to apply it to the live site.');
                router.refresh();
            } else {
                toast.error(result.error ?? 'Failed to save DATABASE_URL');
            }
        });
    };

    return (
        <div className="rounded-lg border border-border bg-card p-4">
            <div className="mb-3 flex items-center gap-2">
                <Database className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">Database &amp; environment</h3>
            </div>

            {isLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                </div>
            ) : (
                <div className="space-y-4">
                    {loadError && <p className="text-sm text-destructive">{loadError}</p>}

                    <div>
                        <label className="mb-1 block text-xs font-medium text-muted-foreground">
                            DATABASE_URL
                        </label>
                        {databaseUrl?.configured ? (
                            <p className="break-all font-mono text-xs text-foreground">
                                {databaseUrl.masked}
                            </p>
                        ) : (
                            <p className="text-xs text-muted-foreground">
                                Not configured — DB-backed features (logins, submissions, favorites)
                                are unavailable on this site until set.
                            </p>
                        )}
                        <div className="mt-2 flex gap-2">
                            <Input
                                type="password"
                                placeholder="postgresql://user:password@host/db"
                                value={value}
                                onChange={(e) => setValue(e.target.value)}
                                disabled={isPending}
                                className="font-mono text-xs"
                            />
                            <Button onClick={handleSave} disabled={isPending || !value.trim()} size="sm">
                                {isPending ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                    <Save className="h-4 w-4" />
                                )}
                                <span className="ml-1">Save</span>
                            </Button>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                            Applied on the next deploy. Stored encrypted; shown masked.
                        </p>
                    </div>

                    {managed.length > 0 && (
                        <div>
                            <div className="mb-1 flex items-center gap-1 text-xs font-medium text-muted-foreground">
                                <Lock className="h-3 w-3" /> Managed by Ever Works
                            </div>
                            <div className="flex flex-wrap gap-1">
                                {managed.map((name) => (
                                    <span
                                        key={name}
                                        className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                                    >
                                        {name}
                                    </span>
                                ))}
                            </div>
                            <p className="mt-1 text-xs text-muted-foreground">
                                Auto-generated and rotated by the platform — not editable.
                            </p>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

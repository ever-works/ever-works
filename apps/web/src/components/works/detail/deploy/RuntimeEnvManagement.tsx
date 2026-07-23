'use client';

import { useEffect, useState, useTransition, type ReactNode } from 'react';
import type { Work } from '@/lib/api';
import { toast } from 'sonner';
import { useRouter } from '@/i18n/navigation';
import {
    getWorkRuntimeEnv,
    setWorkRuntimeEnv,
    testWorkDbConnection,
} from '@/app/actions/dashboard/deploy';
import { CheckCircle2, Database, Loader2, Lock, Save, Server, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface RuntimeEnvManagementProps {
    work: Work;
}

type DbMode = 'shared' | 'custom';

/**
 * Per-Work runtime environment surface (Deploy tab).
 *
 * Lets the owner choose where the site's `DATABASE_URL` comes from:
 *  - **Ever Works DB** (`shared`) — a platform-managed database, provisioned
 *    automatically. Shown only when the shared-DB feature is available.
 *  - **Custom database** (`custom`) — a bring-your-own Postgres connection
 *    string (shown masked, testable before saving).
 * The auto-managed secrets (AUTH_SECRET/COOKIE_SECRET) are listed read-only.
 */
export function RuntimeEnvManagement({ work }: RuntimeEnvManagementProps) {
    return <RuntimeEnvContent key={work.id} work={work} />;
}

function RuntimeEnvContent({ work }: RuntimeEnvManagementProps) {
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    const [databaseUrl, setDatabaseUrl] = useState<{
        configured: boolean;
        masked: string | null;
    } | null>(null);
    const [managed, setManaged] = useState<string[]>([]);
    const [mode, setMode] = useState<DbMode>('custom');
    const [sharedAvailable, setSharedAvailable] = useState(false);
    const [value, setValue] = useState('');
    const [loadError, setLoadError] = useState<string | null>(null);
    const [test, setTest] = useState<{ status: 'idle' | 'ok' | 'fail'; message?: string }>({
        status: 'idle',
    });

    useEffect(() => {
        let cancelled = false;
        getWorkRuntimeEnv(work.id)
            .then((result) => {
                if (cancelled) return;
                setSharedAvailable(result.sharedAvailable ?? false);
                setMode(result.mode ?? 'custom');
                if (result.success) {
                    setDatabaseUrl(result.databaseUrl);
                    setManaged(result.managed);
                    setLoadError(null);
                } else {
                    // Server-reported failure: don't claim "Not configured"
                    // (the value may exist, we just failed to read it) and
                    // disable edits while `loadError` is set.
                    setDatabaseUrl({ configured: false, masked: null });
                    setLoadError(result.error ?? 'Failed to load runtime env');
                }
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                setDatabaseUrl({ configured: false, masked: null });
                setLoadError(err instanceof Error ? err.message : 'Failed to load runtime env');
            });
        return () => {
            cancelled = true;
        };
    }, [work.id]);

    const isLoading = databaseUrl === null;
    const hasLoadError = loadError !== null;

    const apply = (nextMode: DbMode, databaseUrlValue?: string) => {
        startTransition(async () => {
            const result = await setWorkRuntimeEnv(work.id, {
                mode: nextMode,
                databaseUrl: databaseUrlValue,
            });
            if (result.success) {
                setDatabaseUrl(result.databaseUrl);
                if (result.mode) setMode(result.mode);
                if (nextMode === 'custom') setValue('');
                setTest({ status: 'idle' });
                toast.success(
                    nextMode === 'shared'
                        ? 'Switched to the Ever Works DB — redeploy to apply it to the live site.'
                        : 'DATABASE_URL saved — redeploy to apply it to the live site.',
                );
                router.refresh();
            } else {
                toast.error(result.error ?? 'Failed to save database settings');
            }
        });
    };

    const handleTest = () => {
        const next = value.trim();
        if (!next) return;
        setTest({ status: 'idle' });
        startTransition(async () => {
            const result = await testWorkDbConnection(work.id, next);
            setTest(
                result.ok
                    ? { status: 'ok', message: 'Connection succeeded.' }
                    : { status: 'fail', message: result.error ?? 'Connection failed.' },
            );
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

                    {/* Shared vs Custom selector (Ever Works DB only offered when available) */}
                    {sharedAvailable && (
                        <div className="grid grid-cols-2 gap-2">
                            <ModeCard
                                active={mode === 'shared'}
                                disabled={isPending || hasLoadError}
                                onClick={() => setMode('shared')}
                                icon={<Server className="h-4 w-4" />}
                                title="Ever Works DB"
                                subtitle="Managed for you"
                            />
                            <ModeCard
                                active={mode === 'custom'}
                                disabled={isPending || hasLoadError}
                                onClick={() => setMode('custom')}
                                icon={<Database className="h-4 w-4" />}
                                title="Custom DB"
                                subtitle="Bring your own"
                            />
                        </div>
                    )}

                    {mode === 'shared' && sharedAvailable ? (
                        <div>
                            {databaseUrl?.configured ? (
                                <>
                                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                                        Ever Works DB
                                    </label>
                                    <p className="break-all font-mono text-xs text-foreground">
                                        {databaseUrl.masked}
                                    </p>
                                    <p className="mt-1 text-xs text-muted-foreground">
                                        Managed by Ever Works — provisioned automatically for this
                                        Work. No connection details needed.
                                    </p>
                                </>
                            ) : (
                                <>
                                    <p className="text-xs text-muted-foreground">
                                        A dedicated database is provisioned automatically on the Ever
                                        Works DB cluster. No connection details needed.
                                    </p>
                                    <Button
                                        className="mt-2"
                                        size="sm"
                                        disabled={isPending || hasLoadError}
                                        onClick={() => apply('shared')}
                                    >
                                        {isPending ? (
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                        ) : (
                                            <Server className="h-4 w-4" />
                                        )}
                                        <span className="ml-1">Use Ever Works DB</span>
                                    </Button>
                                </>
                            )}
                        </div>
                    ) : (
                        // Custom database — the pre-existing masked value + input + Save,
                        // plus a Test-connection check.
                        <div>
                            <label className="mb-1 block text-xs font-medium text-muted-foreground">
                                DATABASE_URL
                            </label>
                            {databaseUrl?.configured ? (
                                <p className="break-all font-mono text-xs text-foreground">
                                    {databaseUrl.masked}
                                </p>
                            ) : hasLoadError ? (
                                <p className="text-xs text-muted-foreground">
                                    Current value unavailable — retry to view or change it.
                                </p>
                            ) : (
                                <p className="text-xs text-muted-foreground">
                                    Not configured — DB-backed features (logins, submissions,
                                    favorites) are unavailable on this site until set.
                                </p>
                            )}
                            <div className="mt-2 flex gap-2">
                                <Input
                                    type="password"
                                    placeholder="postgresql://user:password@host/db"
                                    value={value}
                                    onChange={(e) => {
                                        setValue(e.target.value);
                                        if (test.status !== 'idle') setTest({ status: 'idle' });
                                    }}
                                    disabled={isPending || hasLoadError}
                                    className="font-mono text-xs"
                                />
                                <Button
                                    variant="outline"
                                    onClick={handleTest}
                                    disabled={isPending || hasLoadError || !value.trim()}
                                    size="sm"
                                >
                                    Test
                                </Button>
                                <Button
                                    onClick={() => apply('custom', value)}
                                    disabled={isPending || hasLoadError || !value.trim()}
                                    size="sm"
                                >
                                    {isPending ? (
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                    ) : (
                                        <Save className="h-4 w-4" />
                                    )}
                                    <span className="ml-1">Save</span>
                                </Button>
                            </div>
                            {test.status === 'ok' && (
                                <p className="mt-1 flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                                    <CheckCircle2 className="h-3 w-3" /> {test.message}
                                </p>
                            )}
                            {test.status === 'fail' && (
                                <p className="mt-1 flex items-center gap-1 break-all text-xs text-destructive">
                                    <XCircle className="h-3 w-3 shrink-0" /> {test.message}
                                </p>
                            )}
                            <p className="mt-1 text-xs text-muted-foreground">
                                Applied on the next deploy. Stored encrypted; shown masked.
                            </p>
                        </div>
                    )}

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
                                Auto-generated by the platform — not editable.
                            </p>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

function ModeCard({
    active,
    disabled,
    onClick,
    icon,
    title,
    subtitle,
}: {
    active: boolean;
    disabled?: boolean;
    onClick: () => void;
    icon: ReactNode;
    title: string;
    subtitle: string;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={`flex items-start gap-2 rounded-md border p-2 text-left transition-colors disabled:opacity-50 ${
                active
                    ? 'border-primary bg-primary/5 ring-1 ring-primary'
                    : 'border-border hover:border-muted-foreground/40'
            }`}
        >
            <span className={active ? 'text-primary' : 'text-muted-foreground'}>{icon}</span>
            <span>
                <span className="block text-xs font-medium text-foreground">{title}</span>
                <span className="block text-[10px] text-muted-foreground">{subtitle}</span>
            </span>
        </button>
    );
}

'use client';

import { useEffect, useState, useTransition, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import type { Work } from '@/lib/api';
import type { RuntimeEnvVarState } from '@/lib/api/plugins-capabilities/deploy';
import { toast } from 'sonner';
import { useRouter } from '@/i18n/navigation';
import {
    getWorkRuntimeEnv,
    setWorkRuntimeEnv,
    setWorkRuntimeEnvVars,
    testWorkDbConnection,
} from '@/app/actions/dashboard/deploy';
import {
    CheckCircle2,
    Database,
    KeyRound,
    Loader2,
    Lock,
    Save,
    Server,
    Trash2,
    XCircle,
} from 'lucide-react';
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
    const [envVars, setEnvVars] = useState<RuntimeEnvVarState[]>([]);
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
                    setEnvVars(result.env ?? []);
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
                        // Shared mode: never show a connection string — the platform
                        // manages it. Just confirm the Work is on the Ever Works DB.
                        <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3">
                            <Server className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                            <div>
                                <p className="text-sm font-medium text-foreground">
                                    You are using the Ever Works DB
                                </p>
                                <p className="mt-0.5 text-xs text-muted-foreground">
                                    A managed database is provisioned automatically for this Work —
                                    no connection details needed. Switch to “Custom DB” above to use
                                    your own.
                                </p>
                                {!databaseUrl?.configured && (
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
                                )}
                            </div>
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
                                    variant="secondary"
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

                    {envVars.length > 0 && (
                        <EnvVarsSection
                            workId={work.id}
                            vars={envVars}
                            disabled={hasLoadError}
                            onChange={setEnvVars}
                        />
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

/**
 * Operator-managed, allow-listed per-Work env vars (Stripe keys & co.).
 *
 * The API returns one masked entry per allow-listed key (`allowedEnvKeys` /
 * `env` on `GET /runtime-env`), so this section renders the whole form from
 * the server's list — no client-side key list to drift. Each row saves via
 * `PUT /runtime-env { env: { KEY: value } }` (merge-patch) and removes via
 * `{ env: { KEY: null } }`. Values are never echoed back: secrets show as
 * `***`, non-secrets as a short prefix.
 */
function EnvVarsSection({
    workId,
    vars,
    disabled,
    onChange,
}: {
    workId: string;
    vars: RuntimeEnvVarState[];
    disabled: boolean;
    onChange: (next: RuntimeEnvVarState[]) => void;
}) {
    const t = useTranslations('dashboard.workDetail.deploy.runtimeEnvVars');
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const [pendingKey, setPendingKey] = useState<string | null>(null);

    const submit = (key: string, value: string | null) => {
        setPendingKey(key);
        startTransition(async () => {
            const result = await setWorkRuntimeEnvVars(workId, { [key]: value });
            setPendingKey(null);
            if (result.success) {
                onChange(result.env);
                setDrafts((prev) => {
                    const next = { ...prev };
                    delete next[key];
                    return next;
                });
                toast.success(value === null ? t('removeSuccess') : t('saveSuccess'));
                router.refresh();
            } else {
                toast.error(result.error ?? (value === null ? t('removeFailed') : t('saveFailed')));
            }
        });
    };

    return (
        <div>
            <div className="mb-1 flex items-center gap-1 text-xs font-medium text-muted-foreground">
                <KeyRound className="h-3 w-3" /> {t('title')}
            </div>
            <p className="text-xs text-muted-foreground">{t('description')}</p>
            <div className="mt-2 space-y-2">
                {vars.map((entry) => {
                    const draft = drafts[entry.key] ?? '';
                    const busy = isPending && pendingKey === entry.key;
                    return (
                        <div key={entry.key}>
                            <label
                                htmlFor={`runtime-env-${entry.key}`}
                                className="mb-1 block font-mono text-[11px] font-medium text-muted-foreground"
                            >
                                {entry.key}
                            </label>
                            <div className="flex gap-2">
                                <Input
                                    id={`runtime-env-${entry.key}`}
                                    type={entry.secret ? 'password' : 'text'}
                                    autoComplete="off"
                                    spellCheck={false}
                                    placeholder={
                                        entry.set
                                            ? (entry.masked ?? t('placeholderSet'))
                                            : t('placeholderUnset')
                                    }
                                    value={draft}
                                    onChange={(e) =>
                                        setDrafts((prev) => ({
                                            ...prev,
                                            [entry.key]: e.target.value,
                                        }))
                                    }
                                    disabled={disabled || isPending}
                                    className="font-mono text-xs"
                                />
                                <Button
                                    onClick={() => submit(entry.key, draft)}
                                    disabled={disabled || isPending || !draft.trim()}
                                    size="sm"
                                    aria-label={t('saveAria', { key: entry.key })}
                                >
                                    {busy ? (
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                    ) : (
                                        <Save className="h-4 w-4" />
                                    )}
                                    <span className="ml-1">{t('saveButton')}</span>
                                </Button>
                                {entry.set && (
                                    <Button
                                        variant="secondary"
                                        onClick={() => submit(entry.key, null)}
                                        disabled={disabled || isPending}
                                        size="sm"
                                        aria-label={t('removeAria', { key: entry.key })}
                                    >
                                        <Trash2 className="h-4 w-4" />
                                        <span className="ml-1">{t('removeButton')}</span>
                                    </Button>
                                )}
                            </div>
                            <p className="mt-0.5 text-[11px] text-muted-foreground">
                                {entry.set
                                    ? entry.secret
                                        ? t('currentSecret')
                                        : t('currentValue', { masked: entry.masked ?? '' })
                                    : t('notSet')}
                            </p>
                        </div>
                    );
                })}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{t('hint')}</p>
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

'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { CheckCircle2, Plug, Plus, Trash2, XCircle } from 'lucide-react';
import {
    createMcpConnectionAction,
    deleteMcpConnectionAction,
    listMcpConnectionsAction,
    testMcpConnectionAction,
    updateMcpConnectionAction,
} from '@/app/actions/mcp-connections';
import type { McpConnection, McpManualTransport } from '@/lib/api/mcp-connections';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

interface Props {
    initial: McpConnection[];
}

interface TestState {
    ok: boolean;
    message: string;
}

/**
 * Agent Plugins MCP slice — Settings → Connections client. Lists manual
 * MCP connections with enable/disable, Test, and Delete; the Add form
 * takes name / url / transport / one auth header (name + value). Header
 * VALUES are write-only: the API returns names only.
 */
export function McpConnectionsClient({ initial }: Props) {
    const t = useTranslations('dashboard.settings.connections');
    const [rows, setRows] = useState(initial);
    const [showForm, setShowForm] = useState(false);
    const [pending, startTransition] = useTransition();
    const [busyId, setBusyId] = useState<string | null>(null);
    const [testResults, setTestResults] = useState<Record<string, TestState>>({});
    const [formError, setFormError] = useState<string | null>(null);

    const [name, setName] = useState('');
    const [url, setUrl] = useState('');
    const [transport, setTransport] = useState<McpManualTransport>('streamable-http');
    const [headerName, setHeaderName] = useState('');
    const [headerValue, setHeaderValue] = useState('');

    const refresh = async () => {
        const next = await listMcpConnectionsAction();
        setRows(next.data);
    };

    const submit = () => {
        setFormError(null);
        startTransition(() => {
            void (async () => {
                try {
                    const authHeaders =
                        headerName.trim().length > 0 && headerValue.length > 0
                            ? { [headerName.trim()]: headerValue }
                            : undefined;
                    await createMcpConnectionAction({
                        name: name.trim(),
                        url: url.trim(),
                        transport,
                        authHeaders,
                    });
                    setName('');
                    setUrl('');
                    setHeaderName('');
                    setHeaderValue('');
                    setShowForm(false);
                    await refresh();
                } catch (err) {
                    setFormError(err instanceof Error ? err.message : String(err));
                }
            })();
        });
    };

    const toggleEnabled = (row: McpConnection) => {
        setBusyId(row.id);
        startTransition(() => {
            void (async () => {
                try {
                    await updateMcpConnectionAction(row.id, { enabled: !row.enabled });
                    await refresh();
                } finally {
                    setBusyId(null);
                }
            })();
        });
    };

    const runTest = (row: McpConnection) => {
        setBusyId(row.id);
        startTransition(() => {
            void (async () => {
                try {
                    const result = await testMcpConnectionAction(row.id);
                    setTestResults((prev) => ({
                        ...prev,
                        [row.id]: result.ok
                            ? {
                                  ok: true,
                                  message: t('testOk', {
                                      count: result.toolCount,
                                      tools: result.tools.slice(0, 5).join(', '),
                                  }),
                              }
                            : { ok: false, message: result.error ?? t('testFailed') },
                    }));
                    await refresh();
                } finally {
                    setBusyId(null);
                }
            })();
        });
    };

    const remove = (row: McpConnection) => {
        setBusyId(row.id);
        startTransition(() => {
            void (async () => {
                try {
                    await deleteMcpConnectionAction(row.id);
                    await refresh();
                } finally {
                    setBusyId(null);
                }
            })();
        });
    };

    return (
        <div className="space-y-4">
            <header className="flex items-center justify-between">
                <div>
                    <h2 className="text-base font-medium text-text dark:text-text-dark">
                        {t('title')}
                    </h2>
                    <p className="mt-0.5 text-xs text-text-muted dark:text-text-muted-dark">
                        {t('subtitle')}
                    </p>
                </div>
                <Button size="sm" onClick={() => setShowForm((v) => !v)} className="gap-1.5">
                    <Plus className="w-3.5 h-3.5" />
                    {t('addConnection')}
                </Button>
            </header>

            {showForm && (
                <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-4 space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <Input
                            label={t('form.name')}
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="github"
                            helperText={t('form.nameHelp')}
                        />
                        <div>
                            <label className="block text-sm mb-1 text-text dark:text-text-dark">
                                {t('form.transport')}
                            </label>
                            <select
                                value={transport}
                                onChange={(e) => setTransport(e.target.value as McpManualTransport)}
                                className="w-full h-10 rounded-lg border border-border dark:border-border-dark bg-transparent px-3 text-sm text-text dark:text-text-dark"
                            >
                                <option value="streamable-http">{t('form.streamableHttp')}</option>
                                <option value="sse">{t('form.sse')}</option>
                            </select>
                        </div>
                    </div>
                    <Input
                        label={t('form.url')}
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                        placeholder="https://mcp.example.com/mcp"
                    />
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <Input
                            label={t('form.headerName')}
                            value={headerName}
                            onChange={(e) => setHeaderName(e.target.value)}
                            placeholder="Authorization"
                        />
                        <Input
                            label={t('form.headerValue')}
                            type="password"
                            value={headerValue}
                            onChange={(e) => setHeaderValue(e.target.value)}
                            placeholder="Bearer …"
                            helperText={t('form.headerValueHelp')}
                        />
                    </div>
                    {formError && <p className="text-xs text-danger">{formError}</p>}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>
                            {t('form.cancel')}
                        </Button>
                        <Button
                            size="sm"
                            onClick={submit}
                            disabled={
                                pending || name.trim().length === 0 || url.trim().length === 0
                            }
                        >
                            {t('form.save')}
                        </Button>
                    </div>
                </section>
            )}

            <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark divide-y divide-border/40 dark:divide-border-dark/40">
                {rows.length === 0 ? (
                    <div className="p-6 text-center text-xs text-text-muted dark:text-text-muted-dark">
                        {t('empty')}
                    </div>
                ) : (
                    rows.map((row) => {
                        const test = testResults[row.id];
                        return (
                            <article key={row.id} className="p-4 flex items-start gap-3">
                                <Plug className="w-4 h-4 mt-0.5 text-primary shrink-0" />
                                <div className="min-w-0 flex-1">
                                    <div className="text-sm text-text dark:text-text-dark truncate">
                                        {row.name}{' '}
                                        <span className="text-text-muted dark:text-text-muted-dark text-xs font-mono">
                                            {row.transport}
                                        </span>
                                    </div>
                                    <div className="mt-0.5 text-[11px] font-mono text-text-muted dark:text-text-muted-dark truncate">
                                        {row.url}
                                    </div>
                                    <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-text-muted dark:text-text-muted-dark">
                                        {row.authHeaderNames.length > 0 && (
                                            <span>
                                                {t('authHeaders')}: {row.authHeaderNames.join(', ')}
                                            </span>
                                        )}
                                        {row.lastConnectedAt && (
                                            <span className="inline-flex items-center gap-1 text-success">
                                                <CheckCircle2 className="w-3 h-3" />
                                                {t('lastConnected', {
                                                    date: new Date(
                                                        row.lastConnectedAt,
                                                    ).toLocaleString(),
                                                })}
                                            </span>
                                        )}
                                        {row.lastError && (
                                            <span className="inline-flex items-center gap-1 text-danger">
                                                <XCircle className="w-3 h-3" />
                                                {row.lastError}
                                            </span>
                                        )}
                                    </div>
                                    {test && (
                                        <p
                                            className={
                                                test.ok
                                                    ? 'mt-1 text-[11px] text-success'
                                                    : 'mt-1 text-[11px] text-danger'
                                            }
                                        >
                                            {test.message}
                                        </p>
                                    )}
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                    <Switch
                                        checked={row.enabled}
                                        disabled={pending && busyId === row.id}
                                        onChange={() => toggleEnabled(row)}
                                        data-testid={`mcp-connection-toggle-${row.name}`}
                                    />
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => runTest(row)}
                                        disabled={pending && busyId === row.id}
                                    >
                                        {pending && busyId === row.id ? '…' : t('test')}
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => remove(row)}
                                        disabled={pending && busyId === row.id}
                                        className="text-danger hover:text-danger gap-1"
                                        title={t('delete')}
                                    >
                                        <Trash2 className="w-3.5 h-3.5" />
                                    </Button>
                                </div>
                            </article>
                        );
                    })
                )}
            </section>
        </div>
    );
}

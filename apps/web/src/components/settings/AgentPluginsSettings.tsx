'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Boxes, FileWarning, Info, Package, Plug, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import type {
    AgentPluginFinding,
    AgentPluginFindingSeverity,
    AgentPluginListResponse,
    AgentPluginPackageRow,
    AgentPluginRejectedRow,
} from '@/lib/api/agent-plugins';

/**
 * Settings → Agent Plugins.
 *
 * Renders installed packages in the open Agent Plugins v1.0.0 format, with
 * their findings shown PER COMPONENT rather than as one undifferentiated
 * list. That split is the point of the page: the specification isolates
 * failure per component, so a package whose `mcp.json` is invalid still
 * contributes its skills. A flat error list would make such a package look
 * broken when most of it works, and would give the operator no way to tell
 * which half to fix.
 */

interface Props {
    data: AgentPluginListResponse;
    /** True when the API call itself failed, as opposed to returning nothing. */
    loadFailed?: boolean;
}

const SEVERITY_ORDER: Record<AgentPluginFindingSeverity, number> = {
    fatal: 0,
    error: 1,
    warning: 2,
};

function severityClass(severity: AgentPluginFindingSeverity): string {
    if (severity === 'fatal') return 'text-red-600 dark:text-red-400';
    if (severity === 'error') return 'text-amber-600 dark:text-amber-400';
    return 'text-muted-foreground';
}

/**
 * Group findings by the component they belong to.
 *
 * `scope` is optional on the wire, so anything without one lands in
 * `package` rather than being dropped — a finding that is not displayed is
 * indistinguishable from one that was never produced.
 */
function groupByScope(findings: AgentPluginFinding[]): Map<string, AgentPluginFinding[]> {
    const grouped = new Map<string, AgentPluginFinding[]>();
    for (const finding of findings) {
        const scope = finding.scope ?? 'package';
        const list = grouped.get(scope) ?? [];
        list.push(finding);
        grouped.set(scope, list);
    }
    for (const list of grouped.values()) {
        list.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
    }
    return grouped;
}

/**
 * Scopes that have a translated label. Anything else is displayed verbatim.
 *
 * next-intl THROWS on a missing key rather than falling back, so an
 * unrecognised scope — a new one added by the conformance library, say —
 * would blank the whole page. Checking membership first turns that into a
 * slightly less pretty label.
 */
const TRANSLATED_SCOPES = new Set(['package', 'manifest', 'skills', 'mcp']);

function FindingList({ findings }: { findings: AgentPluginFinding[] }) {
    const t = useTranslations('dashboard.settings.agentPlugins');
    const grouped = useMemo(() => groupByScope(findings), [findings]);

    if (findings.length === 0) return null;

    return (
        <div className="mt-3 space-y-3">
            {[...grouped.entries()].map(([scope, list]) => (
                <div key={scope} className="rounded-md border border-border/60 p-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {TRANSLATED_SCOPES.has(scope)
                            ? t(`scopes.${scope}` as 'scopes.package')
                            : scope}
                    </p>
                    <ul className="mt-2 space-y-1.5">
                        {list.map((finding, index) => (
                            <li key={`${finding.code}-${index}`} className="text-sm">
                                <span className={`font-medium ${severityClass(finding.severity)}`}>
                                    {t(`severity.${finding.severity}`)}
                                </span>
                                <span className="mx-1.5 text-muted-foreground">·</span>
                                <span>{finding.message}</span>
                                {finding.subject ? (
                                    <span className="ml-1.5 text-muted-foreground">
                                        ({finding.subject})
                                    </span>
                                ) : null}
                                <div className="text-xs text-muted-foreground">{finding.code}</div>
                            </li>
                        ))}
                    </ul>
                </div>
            ))}
        </div>
    );
}

function PackageCard({ pkg }: { pkg: AgentPluginPackageRow }) {
    const t = useTranslations('dashboard.settings.agentPlugins');

    return (
        <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <Package className="size-4 shrink-0 self-center text-muted-foreground" />
                <h3 className="font-medium">{pkg.name ?? pkg.dirName}</h3>
                {pkg.version ? (
                    <span className="text-sm text-muted-foreground">{pkg.version}</span>
                ) : null}
                {pkg.specVersion ? (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        {t('specVersion', { version: pkg.specVersion })}
                    </span>
                ) : null}
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                    <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        <Boxes className="size-3.5" />
                        {t('skills', { count: pkg.skills.length })}
                    </p>
                    <p className="mt-1 text-sm">
                        {pkg.skills.length > 0 ? pkg.skills.join(', ') : t('none')}
                    </p>
                </div>
                <div>
                    <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        <Plug className="size-3.5" />
                        {t('mcpServers', { count: pkg.mcpServers.length })}
                    </p>
                    <p className="mt-1 text-sm">
                        {pkg.mcpServers.length > 0 ? pkg.mcpServers.join(', ') : t('none')}
                    </p>
                </div>
            </div>

            <FindingList findings={pkg.findings ?? []} />
        </div>
    );
}

function RejectedCard({ pkg }: { pkg: AgentPluginRejectedRow }) {
    const t = useTranslations('dashboard.settings.agentPlugins');

    return (
        <div className="rounded-lg border border-red-500/40 bg-red-500/5 p-4">
            <div className="flex items-center gap-2">
                <AlertTriangle className="size-4 shrink-0 text-red-600 dark:text-red-400" />
                <h3 className="font-medium">{pkg.dirName}</h3>
                <span className="text-xs text-red-600 dark:text-red-400">{t('rejected')}</span>
            </div>
            {/* Rejected packages are shown rather than hidden: somebody put
                this directory there deliberately, so its absence from the
                catalog needs an explanation. */}
            <p className="mt-1 text-sm text-muted-foreground">{t('rejectedHelp')}</p>
            <FindingList findings={pkg.findings ?? []} />
        </div>
    );
}

export function AgentPluginsSettings({ data, loadFailed }: Props) {
    const t = useTranslations('dashboard.settings.agentPlugins');
    const [query, setQuery] = useState('');

    const packages = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (!needle) return data.packages;
        return data.packages.filter(
            (pkg) =>
                pkg.name?.toLowerCase().includes(needle) ||
                pkg.skills.some((skill) => skill.toLowerCase().includes(needle)),
        );
    }, [data.packages, query]);

    if (loadFailed) {
        return (
            <div className="rounded-lg border border-border bg-card p-6">
                <h2 className="font-medium">{t('title')}</h2>
                <p className="mt-2 text-sm text-muted-foreground">{t('loadFailed')}</p>
            </div>
        );
    }

    // "Off" and "on with nothing installed" render identically without this,
    // so an operator who has just flipped the flag cannot tell which state
    // they are looking at.
    if (!data.enabled) {
        return (
            <div className="rounded-lg border border-border bg-card p-6">
                <h2 className="font-medium">{t('title')}</h2>
                <p className="mt-2 text-sm text-muted-foreground">{t('disabled')}</p>
                <code className="mt-3 inline-block rounded bg-muted px-2 py-1 text-xs">
                    FEATURE_AGENT_PLUGINS=true
                </code>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-lg font-medium">{t('title')}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
            </div>

            {data.roots.length > 0 ? (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Info className="size-3.5" />
                    {t('scanning', { roots: data.roots.join(', ') })}
                </p>
            ) : null}

            <div className="relative">
                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t('searchPlaceholder')}
                    className="pl-9"
                    aria-label={t('searchPlaceholder')}
                />
            </div>

            {packages.length === 0 && data.rejected.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border p-8 text-center">
                    <p className="text-sm text-muted-foreground">
                        {query ? t('noMatches') : t('empty')}
                    </p>
                </div>
            ) : null}

            <div className="space-y-3">
                {packages.map((pkg) => (
                    <PackageCard key={pkg.path ?? pkg.dirName ?? pkg.name} pkg={pkg} />
                ))}
            </div>

            {data.rejected.length > 0 ? (
                <div className="space-y-3">
                    <h3 className="flex items-center gap-1.5 text-sm font-medium">
                        <FileWarning className="size-4" />
                        {t('rejectedHeading', { count: data.rejected.length })}
                    </h3>
                    {data.rejected.map((pkg) => (
                        <RejectedCard key={pkg.path ?? pkg.dirName} pkg={pkg} />
                    ))}
                </div>
            ) : null}

            {data.shadowed.length > 0 ? (
                <div className="rounded-lg border border-border/60 p-4">
                    <h3 className="text-sm font-medium">{t('shadowedHeading')}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">{t('shadowedHelp')}</p>
                    <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                        {data.shadowed.map((pkg) => (
                            <li key={pkg.dirName}>
                                {pkg.dirName} — {pkg.name}
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}
        </div>
    );
}

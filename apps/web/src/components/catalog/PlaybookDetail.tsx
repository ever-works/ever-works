import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Flag, Info } from 'lucide-react';
import type {
    PlaybookArtefactKind,
    PlaybookCaps,
    PlaybookDetailResponse,
    PlaybookGuardrails,
} from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { getCategoryLabel } from '@/lib/utils/plugin-category-icons';
import { PlaybookIcon } from './PlaybookCard';
import { ReadinessChip } from './ReadinessChip';

const ARTEFACT_KEYS = {
    kb_document: 'kbDocument',
    mission: 'mission',
    task: 'task',
    email_draft: 'emailDraft',
    run_receipt: 'runReceipt',
} as const satisfies Record<PlaybookArtefactKind, string>;

const ACTION_TYPE_KEYS = {
    spawn_agent: 'spawnAgent',
    schedule_task: 'scheduleTask',
    send_message: 'sendMessage',
    budget_override: 'budgetOverride',
    merge_pull_request: 'mergePullRequest',
    other: 'other',
} as const;

const CAP_KEYS = [
    'maxPerRun',
    'maxSourcesTracked',
    'maxWordCount',
    'maxDecisionsPerRun',
] as const satisfies readonly (keyof PlaybookCaps)[];

/** The link that takes a person to the existing Plugins page, pre-searched for a capability. */
export function connectHref(capability: string): string {
    return `${ROUTES.DASHBOARD_PLUGINS}?q=${encodeURIComponent(getCategoryLabel(capability))}`;
}

function Block({ label, children }: { label: string; children: ReactNode }) {
    return (
        <section className="grid gap-2 border-t border-border dark:border-border-dark py-4 md:grid-cols-[14rem_1fr]">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-text-muted dark:text-text-muted-dark">
                {label}
            </h2>
            <div className="space-y-2 text-sm text-text dark:text-text-dark">{children}</div>
        </section>
    );
}

/**
 * One playbook in full: its readiness for this workspace and the eight
 * labelled blocks a person needs to judge it before setting anything up.
 * Playbook text is provider-supplied content, rendered as written and marked
 * with its language.
 */
export function PlaybookDetail({ detail }: { detail: PlaybookDetailResponse }) {
    const t = useTranslations('dashboard.catalogPage');
    const { entry, readiness } = detail;
    const actionLabel = (type: string) =>
        type in ACTION_TYPE_KEYS
            ? t(`detail.actionTypes.${ACTION_TYPE_KEYS[type as keyof typeof ACTION_TYPE_KEYS]}`)
            : type;
    const actionList = (
        guardrails: PlaybookGuardrails | undefined,
        key: 'blockedActionTypes' | 'autoApproveActionTypes',
    ) => (guardrails?.[key] ?? []).map(actionLabel).join(', ');
    const required = readiness.connections.filter((status) => status.required);
    const optional = readiness.connections.filter((status) => !status.required);
    const caps = CAP_KEYS.filter((key) => typeof entry.caps[key] === 'number');
    const never = actionList(entry.provision.guardrailsAtAdoption, 'blockedActionTypes');
    const graduated = actionList(entry.provision.graduatedGuardrails, 'autoApproveActionTypes');

    const readinessLine =
        readiness.state === 'needs_connection'
            ? t('detail.notReadyLine', { count: readiness.missingRequired.length })
            : readiness.state === 'blocked'
              ? t('detail.blockedLine')
              : readiness.state === 'adopted'
                ? t('detail.adoptedLine')
                : t('detail.readyLine');

    return (
        <article data-testid="playbook-detail" data-slug={entry.slug} className="space-y-6">
            <Link
                href={ROUTES.DASHBOARD_CATALOG}
                className="text-xs text-text-muted hover:text-text"
            >
                ← {t('detail.back')}
            </Link>

            <header className="flex items-start gap-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <PlaybookIcon icon={entry.icon} category={entry.category} className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <h1
                            lang="en"
                            className="text-2xl font-semibold text-text dark:text-text-dark"
                        >
                            {entry.title}
                        </h1>
                        <span className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t(`categories.${entry.category}`)} ·{' '}
                            {t('detail.version', { version: entry.version })}
                        </span>
                    </div>
                    <p
                        lang="en"
                        className="text-sm text-text-secondary dark:text-text-secondary-dark"
                    >
                        {entry.outcome}
                    </p>
                    {entry.summary && (
                        <p
                            lang="en"
                            className="max-w-3xl text-sm text-text-secondary dark:text-text-secondary-dark"
                        >
                            {entry.summary}
                        </p>
                    )}
                </div>
            </header>

            <section
                aria-labelledby="playbook-readiness"
                data-testid="playbook-readiness"
                data-state={readiness.state}
                className="space-y-3 rounded-lg border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-4"
            >
                <div className="flex flex-wrap items-center gap-2">
                    <h2 id="playbook-readiness" className="text-sm font-semibold">
                        {t('detail.readinessHeading')}
                    </h2>
                    <ReadinessChip
                        state={readiness.state}
                        missingCount={readiness.missingRequired.length}
                    />
                </div>
                <p className="text-sm">{readinessLine}</p>
                {readiness.unknown.length > 0 && (
                    <p className="flex items-center gap-2 text-xs text-text-muted">
                        <Info className="h-3 w-3" aria-hidden="true" />
                        {t('detail.uncheckedLine')}
                    </p>
                )}
                {readiness.connections.length === 0 && (
                    <p className="text-xs text-text-muted">{t('detail.noConnections')}</p>
                )}
                {readiness.connections.length > 0 && (
                    <ul className="space-y-2">
                        {[...required, ...optional].map((status) => (
                            <li
                                key={status.capability}
                                data-testid="playbook-connection"
                                data-capability={status.capability}
                                data-satisfied={status.satisfiedBy ? 'true' : 'false'}
                                className="flex flex-wrap items-start justify-between gap-2 text-sm"
                            >
                                <div className="min-w-0">
                                    <p className="font-medium">
                                        {!status.required && (
                                            <span className="mr-1 text-xs font-normal text-text-muted">
                                                {t('detail.optional')}:
                                            </span>
                                        )}
                                        {getCategoryLabel(status.capability)}
                                        <span className="ml-2 text-xs font-normal text-text-muted">
                                            {status.satisfiedBy
                                                ? t('detail.providedBy', {
                                                      name: status.satisfiedBy.name,
                                                  })
                                                : t('detail.nothingProvides')}
                                        </span>
                                    </p>
                                    <p
                                        lang="en"
                                        className="text-xs text-text-secondary dark:text-text-secondary-dark"
                                    >
                                        {status.required
                                            ? status.reason
                                            : (status.degradedWithout ?? status.reason)}
                                    </p>
                                </div>
                                {!status.satisfiedBy && (
                                    <Link
                                        href={connectHref(status.capability)}
                                        className="text-xs font-medium text-primary hover:underline"
                                    >
                                        {t('detail.connectAction', {
                                            capability: getCategoryLabel(status.capability),
                                        })}{' '}
                                        →
                                    </Link>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            <div>
                <Block label={t('detail.whenItRuns')}>
                    <p lang="en">{entry.trigger.description}</p>
                </Block>
                <Block label={t('detail.whatItCosts')}>
                    <p title={t('cost.tooltip')}>
                        {t(`cost.${entry.costBand}`)} ·{' '}
                        {t('detail.tokenRange', {
                            min: entry.estimatedTokensPerRun.min,
                            max: entry.estimatedTokensPerRun.max,
                        })}
                    </p>
                </Block>
                <Block label={t('detail.theSteps')}>
                    <ol className="space-y-2" data-testid="playbook-steps">
                        {entry.steps.map((step) => (
                            <li key={step.position} className="flex gap-3">
                                <span className="w-5 shrink-0 text-right tabular-nums text-text-muted">
                                    {step.position}
                                </span>
                                <div className="min-w-0">
                                    <p className="font-medium">
                                        <span lang="en">{step.title}</span>
                                        {step.requiresApproval && (
                                            <span
                                                data-testid="step-asks-you"
                                                className="ml-2 inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning"
                                            >
                                                <Flag className="h-3 w-3" aria-hidden="true" />
                                                {t('detail.asksYouFlag')}
                                            </span>
                                        )}
                                    </p>
                                    <p
                                        lang="en"
                                        className="text-xs text-text-secondary dark:text-text-secondary-dark"
                                    >
                                        {step.produces}
                                    </p>
                                </div>
                            </li>
                        ))}
                    </ol>
                </Block>
                <Block label={t('detail.whatItProduces')}>
                    <ul className="space-y-1">
                        {entry.artefacts.map((artefact) => (
                            <li key={`${artefact.kind}-${artefact.title}`}>
                                <span className="font-medium">
                                    {t(`detail.artefactKinds.${ARTEFACT_KEYS[artefact.kind]}`)}
                                </span>
                                {' — '}
                                <span lang="en">
                                    {artefact.title}, {artefact.where}
                                </span>
                            </li>
                        ))}
                    </ul>
                </Block>
                <Block label={t('detail.whenItAsks')}>
                    <ul className="space-y-1">
                        {entry.escalations.map((point) => (
                            <li key={point.when}>
                                <span lang="en">{point.when}</span>
                                <span className="block text-xs text-text-muted">
                                    {point.becomes === 'approval'
                                        ? t('detail.becomesApproval')
                                        : t('detail.becomesEscalation')}
                                    {point.carriesRecommendation &&
                                        `, ${t('detail.withRecommendation')}`}
                                </span>
                            </li>
                        ))}
                    </ul>
                </Block>
                <Block label={t('detail.itsOwnLimits')}>
                    {caps.length === 0 ? (
                        <p>{t('detail.noCaps')}</p>
                    ) : (
                        <p>
                            {caps
                                .map((key) =>
                                    t(`detail.caps.${key}`, { count: entry.caps[key] ?? 0 }),
                                )
                                .join(' · ')}
                        </p>
                    )}
                </Block>
                <Block label={t('detail.whatItMayDoAlone')}>
                    <p>{t('detail.alwaysAsks')}</p>
                    {never && (
                        <p className="text-xs text-text-muted">
                            {t('detail.neverDoes', { actions: never })}
                        </p>
                    )}
                    {graduated && (
                        <p className="text-xs text-text-muted">
                            {t('detail.canGraduate', { actions: graduated })}
                        </p>
                    )}
                </Block>
            </div>

            <footer className="flex flex-wrap items-center gap-3 border-t border-border dark:border-border-dark pt-4">
                <Link
                    href={ROUTES.DASHBOARD_AGENT_NEW}
                    data-testid="playbook-primary-action"
                    className="rounded-md bg-button-primary dark:bg-white px-4 py-2 text-sm font-medium text-button-primary-foreground dark:text-gray-900"
                >
                    {t('detail.buildItYourself')}
                </Link>
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    {t('detail.buildItYourselfHint')}
                </p>
            </footer>
            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                {t('detail.providedContentNote')}
            </p>
        </article>
    );
}

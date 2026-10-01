'use client';

import { Fragment, useId, useState, useTransition } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { disableEverId, enableEverId, testEverIdConnection } from '@/app/actions/ever-id';
import { Button } from '@/components/ui/button';
import type {
    EverIdAdminHealth,
    EverIdAdminStatus,
    EverIdCheck,
    EverIdSettingSource,
} from '@/lib/api/ever-id';
import { EVER_ID_CHECK_IDS } from '@/lib/auth/ever-id';
import { EverIdAdminSettingsForm } from './ever-id-admin-settings-form';

interface EverIdAdminClientProps {
    initialStatus: EverIdAdminStatus;
    /** `null` when the health endpoint could not be read. */
    initialHealth: EverIdAdminHealth | null;
}

/**
 * The label of each FR-2 setting, keyed by the name the status reports it under
 * (`missing` and the value sources use the plugin's setting names; the contract
 * spells two of them differently, and both spellings get the same label).
 */
const FIELD_LABELS = {
    issuer: 'issuer',
    issuerUrl: 'issuer',
    clientId: 'clientId',
    clientSecret: 'clientSecret',
    allowedIssuers: 'allowedIssuers',
    apiAudience: 'apiAudience',
    localClientIds: 'localClientIds',
    localClients: 'localClients',
    delegatedClientNames: 'delegatedClientNames',
    accountManagementUrl: 'accountManagementUrl',
    signUpAllowed: 'signUpAllowed',
    clockSkewSeconds: 'clockSkewSeconds',
    displayName: 'displayName',
} as const;

type FieldKey = keyof typeof FIELD_LABELS;

const SOURCE_KEYS: readonly EverIdSettingSource[] = ['admin', 'env', 'default', 'unset'];

function isFieldKey(value: string): value is FieldKey {
    return Object.prototype.hasOwnProperty.call(FIELD_LABELS, value);
}

function isSourceKey(value: unknown): value is EverIdSettingSource {
    return typeof value === 'string' && (SOURCE_KEYS as readonly string[]).includes(value);
}

function toDate(value: string | null | undefined): Date | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The Ever ID administrator surface (spec §6.7): the status block (on/off,
 * whether the configuration is complete and what is missing, the issuer, the
 * client secret only ever as `•••••• (set)`, where each value comes from), the
 * settings form for the administrator-managed values, **Test connection** with
 * one row per FR-3 check, **Health**, and Turn on / Turn off. Turning on runs the
 * connection test first; a failed required check keeps Ever ID off and its rows
 * are shown. Every action answers the new status, and the page re-renders from it.
 *
 * Every state is named in text and with a ✓/✗ glyph, never by colour alone, and
 * results and errors are announced (FR-52). `Tab` follows the visual order.
 */
export function EverIdAdminClient({ initialStatus, initialHealth }: EverIdAdminClientProps) {
    const t = useTranslations('dashboard.settings.admin.everId');
    const format = useFormatter();
    const statusHeadingId = useId();
    const sourcesHeadingId = useId();
    const testHeadingId = useId();
    const healthHeadingId = useId();

    const [status, setStatus] = useState(initialStatus);
    const [checks, setChecks] = useState<EverIdCheck[] | null>(null);
    const [testError, setTestError] = useState<string | null>(null);
    const [toggleError, setToggleError] = useState<string | null>(null);
    const [isTesting, startTest] = useTransition();
    const [isToggling, startToggle] = useTransition();

    const fieldLabel = (field: string): string =>
        isFieldKey(field) ? t(`fields.${FIELD_LABELS[field]}`) : field;

    const formatDateTime = (value: string): string => {
        const date = toDate(value);
        return date ? format.dateTime(date, { dateStyle: 'medium', timeStyle: 'short' }) : value;
    };

    const formatAgo = (value: string): string => {
        const date = toDate(value);
        return date ? format.relativeTime(date) : value;
    };

    const runTest = () => {
        setTestError(null);
        startTest(async () => {
            const result = await testEverIdConnection();
            if (result.success) {
                setChecks(result.checks);
            } else {
                setChecks(null);
                setTestError(result.error);
            }
        });
    };

    const toggle = () => {
        setToggleError(null);
        startToggle(async () => {
            const result = status.enabled ? await disableEverId() : await enableEverId();
            if (result.success) {
                setStatus(result.status);
                toast.success(result.status.enabled ? t('enabledToast') : t('disabledToast'));
                return;
            }
            setToggleError(result.error);
            if (result.checks && result.checks.length > 0) {
                setChecks(result.checks);
            }
        });
    };

    const checkResults = new Map((checks ?? []).map((check) => [check.id, check.ok]));
    const sources = Object.entries(status.settingSources ?? {}).filter(([, source]) =>
        isSourceKey(source),
    ) as Array<[string, EverIdSettingSource]>;

    const healthRows: Array<{ id: string; text: string }> = initialHealth
        ? [
              {
                  id: 'discovery',
                  text: initialHealth.discoveryRefreshedAt
                      ? t('health.discovery', {
                            ago: formatAgo(initialHealth.discoveryRefreshedAt),
                        })
                      : t('health.discoveryNever'),
              },
              {
                  id: 'jwks',
                  text: initialHealth.jwksRefreshedAt
                      ? t('health.jwks', { ago: formatAgo(initialHealth.jwksRefreshedAt) })
                      : t('health.jwksNever'),
              },
              {
                  id: 'logoutNotice',
                  text: initialHealth.lastLogoutNoticeAt
                      ? t('health.logoutNotice', {
                            ago: formatAgo(initialHealth.lastLogoutNoticeAt),
                        })
                      : t('health.logoutNoticeNever'),
              },
          ]
        : [];

    return (
        <div className="space-y-8" data-testid="ever-id-admin">
            <div>
                <h2 className="text-xl font-semibold text-text dark:text-text-dark mb-2">
                    {t('title')}
                </h2>
                <p className="text-text-muted dark:text-text-muted-dark text-sm">{t('subtitle')}</p>
            </div>

            <section aria-labelledby={statusHeadingId} className="space-y-3">
                <h3
                    id={statusHeadingId}
                    className="text-lg font-medium text-text dark:text-text-dark"
                >
                    {t('status.title')}
                </h3>
                <dl
                    data-testid="ever-id-admin-status"
                    className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[minmax(0,16rem)_1fr]"
                >
                    <dt className="text-text-muted dark:text-text-muted-dark">
                        {t('status.state')}
                    </dt>
                    <dd
                        data-testid="ever-id-admin-state"
                        className="flex items-baseline gap-2 font-medium text-text dark:text-text-dark"
                    >
                        <span
                            aria-hidden="true"
                            className={status.enabled ? 'text-success' : 'text-text-muted'}
                        >
                            {status.enabled ? '✓' : '✗'}
                        </span>
                        <span>{status.enabled ? t('status.on') : t('status.off')}</span>
                    </dd>

                    <dt className="text-text-muted dark:text-text-muted-dark">
                        {t('status.configuration')}
                    </dt>
                    <dd className="text-text dark:text-text-dark">
                        {status.configured ? t('status.configured') : t('status.notConfigured')}
                    </dd>

                    {status.missing.length > 0 ? (
                        <>
                            <dt className="text-text-muted dark:text-text-muted-dark">
                                {t('status.missing')}
                            </dt>
                            <dd className="text-text dark:text-text-dark">
                                <ul data-testid="ever-id-admin-missing" className="space-y-0.5">
                                    {status.missing.map((field) => (
                                        <li key={field}>{fieldLabel(field)}</li>
                                    ))}
                                </ul>
                            </dd>
                        </>
                    ) : null}

                    <dt className="text-text-muted dark:text-text-muted-dark">
                        {t('fields.issuer')}
                    </dt>
                    <dd className="break-all text-text dark:text-text-dark">
                        {status.issuer ?? t('notSet')}
                    </dd>

                    <dt className="text-text-muted dark:text-text-muted-dark">
                        {t('fields.clientId')}
                    </dt>
                    <dd className="text-text dark:text-text-dark">
                        {status.clientIdSet ? t('set') : t('notSet')}
                    </dd>

                    <dt className="text-text-muted dark:text-text-muted-dark">
                        {t('fields.clientSecret')}
                    </dt>
                    <dd
                        data-testid="ever-id-admin-secret"
                        className="text-text dark:text-text-dark"
                    >
                        {status.clientSecretSet ? t('secretSet') : t('notSet')}
                    </dd>

                    <dt className="text-text-muted dark:text-text-muted-dark">
                        {t('fields.displayName')}
                    </dt>
                    <dd className="text-text dark:text-text-dark">{status.displayName}</dd>

                    <dt className="text-text-muted dark:text-text-muted-dark">
                        {t('status.newAccounts')}
                    </dt>
                    <dd className="text-text dark:text-text-dark">
                        {status.signUpAllowed
                            ? t('status.signUpAllowed')
                            : t('status.signUpNotAllowed')}
                    </dd>

                    <dt className="text-text-muted dark:text-text-muted-dark">
                        {t('status.localClients')}
                    </dt>
                    <dd className="text-text dark:text-text-dark">{status.localClients}</dd>
                </dl>

                {status.unavailableSince ? (
                    <p
                        role="status"
                        data-testid="ever-id-admin-unavailable"
                        className="rounded-lg border border-warning/20 bg-warning/10 px-4 py-3 text-sm text-text dark:text-text-dark"
                    >
                        {t('status.unavailableSince', {
                            date: formatDateTime(status.unavailableSince),
                        })}
                    </p>
                ) : null}
            </section>

            {sources.length > 0 ? (
                <section aria-labelledby={sourcesHeadingId} className="space-y-3">
                    <h3
                        id={sourcesHeadingId}
                        className="text-lg font-medium text-text dark:text-text-dark"
                    >
                        {t('sources.title')}
                    </h3>
                    <dl
                        data-testid="ever-id-admin-sources"
                        className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[minmax(0,16rem)_1fr]"
                    >
                        {sources.map(([field, source]) => (
                            <Fragment key={field}>
                                <dt className="text-text-muted dark:text-text-muted-dark">
                                    {fieldLabel(field)}
                                </dt>
                                <dd className="text-text dark:text-text-dark">
                                    {t(`sources.${source}`)}
                                </dd>
                            </Fragment>
                        ))}
                    </dl>
                </section>
            ) : null}

            {status.settings ? (
                <EverIdAdminSettingsForm settings={status.settings} onSaved={setStatus} />
            ) : null}

            <section aria-labelledby={testHeadingId} className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <h3
                        id={testHeadingId}
                        className="text-lg font-medium text-text dark:text-text-dark"
                    >
                        {t('testConnection')}
                    </h3>
                    <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        data-testid="ever-id-admin-test"
                        onClick={runTest}
                        loading={isTesting}
                        disabled={isTesting || isToggling}
                    >
                        {isTesting ? t('testing') : t('testConnection')}
                    </Button>
                </div>

                {testError ? (
                    <p
                        role="alert"
                        data-testid="ever-id-admin-test-error"
                        className="rounded-lg border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger"
                    >
                        {testError}
                    </p>
                ) : null}

                <div aria-live="polite">
                    {checks ? (
                        <ul data-testid="ever-id-admin-checks" className="space-y-1 text-sm">
                            {EVER_ID_CHECK_IDS.filter((id) => checkResults.has(id)).map((id) => {
                                const ok = checkResults.get(id) === true;
                                return (
                                    <li
                                        key={id}
                                        data-testid={`ever-id-admin-check-${id}`}
                                        data-ok={ok}
                                        className="flex flex-wrap items-baseline gap-2"
                                    >
                                        <span
                                            aria-hidden="true"
                                            className={ok ? 'text-success' : 'text-danger'}
                                        >
                                            {ok ? '✓' : '✗'}
                                        </span>
                                        <span className="text-text dark:text-text-dark">
                                            {t(`check.${id}`)}
                                        </span>
                                        <span className="text-text-muted dark:text-text-muted-dark">
                                            {ok ? t('checkOk') : t('checkFailed')}
                                        </span>
                                    </li>
                                );
                            })}
                        </ul>
                    ) : null}
                </div>
            </section>

            <section aria-labelledby={healthHeadingId} className="space-y-3">
                <h3
                    id={healthHeadingId}
                    className="text-lg font-medium text-text dark:text-text-dark"
                >
                    {t('health.title')}
                </h3>
                {healthRows.length > 0 ? (
                    <ul data-testid="ever-id-admin-health" className="space-y-1 text-sm">
                        {healthRows.map((row) => (
                            <li key={row.id} className="text-text dark:text-text-dark">
                                {row.text}
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                        {t('health.unavailable')}
                    </p>
                )}
            </section>

            <section className="space-y-3">
                {toggleError ? (
                    <p
                        role="alert"
                        data-testid="ever-id-admin-toggle-error"
                        className="rounded-lg border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger"
                    >
                        {toggleError}
                    </p>
                ) : null}
                <Button
                    type="button"
                    variant={status.enabled ? 'danger' : 'primary'}
                    data-testid="ever-id-admin-toggle"
                    onClick={toggle}
                    loading={isToggling}
                    disabled={isTesting || isToggling}
                >
                    {status.enabled ? t('disable') : t('enable')}
                </Button>
            </section>
        </div>
    );
}

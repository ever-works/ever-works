'use client';

import { useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import {
    confirmProvisionCompany,
    declineProvision,
    type ProvisionFailure,
} from '@/app/actions/ever-connect-provision';
import { AuthLayout } from '@/components/layout/AuthLayout';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import type { ProvisionSummary } from '@/lib/api/ever-connect-provision';
import { ROUTES } from '@/lib/constants';
import { everConnectProvisionFailureKey } from '../provision-fragment';

export interface ProvisionTemplateOption {
    slug: string;
    name: string;
}

interface ProvisionConfirmClientProps {
    summary?: ProvisionSummary;
    templates?: ProvisionTemplateOption[];
    failure?: ProvisionFailure;
}

const INPUT_CLASS =
    'w-full rounded-lg border border-border dark:border-border-dark bg-transparent px-3 py-2 text-sm text-text dark:text-text-dark';
const LABEL_CLASS = 'block text-sm font-medium text-text dark:text-text-dark';

/**
 * The form the person confirms once: the company's names as Ever knows them, and,
 * when this installation staffs companies, a template and the first Mission, each
 * prefilled and changeable. One key per confirmation, reused on a retry, so
 * pressing Create again never makes a second company.
 */
export function ProvisionConfirmClient({
    summary,
    templates = [],
    failure,
}: ProvisionConfirmClientProps) {
    const t = useTranslations('everConnect.provision');
    const key = useRef<string | null>(null);
    const [error, setError] = useState<ProvisionFailure | null>(failure ?? null);
    const [isSending, startSend] = useTransition();

    const display = summary?.display;
    const [name, setName] = useState(display?.displayName ?? '');
    const [legalName, setLegalName] = useState(display?.legalName ?? display?.displayName ?? '');
    const [template, setTemplate] = useState(() =>
        templates.some((option) => option.slug === display?.staffTemplateSlug)
            ? (display?.staffTemplateSlug ?? '')
            : '',
    );
    const [missionTitle, setMissionTitle] = useState(display?.firstMission?.title ?? '');
    const [missionGoal, setMissionGoal] = useState(display?.firstMission?.goal ?? '');

    if (!summary || !display) {
        return (
            <AuthLayout title={t('title')} subtitle="">
                <ThemeToggle variant="fixed" />
                <div className="space-y-4" data-testid="ever-connect-provision-confirm-failed">
                    <p
                        role="alert"
                        className="bg-warning/10 border border-warning/20 px-4 py-3 rounded-lg text-sm text-text dark:text-text-dark"
                    >
                        {t(everConnectProvisionFailureKey(failure ?? 'failed'))}
                    </p>
                    {failure === 'mismatch' ? (
                        <Button href={ROUTES.DASHBOARD_SETTINGS_SECURITY} fullWidth>
                            {t('connectEverId')}
                        </Button>
                    ) : null}
                </div>
            </AuthLayout>
        );
    }

    const staffs = summary.capabilities.provisionCompany;

    const create = () => {
        if (isSending) return;
        setError(null);
        key.current ??= crypto.randomUUID();
        const idempotencyKey = key.current;
        const title = missionTitle.trim();
        const goal = missionGoal.trim();
        startSend(async () => {
            const result = await confirmProvisionCompany(
                {
                    name: name.trim(),
                    legalName: legalName.trim(),
                    staffTemplateSlug: staffs && template ? template : null,
                    firstMission: staffs && title && goal ? { title, goal } : null,
                },
                idempotencyKey,
            );
            if (result.success) {
                window.location.assign(result.returnTo);
                return;
            }
            setError(result.failure);
        });
    };

    const decline = () => {
        if (isSending) return;
        setError(null);
        startSend(async () => {
            const result = await declineProvision();
            if (result.success) {
                window.location.assign(result.returnTo);
                return;
            }
            setError(result.failure);
        });
    };

    const alert = error ? (
        <p
            role="alert"
            data-testid="ever-connect-provision-confirm-error"
            className="bg-warning/10 border border-warning/20 px-4 py-3 rounded-lg text-sm text-text dark:text-text-dark"
        >
            {t(everConnectProvisionFailureKey(error))}
        </p>
    ) : null;

    if (summary.existing) {
        return (
            <AuthLayout
                title={t('existsTitle')}
                subtitle={t('forHandle', { name: display.displayName, handle: display.handle })}
            >
                <ThemeToggle variant="fixed" />
                <div className="space-y-4" data-testid="ever-connect-provision-exists">
                    {alert}
                    <Button onClick={create} disabled={isSending} fullWidth>
                        {t('continue')}
                    </Button>
                </div>
            </AuthLayout>
        );
    }

    return (
        <AuthLayout
            title={t('confirmTitle', { name: display.displayName })}
            subtitle={t('confirmSubtitle', { handle: display.handle })}
        >
            <ThemeToggle variant="fixed" />
            <form
                className="space-y-4"
                data-testid="ever-connect-provision-confirm-form"
                onSubmit={(event) => {
                    event.preventDefault();
                    create();
                }}
            >
                {alert}
                <div className="space-y-1">
                    <label htmlFor="provision-name" className={LABEL_CLASS}>
                        {t('name')}
                    </label>
                    <input
                        id="provision-name"
                        className={INPUT_CLASS}
                        value={name}
                        maxLength={200}
                        required
                        onChange={(event) => setName(event.target.value)}
                    />
                </div>
                <div className="space-y-1">
                    <label htmlFor="provision-legal-name" className={LABEL_CLASS}>
                        {t('legalName')}
                    </label>
                    <input
                        id="provision-legal-name"
                        className={INPUT_CLASS}
                        value={legalName}
                        maxLength={200}
                        required
                        onChange={(event) => setLegalName(event.target.value)}
                    />
                </div>
                {staffs ? (
                    <>
                        <div className="space-y-1">
                            <label htmlFor="provision-template" className={LABEL_CLASS}>
                                {t('staffing')}
                            </label>
                            <select
                                id="provision-template"
                                className={INPUT_CLASS}
                                value={template}
                                onChange={(event) => setTemplate(event.target.value)}
                            >
                                <option value="">{t('staffingNone')}</option>
                                {templates.map((option) => (
                                    <option key={option.slug} value={option.slug}>
                                        {option.name}
                                    </option>
                                ))}
                            </select>
                            <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                                {t('staffingHelp')}
                            </p>
                        </div>
                        <div className="space-y-1">
                            <label htmlFor="provision-mission-title" className={LABEL_CLASS}>
                                {t('missionTitle')}
                            </label>
                            <input
                                id="provision-mission-title"
                                className={INPUT_CLASS}
                                value={missionTitle}
                                maxLength={200}
                                onChange={(event) => setMissionTitle(event.target.value)}
                            />
                        </div>
                        <div className="space-y-1">
                            <label htmlFor="provision-mission-goal" className={LABEL_CLASS}>
                                {t('missionGoal')}
                            </label>
                            <textarea
                                id="provision-mission-goal"
                                className={INPUT_CLASS}
                                value={missionGoal}
                                maxLength={10000}
                                rows={3}
                                onChange={(event) => setMissionGoal(event.target.value)}
                            />
                        </div>
                    </>
                ) : null}
                <Button type="submit" disabled={isSending || !name.trim()} fullWidth>
                    {t('create')}
                </Button>
                <Button
                    type="button"
                    variant="outline"
                    onClick={decline}
                    disabled={isSending}
                    fullWidth
                >
                    {t('decline')}
                </Button>
            </form>
        </AuthLayout>
    );
}

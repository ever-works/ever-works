'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Target } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { requestAppChangeAction } from '@/app/actions/dashboard/app-changes';
import type { CreateMissionInput, Mission, MissionTemplateManifestView } from '@/lib/api/missions';
import {
    BuildOnAppTemplateFields,
    templateInputsComplete,
    templateTakesAppWork,
    type BuildOnAppTemplateValue,
    type ProposeRulesFn,
} from './BuildOnAppTemplateFields';

type CreateMissionFn = (input: CreateMissionInput) => Promise<Mission>;

/** The `buildOnApp` copy for a create's template warnings, or `null` when there is none. */
export function templateWarningKey(
    warnings: readonly string[] | undefined,
): 'templateUnreadable' | 'templatePartial' | null {
    if (!warnings || warnings.length === 0) return null;
    if (warnings.includes('templateManifestUnreadable')) return 'templateUnreadable';
    if (
        warnings.includes('templateWorkNotAttached') ||
        warnings.includes('templateGoalsNotCreated')
    ) {
        return 'templatePartial';
    }
    return null;
}

/**
 * APW-08 T40 — the catalog Mission template the form was opened with (`?template=<id>`), and its
 * manifest as `GET /me/missions/templates/:id/manifest` answered it (`null` when unreadable).
 */
export interface NewMissionFormTemplate {
    id: string;
    manifest: MissionTemplateManifestView | null;
}

const MIN_DESCRIPTION_LENGTH = 10;
const MAX_DESCRIPTION_LENGTH = 10000;
const MAX_TITLE_LENGTH = 200;
const MAX_SCHEDULE_LENGTH = 64;

/**
 * Dedicated `/missions/new` manual-create form.
 *
 * The `/missions` quick-add composer hands the prompt to the chat AI and
 * relies on the model calling the `createMission` tool. That makes Mission
 * creation depend on an LLM being reachable, on per-turn tool gating keeping
 * `createMission` active, and on the model choosing to call it — when any of
 * those fails the user sees the assistant ask a question, answers it, and
 * nothing happens, with no way to recover.
 *
 * This form is the deterministic no-AI path: it posts straight through the
 * existing `createMissionAction` server action to `POST /me/missions`. It
 * sits ALONGSIDE the composer, exactly as `/ideas/new` does for Ideas.
 *
 * The `type` / `schedule` pairing mirrors the server contract enforced by
 * `MissionsService.assertScheduleConsistency`: a `scheduled` Mission must
 * carry a cron expression, a `one-shot` Mission must not.
 */
export function NewMissionForm({
    createMission,
    template = null,
    initialDescription = '',
    proposeRules = requestAppChangeAction,
}: {
    createMission: CreateMissionFn;
    /** APW-08 T40 — a catalog template; its manifest's `appWork` adds the template's fields. */
    template?: NewMissionFormTemplate | null;
    initialDescription?: string;
    /** APW-08 T40 (FR-59) — **Propose these rules**; injectable for tests. */
    proposeRules?: ProposeRulesFn;
}) {
    const t = useTranslations('dashboard.missionsPage.newPage');
    const tb = useTranslations('dashboard.missionsPage.buildOnApp');
    const router = useRouter();
    const appTemplate =
        template && templateTakesAppWork(template.manifest) ? template.manifest : null;
    // FR-57 / FR-60 — a template about an App Work starts on its own cadence; the person may change
    // it before submitting, and whatever they leave untouched is the template's.
    const templateCadence = appTemplate?.defaults?.cadence ?? null;
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState(initialDescription);
    const [type, setType] = useState<'one-shot' | 'scheduled'>(
        templateCadence ? 'scheduled' : 'one-shot',
    );
    const [schedule, setSchedule] = useState(templateCadence ?? '');
    const [templateValue, setTemplateValue] = useState<BuildOnAppTemplateValue>({
        product: '',
        business: '',
        appWorkId: '',
    });
    // House rule: explicit isSubmitting over useTransition.pending for
    // detached-async submits. `startTransition(() => { void (async…)() })`
    // returns synchronously, so `pending` flips back to false while the
    // request is still in flight — a double-click then passes every guard
    // and creates two Missions.
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const trimmedDescription = description.trim();
    const trimmedSchedule = schedule.trim();
    const scheduleMissing = type === 'scheduled' && trimmedSchedule.length === 0;
    const templateMissing = appTemplate !== null && !templateInputsComplete(templateValue);
    const canSubmit =
        trimmedDescription.length >= MIN_DESCRIPTION_LENGTH &&
        !scheduleMissing &&
        !templateMissing &&
        !isSubmitting;

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (isSubmitting) return;
        if (trimmedDescription.length < MIN_DESCRIPTION_LENGTH) {
            setError(t('minLength'));
            return;
        }
        if (scheduleMissing) {
            setError(t('scheduleRequired'));
            return;
        }
        setError(null);
        const trimmedTitle = title.trim();
        setIsSubmitting(true);
        void (async () => {
            try {
                const mission = await createMission({
                    description: trimmedDescription,
                    type,
                    // The server rejects a schedule on a one-shot Mission,
                    // so send `null` rather than an empty string.
                    schedule: type === 'scheduled' ? trimmedSchedule : null,
                    ...(trimmedTitle ? { title: trimmedTitle } : {}),
                    // APW-08 T40 — the template rides on the Mission; its manifest supplies every
                    // value the form does not send (FR-57), and its inputs fill the title, attach
                    // the App Work and create the draft Goals (FR-56, FR-58).
                    ...(template ? { missionTemplateRepo: template.id } : {}),
                    ...(appTemplate
                        ? {
                              templateInputs: {
                                  product: templateValue.product.trim(),
                                  business: templateValue.business.trim(),
                                  appWorkId: templateValue.appWorkId,
                              },
                          }
                        : {}),
                });
                toast.success(t('created'));
                // APW-08 T40 (review of #3077) — a template that could not be read, or a part of it
                // (the App Work link, a draft Goal) that could not be applied, is said, not hidden.
                const warning = templateWarningKey(mission.warnings);
                if (warning) toast.warning(tb(warning));
                // Deliberately NOT cleared before navigation — the form stays
                // locked until the route change unmounts it.
                router.push(`${ROUTES.DASHBOARD_MISSIONS}/${mission.id}`);
            } catch {
                // Security: never surface raw API error text (it may carry
                // internal details). Show a localized generic message.
                setError(t('error'));
                setIsSubmitting(false);
            }
        })();
    };

    return (
        <div className="max-w-xl mx-auto p-6">
            <div className="flex items-center gap-3 mb-6">
                <div className="shrink-0 w-9 h-9 rounded-lg bg-concept-missions/10 border border-concept-missions/20 flex items-center justify-center">
                    <Target className="w-4 h-4 text-concept-missions" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                    <h1 className="text-xl font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </h1>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark mt-0.5">
                        {t('subtitle')}
                    </p>
                </div>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4" data-testid="new-mission-form">
                <div>
                    <label
                        htmlFor="new-mission-title"
                        className="block text-xs text-text-secondary dark:text-text-secondary-dark mb-1"
                    >
                        {t('nameLabel')}
                    </label>
                    <input
                        id="new-mission-title"
                        type="text"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder={t('namePlaceholder')}
                        maxLength={MAX_TITLE_LENGTH}
                        className="w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark px-3 h-9 text-sm text-text dark:text-text-dark"
                    />
                </div>

                <div>
                    <label
                        htmlFor="new-mission-description"
                        className="block text-xs text-text-secondary dark:text-text-secondary-dark mb-1"
                    >
                        {t('descriptionLabel')}
                    </label>
                    <textarea
                        id="new-mission-description"
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        rows={6}
                        autoFocus
                        maxLength={MAX_DESCRIPTION_LENGTH}
                        placeholder={t('descriptionPlaceholder')}
                        aria-describedby="new-mission-description-hint"
                        className="w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-3 text-sm text-text dark:text-text-dark"
                    />
                    <p
                        id="new-mission-description-hint"
                        className="mt-1 text-xs text-text-muted dark:text-text-muted-dark"
                    >
                        {t('descriptionHint')}
                    </p>
                </div>

                <div>
                    <label
                        htmlFor="new-mission-type"
                        className="block text-xs text-text-secondary dark:text-text-secondary-dark mb-1"
                    >
                        {t('typeLabel')}
                    </label>
                    <select
                        id="new-mission-type"
                        value={type}
                        onChange={(e) => setType(e.target.value as 'one-shot' | 'scheduled')}
                        className="w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark px-3 h-9 text-sm text-text dark:text-text-dark"
                    >
                        <option value="one-shot">{t('typeOneShot')}</option>
                        <option value="scheduled">{t('typeScheduled')}</option>
                    </select>
                </div>

                {type === 'scheduled' && (
                    <div>
                        <label
                            htmlFor="new-mission-schedule"
                            className="block text-xs text-text-secondary dark:text-text-secondary-dark mb-1"
                        >
                            {t('scheduleLabel')}
                        </label>
                        <input
                            id="new-mission-schedule"
                            type="text"
                            value={schedule}
                            onChange={(e) => setSchedule(e.target.value)}
                            placeholder={t('schedulePlaceholder')}
                            maxLength={MAX_SCHEDULE_LENGTH}
                            aria-describedby="new-mission-schedule-hint"
                            className="w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark px-3 h-9 font-mono text-sm text-text dark:text-text-dark"
                        />
                        <p
                            id="new-mission-schedule-hint"
                            className="mt-1 text-xs text-text-muted dark:text-text-muted-dark"
                        >
                            {t('scheduleHint')}
                        </p>
                    </div>
                )}

                {appTemplate && (
                    <BuildOnAppTemplateFields
                        manifest={appTemplate}
                        value={templateValue}
                        onChange={setTemplateValue}
                        proposeRules={proposeRules}
                        schedule={type === 'scheduled' ? schedule : null}
                        disabled={isSubmitting}
                    />
                )}

                {error && (
                    <p className="text-xs text-danger" role="alert">
                        {error}
                    </p>
                )}

                <div className="flex items-center justify-end gap-2">
                    <Button type="button" variant="ghost" size="sm" onClick={() => router.back()}>
                        {t('cancel')}
                    </Button>
                    <Button
                        type="submit"
                        size="sm"
                        disabled={!canSubmit}
                        data-testid="new-mission-submit"
                    >
                        {isSubmitting ? t('creating') : appTemplate ? tb('create') : t('create')}
                    </Button>
                </div>
            </form>
        </div>
    );
}

'use client'; // Hooks (useState/useTransition/useRouter/useWorkPermissions) — a client component.

import { useEffect, useState, useTransition } from 'react';
import { DeleteWorkDto, Work } from '@/lib/api/types-only';
import type { AppDeployTargetChoice } from '@ever-works/contracts';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { useRouter } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { deleteWork, getAppDeleteTarget } from '@/app/actions/dashboard';
import { ROUTES } from '@/lib/constants';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
    DialogClose,
} from '@/components/ui/dialog';
import { GenerateStatusType } from '@/lib/api/enums';
import { useWorkPermissions } from '../WorkDetailContext';
import { TriangleAlertIcon } from 'lucide-react';
import { getWorkCapabilities, isRepositoryWorkKind } from '@ever-works/contracts';

/**
 * The danger zone's delete dialog, per Work kind.
 *
 * APW-01 T39 adds the **App Work** surface (plan §5.2 `:747-750`, spec §6.5). Three
 * things make an App Work different, and all three are about NOT deleting something
 * the platform never created:
 *
 *   1. Its Work Repository (`relatedRepositories.website`, the only role
 *      `buildWorkData` writes) is a fork, a private copy, or the repository the member
 *      **linked** — never a repository the platform generated. The checkbox is offered
 *      only when this Work created it, and it demands the full name typed out
 *      (FR-38, ACC-NEG-07); a LINK is never deletable and says so instead (FR-37).
 *   2. Deleting it removes the App's cluster workloads, and **Also delete stored
 *      data** is a separate, independent choice that needs the Work's **slug** typed
 *      (FR-40a/FR-40b, Resolution R-15). It is offered only when the deploy target is
 *      not `none` — the target comes from APW-06's `GET /api/works/:id/app-target`,
 *      and a `404` (APW-06 not merged, or no runtime row yet) is treated as `none`.
 *   3. Neither field is ever sent speculatively: `delete_data_repository` goes only
 *      when the fork box is ticked AND the typed name matches, `delete_stored_data`
 *      only when the stored-data box is ticked AND the typed slug matches.
 *
 * Every other kind keeps the legacy three-checkbox dialog exactly as it was: the
 * kind's provisioned roles still decide which boxes exist
 * (`WORK_KIND_CAPABILITIES`), and the legacy `delete_website_repository` /
 * `delete_markdown_repository` flags are still what they always were for them.
 */
export function DeleteComponent({ work }: { work: Work }) {
    const permissions = useWorkPermissions();
    const t = useTranslations('dashboard.workDetail.settings');
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    const [showDeleteDialog, setShowDeleteDialog] = useState(false);
    const [confirmationName, setConfirmationName] = useState('');
    const [deleteOptions, setDeleteOptions] = useState<DeleteWorkDto>({
        delete_data_repository: false,
        delete_markdown_repository: false,
        delete_website_repository: false,
    });

    // Which repositories this kind actually provisions. A checkbox for a
    // repository the platform never created is worse than misleading: for a
    // Repository Work the "data repository" IS the user's own code repo and
    // the API refuses to delete it, so none of the three is offered.
    const provisioned = getWorkCapabilities(work.kind).repos;
    const canDeleteDataRepository = provisioned.data && !isRepositoryWorkKind(work.kind);
    const offersRepositoryOptions =
        canDeleteDataRepository || provisioned.work || provisioned.website;

    // ── APW-01 T39 — the App Work surface ────────────────────────────────────
    const isAppWork = (work.kind ?? '').trim().toLowerCase() === 'app';
    const appSource = work.sourceRepository;
    /** `link` · `fork` · `private-copy`, read exactly as `AppWorkCreateService` reads it. */
    const appRelation: 'link' | 'fork' | 'private-copy' =
        appSource?.type === 'app_fork'
            ? 'fork'
            : appSource?.type === 'app_private_copy'
              ? 'private-copy'
              : 'link';
    /** The Work Repository: the `website` role is the ONLY one an App Work records. */
    const appRepositoryOwner =
        appSource?.relatedRepositories?.website?.owner ?? appSource?.owner ?? work.owner ?? '';
    const appRepositoryRepo =
        appSource?.relatedRepositories?.website?.repo ?? appSource?.repo ?? work.slug;
    const appRepositoryFullName = `${appRepositoryOwner}/${appRepositoryRepo}`;
    /** Only a repository THIS Work created may be deleted from here (R-4, FR-38). */
    const appRepositoryIsOurs = appSource?.createdByThisWork === true;

    const [appTarget, setAppTarget] = useState<AppDeployTargetChoice | null>(null);
    const [appForkChecked, setAppForkChecked] = useState(false);
    const [appForkTyped, setAppForkTyped] = useState('');
    const [appStoredDataChecked, setAppStoredDataChecked] = useState(false);
    const [appStoredDataTyped, setAppStoredDataTyped] = useState('');

    // The target is read once, when the dialog opens for an App Work: APW-06's route
    // answers `404` today, which `getAppDeleteTarget` reports as `none` and which
    // hides the stored-data box rather than guessing a target.
    useEffect(() => {
        if (!showDeleteDialog || !isAppWork || appTarget !== null) {
            return;
        }
        let cancelled = false;
        void getAppDeleteTarget(work.id).then((result) => {
            if (cancelled) {
                return;
            }
            setAppTarget(result.success ? (result.target ?? 'none') : 'none');
        });
        return () => {
            cancelled = true;
        };
    }, [showDeleteDialog, isAppWork, appTarget, work.id]);

    const appOffersStoredData = isAppWork && appTarget !== null && appTarget !== 'none';
    const appTargetLabel =
        appTarget === 'ever-works-apps'
            ? t('deleteAppTargetEverWorksApps')
            : appTarget === 'your-cluster'
              ? t('deleteAppTargetYourCluster')
              : t('deleteAppTargetNone');

    // The fork/copy box is offered only for a repository this Work created; a link
    // says so instead, and an adopted fork is not the platform's to delete at all.
    const appOffersForkBox = isAppWork && appRepositoryIsOurs && appRelation !== 'link';
    const appForkSatisfied = appForkChecked && appForkTyped.trim() === appRepositoryFullName;
    const appStoredDataSatisfied =
        appStoredDataChecked && appStoredDataTyped.trim() === (work.slug ?? '');

    // Only owners can delete works
    if (!permissions.canDelete) {
        return null;
    }

    const handleCloseDialog = () => {
        setShowDeleteDialog(false);
        setConfirmationName('');
        setAppForkChecked(false);
        setAppForkTyped('');
        setAppStoredDataChecked(false);
        setAppStoredDataTyped('');
        setDeleteOptions({
            delete_data_repository: false,
            delete_markdown_repository: false,
            delete_website_repository: false,
        });
    };

    const handleDelete = async () => {
        if (confirmationName !== work.name) {
            toast.error(t('deleteNameMismatch'));
            return;
        }

        // APW-01 T39: an App Work sends ONLY what was explicitly confirmed. An
        // unticked box (or a box whose typed confirmation does not match) sends
        // nothing at all — never a `false`, and never a guess.
        const payload: DeleteWorkDto = isAppWork
            ? {
                  ...(appForkSatisfied ? { delete_data_repository: true } : {}),
                  ...(appStoredDataSatisfied
                      ? { delete_stored_data: true, confirm_slug: appStoredDataTyped.trim() }
                      : {}),
              }
            : deleteOptions;

        startTransition(async () => {
            const result = await deleteWork(work.id, payload);

            if (result.success) {
                toast.success(result.message || t('deleteSuccess'));
                router.push(ROUTES.DASHBOARD_WORKS);
            } else {
                toast.error(result.error || t('deleteFailed'));
            }
        });
    };

    const isDeleteDisabled = confirmationName !== work.name || isPending;
    const isGenerating = work.generateStatus?.status === GenerateStatusType.GENERATING;

    return (
        <>
            {/* Danger zone card */}
            <div className="rounded-xl border border-red-200 dark:border-red-900/60 overflow-hidden">
                <div className="flex items-center gap-2.5 px-5 py-3.5 bg-red-50 dark:bg-red-950/20 border-b border-red-200 dark:border-red-900/60">
                    <TriangleAlertIcon className="size-4 text-red-500 dark:text-red-400 shrink-0" />
                    <h3 className="text-sm font-semibold text-red-700 dark:text-red-300">
                        {t('dangerZone')}
                    </h3>
                </div>

                <div className="flex items-center justify-between gap-4 px-5 py-4 bg-white dark:bg-surface-dark">
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                        {t('deleteWarning')}
                    </p>
                    <Button
                        onClick={() => setShowDeleteDialog(true)}
                        variant="danger"
                        size="sm"
                        title={isGenerating ? t('cantDeleteWhileGenerating') : undefined}
                        disabled={isPending || isGenerating}
                        className="shrink-0"
                    >
                        {t('deleteButton')}
                    </Button>
                </div>
            </div>

            {/* Confirm dialog */}
            <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
                <DialogContent className="max-w-lg">
                    <DialogClose onClose={handleCloseDialog} />
                    <DialogHeader>
                        <div className="flex items-center gap-3 mb-1">
                            <span className="flex items-center justify-center size-9 rounded-full bg-red-100 dark:bg-red-950/50 shrink-0">
                                <TriangleAlertIcon className="size-4 text-red-600 dark:text-red-400" />
                            </span>
                            <DialogTitle className="text-base font-semibold text-text dark:text-text-dark">
                                {t('deleteConfirm')}
                            </DialogTitle>
                        </div>
                        <DialogDescription className="text-sm text-text-secondary dark:text-text-secondary-dark">
                            {t('deleteConfirmDetail')}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-4">
                        {/* APW-01 T39 (R-15) — what happens to the running app. Shown
                            only when the Work actually deploys somewhere: with target
                            `none` (including APW-06's not-yet-mounted route) there is
                            nothing running and nothing stored to decide about. */}
                        {isAppWork && appTarget !== null && appTarget !== 'none' && (
                            <p className="rounded-lg border border-card-border dark:border-border-secondary-dark px-4 py-3 text-xs text-text-secondary dark:text-text-secondary-dark">
                                {t('deleteAppWorkloadsNote', { target: appTargetLabel })}
                            </p>
                        )}

                        {/* APW-01 T39 — the App Work's own delete surface. */}
                        {isAppWork && (
                            <div className="rounded-lg border border-card-border dark:border-border-secondary-dark divide-y divide-card-border dark:divide-card-border-dark">
                                <div className="px-4 py-3">
                                    <p className="text-xs font-semibold uppercase tracking-wide text-text-muted dark:text-text-muted-dark">
                                        {t('deleteOptions')}
                                    </p>
                                </div>

                                {appRelation === 'link' && (
                                    <div className="px-4 py-3">
                                        <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                                            {t('deleteAppLinkNote', {
                                                fullName: appRepositoryFullName,
                                            })}
                                        </p>
                                    </div>
                                )}

                                {!appRepositoryIsOurs && appRelation !== 'link' && (
                                    <div className="px-4 py-3">
                                        <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                                            {t('deleteAppRepositoryNotOurs', {
                                                fullName: appRepositoryFullName,
                                            })}
                                        </p>
                                    </div>
                                )}

                                {appOffersForkBox && (
                                    <div className="space-y-3 px-4 py-3">
                                        <Checkbox
                                            checked={appForkChecked}
                                            onChange={(e) => setAppForkChecked(e.target.checked)}
                                            label={t(
                                                appRelation === 'private-copy'
                                                    ? 'deleteAppPrivateCopy'
                                                    : 'deleteAppFork',
                                                { fullName: appRepositoryFullName },
                                            )}
                                            description={t('deleteAppForkHelper')}
                                            variant="form"
                                        />
                                        {appForkChecked && (
                                            <div className="space-y-2">
                                                <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                                                    {t('deleteAppForkTypeToConfirm', {
                                                        fullName: appRepositoryFullName,
                                                    })}
                                                </p>
                                                <Input
                                                    type="text"
                                                    value={appForkTyped}
                                                    onChange={(e) =>
                                                        setAppForkTyped(e.target.value)
                                                    }
                                                    placeholder={appRepositoryFullName}
                                                    variant="form"
                                                />
                                            </div>
                                        )}
                                    </div>
                                )}

                                {appOffersStoredData && (
                                    <div className="space-y-3 px-4 py-3">
                                        <Checkbox
                                            checked={appStoredDataChecked}
                                            onChange={(e) =>
                                                setAppStoredDataChecked(e.target.checked)
                                            }
                                            label={t('deleteAppStoredData')}
                                            description={t('deleteAppStoredDataHelper')}
                                            variant="form"
                                        />
                                        {appStoredDataChecked && (
                                            <div className="space-y-2">
                                                <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                                                    {t('deleteAppStoredDataTypeToConfirm', {
                                                        slug: work.slug,
                                                    })}
                                                </p>
                                                <Input
                                                    type="text"
                                                    value={appStoredDataTyped}
                                                    onChange={(e) =>
                                                        setAppStoredDataTyped(e.target.value)
                                                    }
                                                    placeholder={work.slug}
                                                    variant="form"
                                                />
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Repository options — only the roles this kind provisions.
                            An App Work's repository is the box above, never the
                            generated-roles one. */}
                        {!isAppWork && offersRepositoryOptions && (
                            <div className="rounded-lg border border-card-border dark:border-border-secondary-dark divide-y divide-card-border dark:divide-card-border-dark">
                                <div className="px-4 py-3">
                                    <p className="text-xs font-semibold uppercase tracking-wide text-text-muted dark:text-text-muted-dark">
                                        {t('deleteOptions')}
                                    </p>
                                </div>
                                {canDeleteDataRepository && (
                                    <div className="px-4 py-3">
                                        <Checkbox
                                            checked={deleteOptions.delete_data_repository || false}
                                            onChange={(e) =>
                                                setDeleteOptions((current) => ({
                                                    ...current,
                                                    delete_data_repository: e.target.checked,
                                                }))
                                            }
                                            label={t('deleteDataRepository')}
                                            description={t('deleteDataRepositoryDescription')}
                                            variant="form"
                                        />
                                    </div>
                                )}
                                {provisioned.work && (
                                    <div className="px-4 py-3">
                                        <Checkbox
                                            checked={
                                                deleteOptions.delete_markdown_repository || false
                                            }
                                            onChange={(e) =>
                                                setDeleteOptions((current) => ({
                                                    ...current,
                                                    delete_markdown_repository: e.target.checked,
                                                }))
                                            }
                                            label={t('deleteMarkdownRepository')}
                                            description={t('deleteMarkdownRepositoryDescription')}
                                            variant="form"
                                        />
                                    </div>
                                )}
                                {provisioned.website && (
                                    <div className="px-4 py-3">
                                        <Checkbox
                                            checked={
                                                deleteOptions.delete_website_repository || false
                                            }
                                            onChange={(e) =>
                                                setDeleteOptions((current) => ({
                                                    ...current,
                                                    delete_website_repository: e.target.checked,
                                                }))
                                            }
                                            label={t('deleteWebsiteRepository')}
                                            description={t('deleteWebsiteRepositoryDescription')}
                                            variant="form"
                                        />
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Name confirmation */}
                        <div className="space-y-2">
                            <p className="text-sm font-medium text-text dark:text-text-dark">
                                {t('confirmWorkName')}
                            </p>
                            <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                                {t('confirmWorkNameDescription', { name: work.name })}
                            </p>
                            <Input
                                type="text"
                                value={confirmationName}
                                onChange={(e) => setConfirmationName(e.target.value)}
                                placeholder={work.name}
                                variant="form"
                            />
                        </div>
                    </div>

                    <DialogFooter>
                        <Button
                            onClick={handleCloseDialog}
                            disabled={isPending}
                            variant="secondary"
                            size="sm"
                        >
                            {t('cancel')}
                        </Button>
                        <Button
                            onClick={handleDelete}
                            disabled={isDeleteDisabled}
                            loading={isPending}
                            variant="danger"
                            size="sm"
                        >
                            {t('deleteConfirmButton')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}

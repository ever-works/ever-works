'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import type {
    CheckSlugAvailabilityResponse,
    OrganizationResponse,
} from '@ever-works/contracts/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { useRouter } from '@/i18n/navigation';
import { useOrganizations } from '@/lib/hooks/use-organizations';
import { UpgradeOrCreateDialog } from './UpgradeOrCreateDialog';

/**
 * Mirror of `User.deriveSlugIfMissing` (and the server-side
 * `UsernameAllocatorService.normalize`) so the live preview matches
 * what the server would allocate when the user submits. We deliberately
 * do NOT call out to the API on every keystroke for normalization —
 * only the availability check is debounced and remote.
 */
function normalizeSlugPreview(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');
}

const DEBOUNCE_MS = 300;
const MAX_NAME_LENGTH = 200;
/**
 * PR-6 (domain-model evolution, review §23.5) — matches the server-side
 * storage cap on `Organization.vision` (see `CreateOrganizationRequest`
 * in `@ever-works/contracts/api`). Prompt-assembly consumers apply
 * their own tighter ~2000-char injection cap.
 */
const MAX_VISION_LENGTH = 5000;

/**
 * Teams & Prebuilt Companies (spec §4.4/§6) — one catalog entry from
 * `GET /api/org-templates` (BFF proxy of the ever-works/orgs manifest).
 */
interface OrgTemplateEntry {
    slug: string;
    name: string;
    description: string;
    category: string;
    agents: number;
    teams: number;
    skills: number;
    projects: number;
    iconName?: string;
    tags?: string[];
    featured?: boolean;
}

export interface CreateOrganizationModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

type SlugStatus =
    | { kind: 'idle' }
    | { kind: 'checking' }
    | { kind: 'available'; normalized: string }
    | { kind: 'taken'; normalized: string; suggestion?: string }
    | { kind: 'error'; message: string };

/**
 * EW-661 (Tenants & Organizations Phase 9) — first half of the
 * create-Org flow from spec §5.2.
 *
 * Form contract:
 *   - Single input `Name` (required, 1-200 chars).
 *   - Live, debounced slug-availability check against
 *     `GET /api/organizations/check-slug?value=<name>` shows
 *     "Available" / "Taken (try: acme-2)" hints.
 *   - Submit → `POST /api/organizations` with `{ name }`. The server
 *     allocates the slug + creates the lazy Tenant.
 *
 * Post-submit branching:
 *   - First Org (organizations.length === 0 before submit) → hands off
 *     to `<UpgradeOrCreateDialog>` so the user can choose the upgrade
 *     vs empty branch.
 *   - 2nd+ Org → close modal and navigate to `/{slug}/dashboard`
 *     directly. Subsequent Orgs skip the upgrade dialog entirely
 *     (spec §5.3).
 *
 * Wires into `useOrganizations().mutate()` on success so the
 * `<WorkspaceSwitcher>` populates without a full page reload.
 */
export function CreateOrganizationModal({ open, onOpenChange }: CreateOrganizationModalProps) {
    const t = useTranslations('organizations.create');
    const router = useRouter();
    const { organizations, mutate } = useOrganizations();

    const [name, setName] = useState('');
    /**
     * PR-6 — optional company Vision. Hidden behind a secondary toggle
     * so the create flow stays zero-friction; when provided it is sent
     * alongside `name` and later injected (fenced, untrusted) into
     * Idea-generation / agent-run / Mission-tick prompts.
     */
    const [vision, setVision] = useState('');
    const [showVision, setShowVision] = useState(false);
    const [submitError, setSubmitError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [slugStatus, setSlugStatus] = useState<SlugStatus>({ kind: 'idle' });
    const [createdOrg, setCreatedOrg] = useState<OrganizationResponse | null>(null);
    const [showUpgradeDialog, setShowUpgradeDialog] = useState(false);
    // Teams & Prebuilt Companies (spec §4.4) — optional template step.
    // `templates` stays [] on any fetch failure, which renders the modal
    // exactly as it was before this feature existed (skip-when-empty).
    const [templates, setTemplates] = useState<OrgTemplateEntry[]>([]);
    const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
    /**
     * Captures whether THIS submission is the user's first Org. Read
     * once at submit-time so the post-mutate `organizations.length`
     * can't flip the decision underneath us (post-mutate it's 1).
     */
    const wasFirstOrgRef = useRef(false);

    const slugPreview = useMemo(() => normalizeSlugPreview(name.trim()), [name]);

    // Reset state whenever the modal is closed so reopening starts fresh.
    useEffect(() => {
        if (!open) {
            setName('');
            setVision('');
            setShowVision(false);
            setSubmitError(null);
            setSlugStatus({ kind: 'idle' });
            setCreatedOrg(null);
            setShowUpgradeDialog(false);
            setSelectedTemplate(null);
        }
    }, [open]);

    // Load the prebuilt-company catalog when the modal opens. Best-effort:
    // any failure leaves `templates` empty and the step invisible.
    useEffect(() => {
        if (!open) return;
        const controller = new AbortController();
        void (async () => {
            try {
                const res = await fetch('/api/org-templates', {
                    method: 'GET',
                    signal: controller.signal,
                    cache: 'no-store',
                });
                if (!res.ok) return;
                const body = (await res.json()) as OrgTemplateEntry[];
                if (Array.isArray(body)) setTemplates(body);
            } catch {
                // Swallow — the template step simply doesn't render.
            }
        })();
        return () => controller.abort();
    }, [open]);

    // Debounced slug-availability check. Each keystroke resets the
    // 300ms timer; the request only fires once typing pauses.
    useEffect(() => {
        if (!open) return;
        const trimmed = name.trim();
        if (trimmed.length === 0) {
            setSlugStatus({ kind: 'idle' });
            return;
        }
        setSlugStatus({ kind: 'checking' });
        const controller = new AbortController();
        const timer = setTimeout(() => {
            void (async () => {
                try {
                    const res = await fetch(
                        `/api/organizations/check-slug?value=${encodeURIComponent(trimmed)}`,
                        {
                            method: 'GET',
                            signal: controller.signal,
                            cache: 'no-store',
                        },
                    );
                    if (!res.ok) {
                        setSlugStatus({ kind: 'error', message: `HTTP ${res.status}` });
                        return;
                    }
                    const body = (await res.json()) as CheckSlugAvailabilityResponse;
                    if (body.available) {
                        setSlugStatus({ kind: 'available', normalized: body.normalized });
                    } else {
                        setSlugStatus({
                            kind: 'taken',
                            normalized: body.normalized,
                            suggestion: body.suggestion,
                        });
                    }
                } catch (err) {
                    if ((err as { name?: string })?.name === 'AbortError') return;
                    setSlugStatus({
                        kind: 'error',
                        message: err instanceof Error ? err.message : 'Network error',
                    });
                }
            })();
        }, DEBOUNCE_MS);
        return () => {
            controller.abort();
            clearTimeout(timer);
        };
    }, [name, open]);

    const handleSubmit = useCallback(() => {
        const trimmed = name.trim();
        if (trimmed.length === 0) {
            setSubmitError(t('errors.nameRequired'));
            return;
        }
        if (trimmed.length > MAX_NAME_LENGTH) {
            setSubmitError(t('errors.nameTooLong'));
            return;
        }
        setSubmitError(null);
        wasFirstOrgRef.current = organizations.length === 0;
        // Template path (spec §4.4): route through the importer, which
        // creates the Organization PLUS its teams/agents/skills/works. The
        // blank/manual path (PR-6) additionally carries an optional Vision.
        // Both stay byte-identical to their pre-feature contracts otherwise.
        const importing = selectedTemplate !== null;
        const trimmedVision = vision.trim();
        const requestBody: { name: string; templateSlug?: string; vision?: string } = {
            name: trimmed,
        };
        if (importing) {
            requestBody.templateSlug = selectedTemplate as string;
        } else if (trimmedVision.length > 0) {
            requestBody.vision = trimmedVision.slice(0, MAX_VISION_LENGTH);
        }
        startTransition(() => {
            void (async () => {
                try {
                    const res = await fetch(
                        importing ? '/api/organizations/import-company' : '/api/organizations',
                        {
                            method: 'POST',
                            credentials: 'include',
                            cache: 'no-store',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(requestBody),
                        },
                    );
                    if (!res.ok) {
                        const body = await res
                            .json()
                            .catch(() => ({ error: 'Failed to create Organization' }));
                        // Security: cap displayed server message length to avoid leaking
                        // verbose internal error details (stack traces, DB constraint names).
                        // Fall back to the generic i18n string for unexpected errors.
                        const MAX_ERR_LEN = 200;
                        const rawMsg =
                            (body as { message?: string; error?: string }).message ??
                            (body as { error?: string }).error;
                        const displayMsg =
                            typeof rawMsg === 'string' && rawMsg.length > 0
                                ? rawMsg.length <= MAX_ERR_LEN
                                    ? rawMsg
                                    : t('errors.generic')
                                : t('errors.generic');
                        setSubmitError(displayMsg);
                        return;
                    }
                    const payload = (await res.json()) as
                        | OrganizationResponse
                        | { organization: OrganizationResponse };
                    // The importer wraps the org in a report envelope;
                    // the plain create returns it bare.
                    const org =
                        'organization' in payload && payload.organization
                            ? payload.organization
                            : (payload as OrganizationResponse);
                    // Refresh the org list so the switcher updates and
                    // subsequent first-Org checks aren't fooled.
                    //
                    // **Best-effort**: the POST already succeeded; the Org
                    // exists. A transient 500/401/network failure on the
                    // follow-up GET /api/organizations must NOT surface as
                    // a creation error — otherwise the user retries and
                    // we end up with duplicate Orgs. (Codex P2 on PR
                    // #1063.) The switcher will pick up the new Org on
                    // its next natural refresh.
                    try {
                        await mutate();
                    } catch {
                        // Swallow — see comment above.
                    }
                    if (wasFirstOrgRef.current && !importing) {
                        // Keep the parent modal mounted but hidden behind
                        // the upgrade dialog so the user can't backtrack
                        // into a half-finished form. Template imports skip
                        // the upgrade branch: their org is already populated
                        // and org-stamped, so pulling bare-Tenant rows in is
                        // a separate, later decision (settings), not a
                        // first-run fork.
                        setCreatedOrg(org);
                        setShowUpgradeDialog(true);
                    } else {
                        onOpenChange(false);
                        // Security: validate slug matches expected alphanumeric-dash
                        // pattern before interpolating into the router path to prevent
                        // an open redirect if the API ever returns a malformed slug.
                        if (/^[a-z0-9-]+$/.test(org.slug)) {
                            router.push(`/${org.slug}/dashboard`);
                        }
                    }
                } catch (err) {
                    setSubmitError(err instanceof Error ? err.message : t('errors.generic'));
                }
            })();
        });
    }, [name, vision, selectedTemplate, organizations.length, mutate, onOpenChange, router, t]);

    const handlePickTemplate = useCallback(
        (slug: string | null) => {
            setSelectedTemplate(slug);
            if (slug) {
                const tpl = templates.find((entry) => entry.slug === slug);
                // Prefill the org name from the template when the user
                // hasn't typed one yet — still fully editable.
                if (tpl && name.trim().length === 0) {
                    setName(tpl.name);
                }
            }
        },
        [templates, name],
    );

    const handleUpgradeDialogClose = useCallback(
        (didUpgrade: boolean) => {
            setShowUpgradeDialog(false);
            const target = createdOrg;
            // Reset modal state then close the outer dialog. Navigation
            // happens after close so a route change doesn't fight the
            // transition.
            setCreatedOrg(null);
            onOpenChange(false);
            if (target) {
                // Security: validate slug matches expected alphanumeric-dash
                // pattern before interpolating into the router path to prevent
                // an open redirect if the API ever returns a malformed slug.
                if (/^[a-z0-9-]+$/.test(target.slug)) {
                    router.push(`/${target.slug}/dashboard`);
                }
                // Pull the freshly-upgraded org list (tenantId is now set
                // on the user, so subsequent fetches reflect that).
                if (didUpgrade) void mutate();
            }
        },
        [createdOrg, mutate, onOpenChange, router],
    );

    // Hide the modal panel while the upgrade dialog is visible so the
    // user only sees one surface at a time. The Dialog `open` prop stays
    // true so the create-modal state isn't reset mid-flow.
    const showCreatePanel = !showUpgradeDialog;

    return (
        <>
            <Dialog open={open} onOpenChange={onOpenChange}>
                {showCreatePanel && (
                    <DialogContent className="max-w-md">
                        <DialogClose onClose={() => onOpenChange(false)} />
                        <DialogHeader>
                            <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                                {t('title')}
                            </DialogTitle>
                            <DialogDescription>{t('description')}</DialogDescription>
                        </DialogHeader>

                        <div className="space-y-4">
                            {templates.length > 0 && (
                                <div>
                                    <div className="mb-2 text-sm font-medium text-text-secondary dark:text-text-secondary-dark">
                                        {t('templates.label')}
                                    </div>
                                    <div
                                        className="grid max-h-56 grid-cols-1 gap-2 overflow-y-auto pr-1"
                                        data-testid="org-template-list"
                                    >
                                        <TemplateCard
                                            selected={selectedTemplate === null}
                                            title={t('templates.blankTitle')}
                                            description={t('templates.blankDescription')}
                                            testId="org-template-chip-blank"
                                            onSelect={() => handlePickTemplate(null)}
                                            disabled={pending}
                                        />
                                        {templates.map((tpl) => (
                                            <TemplateCard
                                                key={tpl.slug}
                                                selected={selectedTemplate === tpl.slug}
                                                title={tpl.name}
                                                description={tpl.description}
                                                meta={t('templates.meta', {
                                                    agents: tpl.agents,
                                                    teams: tpl.teams,
                                                })}
                                                testId={`org-template-chip-${tpl.slug}`}
                                                onSelect={() => handlePickTemplate(tpl.slug)}
                                                disabled={pending}
                                            />
                                        ))}
                                    </div>
                                </div>
                            )}

                            <Input
                                label={t('nameLabel')}
                                type="text"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder={t('namePlaceholder')}
                                maxLength={MAX_NAME_LENGTH}
                                autoFocus
                                disabled={pending}
                                error={submitError ?? undefined}
                            />

                            <SlugPreview
                                preview={slugPreview}
                                status={slugStatus}
                                t={t}
                                hasName={name.trim().length > 0}
                            />

                            {/*
                             * PR-6 — optional, collapsed-by-default Vision.
                             * Secondary affordance on purpose: creating an
                             * Organization must stay a single-field flow.
                             */}
                            {!showVision ? (
                                <button
                                    type="button"
                                    onClick={() => setShowVision(true)}
                                    disabled={pending}
                                    data-testid="vision-toggle"
                                    className="text-xs text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark underline underline-offset-2 transition-colors"
                                >
                                    {t('visionToggle')}
                                </button>
                            ) : (
                                <Textarea
                                    label={t('visionLabel')}
                                    value={vision}
                                    onChange={(e) => setVision(e.target.value)}
                                    placeholder={t('visionPlaceholder')}
                                    helperText={t('visionHelp')}
                                    maxLength={MAX_VISION_LENGTH}
                                    rows={3}
                                    disabled={pending}
                                    data-testid="vision-input"
                                />
                            )}
                        </div>

                        <DialogFooter>
                            <Button
                                variant="ghost"
                                onClick={() => onOpenChange(false)}
                                disabled={pending}
                            >
                                {t('cancel')}
                            </Button>
                            <Button
                                onClick={handleSubmit}
                                loading={pending}
                                disabled={pending || name.trim().length === 0}
                                data-testid="org-create-submit"
                            >
                                {selectedTemplate ? t('templates.submitImport') : t('submit')}
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                )}
            </Dialog>

            {createdOrg && (
                <UpgradeOrCreateDialog
                    open={showUpgradeDialog}
                    organization={createdOrg}
                    onClose={handleUpgradeDialogClose}
                />
            )}
        </>
    );
}

/**
 * Teams & Prebuilt Companies (spec §4.4) — one selectable card in the
 * "Start from" grid. Radio-like behavior; plain buttons, no new deps.
 */
function TemplateCard({
    selected,
    title,
    description,
    meta,
    testId,
    onSelect,
    disabled,
}: {
    selected: boolean;
    title: string;
    description: string;
    meta?: string;
    testId: string;
    onSelect: () => void;
    disabled: boolean;
}) {
    return (
        <button
            type="button"
            onClick={onSelect}
            disabled={disabled}
            data-testid={testId}
            aria-pressed={selected}
            className={`rounded-lg border p-3 text-left transition-colors ${
                selected
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-primary/40 dark:border-border-dark'
            }`}
        >
            <div className="text-sm font-medium text-text dark:text-text-dark">{title}</div>
            <div className="mt-0.5 line-clamp-2 text-xs text-text-muted dark:text-text-muted-dark">
                {description}
            </div>
            {meta && (
                <div className="mt-1 text-[11px] text-text-secondary dark:text-text-secondary-dark">
                    {meta}
                </div>
            )}
        </button>
    );
}

function SlugPreview({
    preview,
    status,
    t,
    hasName,
}: {
    preview: string;
    status: SlugStatus;
    t: ReturnType<typeof useTranslations>;
    hasName: boolean;
}) {
    if (!hasName) {
        return null;
    }
    return (
        <div className="text-xs text-text-muted dark:text-text-muted-dark">
            <div>
                <span className="font-medium text-text-secondary dark:text-text-secondary-dark">
                    {t('slugPreview')}
                </span>{' '}
                <span
                    className="font-mono text-text dark:text-text-dark"
                    data-testid="slug-preview-value"
                >
                    {preview || '—'}
                </span>
            </div>
            <div className="mt-1" data-testid="slug-status">
                {status.kind === 'checking' && <span>{t('slugChecking')}</span>}
                {status.kind === 'available' && (
                    <span className="text-success">{t('slugAvailable')}</span>
                )}
                {status.kind === 'taken' && (
                    <span className="text-warning">
                        {status.suggestion
                            ? t('slugTaken', { suggestion: status.suggestion })
                            : t('slugTakenNoSuggestion')}
                    </span>
                )}
                {status.kind === 'error' && (
                    <span className="text-text-muted dark:text-text-muted-dark">
                        {t('slugCheckError')}
                    </span>
                )}
            </div>
        </div>
    );
}

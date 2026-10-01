'use client';

import { useEffect, useId, useRef, useState, useTransition, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { saveEverIdSettings } from '@/app/actions/ever-id';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type {
    EverIdAdminSettings,
    EverIdAdminSettingsPatch,
    EverIdAdminStatus,
} from '@/lib/api/ever-id';
import {
    EVER_ID_ADMIN_SETTINGS_LIMITS as LIMITS,
    EVER_ID_LOCAL_CLIENT_KINDS,
    type EverIdLocalClientKind,
} from '@/lib/auth/ever-id';
import { cn } from '@/lib/utils';

interface EverIdAdminSettingsFormProps {
    settings: EverIdAdminSettings;
    /** Called with the status the API answered after a save. */
    onSaved: (status: EverIdAdminStatus) => void;
}

interface LocalClientRow {
    key: string;
    kind: EverIdLocalClientKind;
    clientId: string;
}

interface DelegatedNameRow {
    key: string;
    clientId: string;
    displayName: string;
}

interface Draft {
    displayName: string;
    accountManagementUrl: string;
    localClients: LocalClientRow[];
    delegatedClientNames: DelegatedNameRow[];
}

/** React keys for rows; never rendered, so they need not match across server and client. */
let rowSequence = 0;
function nextRowKey(): string {
    rowSequence += 1;
    return `row-${rowSequence}`;
}

function toDraft(settings: EverIdAdminSettings, keyFor: (index: number) => string): Draft {
    return {
        displayName: settings.displayName,
        accountManagementUrl: settings.accountManagementUrl ?? '',
        localClients: settings.localClients.map((client, index) => ({
            key: keyFor(index),
            kind: client.kind,
            clientId: client.clientId,
        })),
        delegatedClientNames: settings.delegatedClientNames.map((name, index) => ({
            key: keyFor(index),
            clientId: name.clientId,
            displayName: name.displayName,
        })),
    };
}

/** The draft as the API would store it: trimmed, and an empty address as `null`. */
function normalise(draft: Draft): EverIdAdminSettings {
    const url = draft.accountManagementUrl.trim();
    return {
        displayName: draft.displayName.trim(),
        accountManagementUrl: url === '' ? null : url,
        localClients: draft.localClients.map(({ kind, clientId }) => ({
            kind,
            clientId: clientId.trim(),
        })),
        delegatedClientNames: draft.delegatedClientNames.map(({ clientId, displayName }) => ({
            clientId: clientId.trim(),
            displayName: displayName.trim(),
        })),
    };
}

/** Only the values that differ from what the API last answered (a PATCH takes any subset). */
function toPatch(
    baseline: EverIdAdminSettings,
    next: EverIdAdminSettings,
): EverIdAdminSettingsPatch {
    const patch: EverIdAdminSettingsPatch = {};
    if (next.displayName !== baseline.displayName) {
        patch.displayName = next.displayName;
    }
    if (next.accountManagementUrl !== (baseline.accountManagementUrl ?? null)) {
        patch.accountManagementUrl = next.accountManagementUrl;
    }
    const clients = (list: EverIdAdminSettings['localClients']) =>
        JSON.stringify(list.map(({ kind, clientId }) => [kind, clientId]));
    if (clients(next.localClients) !== clients(baseline.localClients)) {
        patch.localClients = next.localClients;
    }
    const names = (list: EverIdAdminSettings['delegatedClientNames']) =>
        JSON.stringify(list.map(({ clientId, displayName }) => [clientId, displayName]));
    if (names(next.delegatedClientNames) !== names(baseline.delegatedClientNames)) {
        patch.delegatedClientNames = next.delegatedClientNames;
    }
    return patch;
}

const SELECT_CLASS = cn(
    'w-full text-sm rounded-lg transition-colors outline-none px-4 py-2',
    'bg-card dark:bg-card-primary-dark',
    'border border-card-border dark:border-white/9',
    'text-text dark:text-text-dark',
    'focus:border-primary focus:ring-2 focus:ring-primary-800/20 dark:focus:border-white/9',
);

const LABEL_CLASS = 'block text-xs font-medium text-text dark:text-text-dark mb-2';
const HELP_CLASS = 'text-xs text-text-muted dark:text-text-muted-dark';
const ROW_FIELDSET_CLASS = 'm-0 min-w-0 border-0 p-0';

/**
 * The administrator-managed Ever ID values (`PATCH /admin/settings`): the display
 * name, the account management address, the terminal clients (at most
 * {@link LIMITS.localClientsMax}) and the app names (at most
 * {@link LIMITS.delegatedClientNamesMax}). The issuer, the client and its secret
 * are environment configuration and are not editable here.
 *
 * Every input has a visible label; each row is its own group named "Terminal
 * client 2" and so on, and its Remove button says which row it removes. Add stops
 * at the limit and says why (the help text it is described by). A save sends only
 * what changed; a refusal is one `role="alert"` line, a success one polite status
 * line, and the form then shows the values the API answered (FR-52).
 */
export function EverIdAdminSettingsForm({ settings, onSaved }: EverIdAdminSettingsFormProps) {
    const t = useTranslations('dashboard.settings.admin.everId.settings');
    const baseId = useId();
    const headingId = `${baseId}-heading`;
    const displayNameHelpId = `${baseId}-display-name-help`;
    const urlHelpId = `${baseId}-url-help`;
    const localHelpId = `${baseId}-local-help`;
    const namesHelpId = `${baseId}-names-help`;
    const localAddId = `${baseId}-local-add`;
    const namesAddId = `${baseId}-names-add`;

    const [baseline, setBaseline] = useState<EverIdAdminSettings>(settings);
    const [draft, setDraft] = useState<Draft>(() =>
        toDraft(settings, (index) => `initial-${index}`),
    );
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [isSaving, startSaving] = useTransition();

    // Where keyboard focus goes after a row is added or removed; applied once the
    // DOM reflects the change (a just-enabled Add button cannot take focus before).
    const pendingFocus = useRef<string | null>(null);
    useEffect(() => {
        if (pendingFocus.current) {
            document.getElementById(pendingFocus.current)?.focus();
            pendingFocus.current = null;
        }
    });

    const localFieldId = (index: number, field: 'kind' | 'clientId') =>
        `${baseId}-local-${index}-${field}`;
    const nameFieldId = (index: number, field: 'clientId' | 'displayName') =>
        `${baseId}-name-${index}-${field}`;

    const edit = (change: (current: Draft) => Draft) => {
        setNotice(null);
        setDraft(change);
    };

    const addLocalClient = () => {
        if (draft.localClients.length >= LIMITS.localClientsMax) return;
        pendingFocus.current = localFieldId(draft.localClients.length, 'kind');
        edit((current) => ({
            ...current,
            localClients: [
                ...current.localClients,
                { key: nextRowKey(), kind: 'cli', clientId: '' },
            ],
        }));
    };

    const removeLocalClient = (index: number) => {
        pendingFocus.current = localAddId;
        edit((current) => ({
            ...current,
            localClients: current.localClients.filter((_, i) => i !== index),
        }));
    };

    const addDelegatedName = () => {
        if (draft.delegatedClientNames.length >= LIMITS.delegatedClientNamesMax) return;
        pendingFocus.current = nameFieldId(draft.delegatedClientNames.length, 'clientId');
        edit((current) => ({
            ...current,
            delegatedClientNames: [
                ...current.delegatedClientNames,
                { key: nextRowKey(), clientId: '', displayName: '' },
            ],
        }));
    };

    const removeDelegatedName = (index: number) => {
        pendingFocus.current = namesAddId;
        edit((current) => ({
            ...current,
            delegatedClientNames: current.delegatedClientNames.filter((_, i) => i !== index),
        }));
    };

    const onSubmit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setError(null);
        setNotice(null);

        const next = normalise(draft);
        const patch = toPatch(baseline, next);
        if (Object.keys(patch).length === 0) {
            setNotice(t('unchanged'));
            return;
        }

        startSaving(async () => {
            const result = await saveEverIdSettings(patch);
            if (!result.success) {
                setError(result.error);
                return;
            }
            const saved = result.status.settings ?? next;
            setBaseline(saved);
            setDraft(toDraft(saved, () => nextRowKey()));
            setNotice(t('saved'));
            onSaved(result.status);
        });
    };

    const localAtLimit = draft.localClients.length >= LIMITS.localClientsMax;
    const namesAtLimit = draft.delegatedClientNames.length >= LIMITS.delegatedClientNamesMax;

    return (
        <section aria-labelledby={headingId} className="space-y-3">
            <h3 id={headingId} className="text-lg font-medium text-text dark:text-text-dark">
                {t('title')}
            </h3>
            <p className="text-sm text-text-muted dark:text-text-muted-dark">{t('description')}</p>

            <form
                data-testid="ever-id-admin-settings-form"
                aria-labelledby={headingId}
                onSubmit={onSubmit}
                className="space-y-6"
            >
                <div className="space-y-1.5">
                    <Input
                        id={`${baseId}-display-name`}
                        name="displayName"
                        label={t('displayName.label')}
                        value={draft.displayName}
                        onChange={(event) => {
                            const value = event.target.value;
                            edit((current) => ({ ...current, displayName: value }));
                        }}
                        required
                        maxLength={LIMITS.displayNameMaxLength}
                        autoComplete="off"
                        aria-describedby={displayNameHelpId}
                    />
                    <p id={displayNameHelpId} className={HELP_CLASS}>
                        {t('displayName.help', { max: LIMITS.displayNameMaxLength })}
                    </p>
                </div>

                <div className="space-y-1.5">
                    <Input
                        id={`${baseId}-account-url`}
                        name="accountManagementUrl"
                        type="url"
                        inputMode="url"
                        label={t('accountManagementUrl.label')}
                        value={draft.accountManagementUrl}
                        onChange={(event) => {
                            const value = event.target.value;
                            edit((current) => ({ ...current, accountManagementUrl: value }));
                        }}
                        maxLength={LIMITS.accountManagementUrlMaxLength}
                        pattern={'https://\\S+'}
                        autoComplete="off"
                        spellCheck={false}
                        aria-describedby={urlHelpId}
                    />
                    <p id={urlHelpId} className={HELP_CLASS}>
                        {t('accountManagementUrl.help')}
                    </p>
                </div>

                <fieldset className="space-y-3" aria-describedby={localHelpId}>
                    <legend className="text-sm font-medium text-text dark:text-text-dark">
                        {t('localClients.legend')}
                    </legend>
                    <p id={localHelpId} className={HELP_CLASS}>
                        {t('localClients.help', { max: LIMITS.localClientsMax })}
                    </p>
                    {draft.localClients.length === 0 ? (
                        <p className="text-sm text-text-muted dark:text-text-muted-dark">
                            {t('localClients.empty')}
                        </p>
                    ) : (
                        <ul className="space-y-3">
                            {draft.localClients.map((row, index) => {
                                const rowName = t('localClients.row', { number: index + 1 });
                                return (
                                    <li
                                        key={row.key}
                                        data-testid={`ever-id-admin-local-client-${index}`}
                                    >
                                        <fieldset className={ROW_FIELDSET_CLASS}>
                                            <legend className="sr-only">{rowName}</legend>
                                            <div className="grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)_auto] sm:items-end">
                                                <div>
                                                    <label
                                                        htmlFor={localFieldId(index, 'kind')}
                                                        className={LABEL_CLASS}
                                                    >
                                                        {t('localClients.kind')}
                                                    </label>
                                                    <select
                                                        id={localFieldId(index, 'kind')}
                                                        value={row.kind}
                                                        onChange={(event) => {
                                                            const kind = event.target
                                                                .value as EverIdLocalClientKind;
                                                            edit((current) => ({
                                                                ...current,
                                                                localClients:
                                                                    current.localClients.map(
                                                                        (item, i) =>
                                                                            i === index
                                                                                ? { ...item, kind }
                                                                                : item,
                                                                    ),
                                                            }));
                                                        }}
                                                        className={SELECT_CLASS}
                                                    >
                                                        {EVER_ID_LOCAL_CLIENT_KINDS.map((kind) => (
                                                            <option key={kind} value={kind}>
                                                                {kind === 'cli'
                                                                    ? t('localClients.kindCli')
                                                                    : t('localClients.kindNode')}
                                                            </option>
                                                        ))}
                                                    </select>
                                                </div>
                                                <Input
                                                    id={localFieldId(index, 'clientId')}
                                                    label={t('localClients.clientId')}
                                                    value={row.clientId}
                                                    onChange={(event) => {
                                                        const clientId = event.target.value;
                                                        edit((current) => ({
                                                            ...current,
                                                            localClients: current.localClients.map(
                                                                (item, i) =>
                                                                    i === index
                                                                        ? { ...item, clientId }
                                                                        : item,
                                                            ),
                                                        }));
                                                    }}
                                                    required
                                                    maxLength={LIMITS.clientIdMaxLength}
                                                    autoComplete="off"
                                                    spellCheck={false}
                                                />
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    size="sm"
                                                    aria-label={t('localClients.remove', {
                                                        number: index + 1,
                                                    })}
                                                    onClick={() => removeLocalClient(index)}
                                                >
                                                    {t('remove')}
                                                </Button>
                                            </div>
                                        </fieldset>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                    <Button
                        id={localAddId}
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={addLocalClient}
                        disabled={localAtLimit}
                        aria-describedby={localHelpId}
                    >
                        {t('localClients.add')}
                    </Button>
                </fieldset>

                <fieldset className="space-y-3" aria-describedby={namesHelpId}>
                    <legend className="text-sm font-medium text-text dark:text-text-dark">
                        {t('delegatedClientNames.legend')}
                    </legend>
                    <p id={namesHelpId} className={HELP_CLASS}>
                        {t('delegatedClientNames.help', { max: LIMITS.delegatedClientNamesMax })}
                    </p>
                    {draft.delegatedClientNames.length === 0 ? (
                        <p className="text-sm text-text-muted dark:text-text-muted-dark">
                            {t('delegatedClientNames.empty')}
                        </p>
                    ) : (
                        <ul className="space-y-3">
                            {draft.delegatedClientNames.map((row, index) => {
                                const rowName = t('delegatedClientNames.row', {
                                    number: index + 1,
                                });
                                return (
                                    <li
                                        key={row.key}
                                        data-testid={`ever-id-admin-delegated-name-${index}`}
                                    >
                                        <fieldset className={ROW_FIELDSET_CLASS}>
                                            <legend className="sr-only">{rowName}</legend>
                                            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
                                                <Input
                                                    id={nameFieldId(index, 'clientId')}
                                                    label={t('delegatedClientNames.clientId')}
                                                    value={row.clientId}
                                                    onChange={(event) => {
                                                        const clientId = event.target.value;
                                                        edit((current) => ({
                                                            ...current,
                                                            delegatedClientNames:
                                                                current.delegatedClientNames.map(
                                                                    (item, i) =>
                                                                        i === index
                                                                            ? { ...item, clientId }
                                                                            : item,
                                                                ),
                                                        }));
                                                    }}
                                                    required
                                                    maxLength={LIMITS.clientIdMaxLength}
                                                    autoComplete="off"
                                                    spellCheck={false}
                                                />
                                                <Input
                                                    id={nameFieldId(index, 'displayName')}
                                                    label={t('delegatedClientNames.displayName')}
                                                    value={row.displayName}
                                                    onChange={(event) => {
                                                        const displayName = event.target.value;
                                                        edit((current) => ({
                                                            ...current,
                                                            delegatedClientNames:
                                                                current.delegatedClientNames.map(
                                                                    (item, i) =>
                                                                        i === index
                                                                            ? {
                                                                                  ...item,
                                                                                  displayName,
                                                                              }
                                                                            : item,
                                                                ),
                                                        }));
                                                    }}
                                                    required
                                                    maxLength={LIMITS.delegatedDisplayNameMaxLength}
                                                    autoComplete="off"
                                                />
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    size="sm"
                                                    aria-label={t('delegatedClientNames.remove', {
                                                        number: index + 1,
                                                    })}
                                                    onClick={() => removeDelegatedName(index)}
                                                >
                                                    {t('remove')}
                                                </Button>
                                            </div>
                                        </fieldset>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                    <Button
                        id={namesAddId}
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={addDelegatedName}
                        disabled={namesAtLimit}
                        aria-describedby={namesHelpId}
                    >
                        {t('delegatedClientNames.add')}
                    </Button>
                </fieldset>

                {error ? (
                    <p
                        role="alert"
                        data-testid="ever-id-admin-settings-error"
                        className="rounded-lg border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger"
                    >
                        {error}
                    </p>
                ) : null}

                <div className="flex flex-wrap items-center gap-3">
                    <Button
                        type="submit"
                        data-testid="ever-id-admin-settings-save"
                        loading={isSaving}
                        disabled={isSaving}
                    >
                        {isSaving ? t('saving') : t('save')}
                    </Button>
                    {/* Always present, so the polite announcement is not missed. */}
                    <p
                        role="status"
                        data-testid="ever-id-admin-settings-notice"
                        className="text-sm text-text dark:text-text-dark"
                    >
                        {notice}
                    </p>
                </div>
            </form>
        </section>
    );
}

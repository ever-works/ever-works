'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus, Trash2 } from 'lucide-react';
import {
    FLEET_RUN_RESTART_POLICIES,
    type FleetRunRequest,
    type FleetRunRestartPolicy,
} from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { EMPTY_RUN_FORM, requestFromForm, type RunForm } from './docker.shared';

const FIELD =
    'h-8 w-full rounded-md border border-border dark:border-border-dark bg-surface dark:bg-surface-dark px-2 text-sm';

/**
 * Docker tab (FL-09 P2, spec §5.5, S10, FR-28, FR-29) — "Run a container":
 * image, name, ports (`host → container`), environment variables (the value
 * field is masked: values are never stored or shown again), volumes (a named
 * volume or a folder under this computer's shared folders — the computer
 * refuses anything else), restart policy and command, with the exact
 * command line it will run shown before the person confirms (values masked).
 * The request is validated here with the same contracts validator the API and
 * the machine run; privileged mode, host namespaces and socket mounts cannot
 * even be expressed.
 */
export function RunContainerDialog({
    open,
    machine,
    initialImage,
    pending,
    onRun,
    onClose,
}: {
    open: boolean;
    machine: string;
    initialImage?: string;
    pending: boolean;
    onRun: (request: FleetRunRequest) => void;
    onClose: () => void;
}) {
    const t = useTranslations('fleet.docker.runDialog');
    const [form, setForm] = useState<RunForm>({ ...EMPTY_RUN_FORM, image: initialImage ?? '' });
    const built = useMemo(() => requestFromForm(form), [form]);
    if (!open) return null;

    const update = (patch: Partial<RunForm>) => setForm((previous) => ({ ...previous, ...patch }));

    return (
        <Dialog open onOpenChange={(next) => !next && onClose()}>
            <DialogContent>
                <DialogClose onClose={onClose} />
                <form
                    data-testid="fleet-docker-run-dialog"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (built.ok && !pending) onRun(built.request);
                    }}
                    className="space-y-3"
                >
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                            {t('title', { name: machine })}
                        </DialogTitle>
                        <DialogDescription>{t('pullsNote', { name: machine })}</DialogDescription>
                    </DialogHeader>
                    <label className="block space-y-1 text-sm">
                        <span>{t('image')}</span>
                        <input
                            className={FIELD}
                            value={form.image}
                            onChange={(event) => update({ image: event.target.value })}
                            placeholder="redis:7"
                            spellCheck={false}
                            data-testid="fleet-docker-run-image"
                        />
                    </label>
                    <label className="block space-y-1 text-sm">
                        <span>{t('name')}</span>
                        <input
                            className={FIELD}
                            value={form.name}
                            onChange={(event) => update({ name: event.target.value })}
                            placeholder="cache"
                            spellCheck={false}
                        />
                    </label>

                    <fieldset className="space-y-1 text-sm">
                        <legend>{t('ports')}</legend>
                        {form.ports.map((port, index) => (
                            <div key={index} className="flex items-center gap-2">
                                <input
                                    className={FIELD}
                                    inputMode="numeric"
                                    aria-label={t('hostPort')}
                                    value={port.host}
                                    onChange={(event) =>
                                        update({
                                            ports: form.ports.map((row, at) =>
                                                at === index
                                                    ? { ...row, host: event.target.value }
                                                    : row,
                                            ),
                                        })
                                    }
                                />
                                <span aria-hidden>→</span>
                                <input
                                    className={FIELD}
                                    inputMode="numeric"
                                    aria-label={t('containerPort')}
                                    value={port.container}
                                    onChange={(event) =>
                                        update({
                                            ports: form.ports.map((row, at) =>
                                                at === index
                                                    ? { ...row, container: event.target.value }
                                                    : row,
                                            ),
                                        })
                                    }
                                />
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    aria-label={t('removeRow')}
                                    onClick={() =>
                                        update({
                                            ports: form.ports.filter((_, at) => at !== index),
                                        })
                                    }
                                >
                                    <Trash2 className="h-4 w-4" aria-hidden />
                                </Button>
                            </div>
                        ))}
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                                update({
                                    ports: [
                                        ...form.ports,
                                        { host: '', container: '', proto: 'tcp' },
                                    ],
                                })
                            }
                        >
                            <Plus className="h-4 w-4" aria-hidden /> {t('addPort')}
                        </Button>
                    </fieldset>

                    <fieldset className="space-y-1 text-sm">
                        <legend>{t('env')}</legend>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('envNote')}
                        </p>
                        {form.env.map((variable, index) => (
                            <div key={index} className="flex items-center gap-2">
                                <input
                                    className={FIELD}
                                    aria-label={t('envName')}
                                    value={variable.name}
                                    spellCheck={false}
                                    onChange={(event) =>
                                        update({
                                            env: form.env.map((row, at) =>
                                                at === index
                                                    ? { ...row, name: event.target.value }
                                                    : row,
                                            ),
                                        })
                                    }
                                />
                                <input
                                    className={FIELD}
                                    type="password"
                                    autoComplete="off"
                                    aria-label={t('envValue')}
                                    value={variable.value}
                                    onChange={(event) =>
                                        update({
                                            env: form.env.map((row, at) =>
                                                at === index
                                                    ? { ...row, value: event.target.value }
                                                    : row,
                                            ),
                                        })
                                    }
                                    data-testid="fleet-docker-run-env-value"
                                />
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    aria-label={t('removeRow')}
                                    onClick={() =>
                                        update({ env: form.env.filter((_, at) => at !== index) })
                                    }
                                >
                                    <Trash2 className="h-4 w-4" aria-hidden />
                                </Button>
                            </div>
                        ))}
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => update({ env: [...form.env, { name: '', value: '' }] })}
                        >
                            <Plus className="h-4 w-4" aria-hidden /> {t('addEnv')}
                        </Button>
                    </fieldset>

                    <fieldset className="space-y-1 text-sm">
                        <legend>{t('volumes')}</legend>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('volumesNote', { name: machine })}
                        </p>
                        {form.volumes.map((volume, index) => (
                            <div key={index} className="flex items-center gap-2">
                                <input
                                    className={FIELD}
                                    aria-label={t('volumeSource')}
                                    placeholder="pgdata"
                                    value={volume.source}
                                    spellCheck={false}
                                    onChange={(event) =>
                                        update({
                                            volumes: form.volumes.map((row, at) =>
                                                at === index
                                                    ? { ...row, source: event.target.value }
                                                    : row,
                                            ),
                                        })
                                    }
                                />
                                <span aria-hidden>→</span>
                                <input
                                    className={FIELD}
                                    aria-label={t('volumeTarget')}
                                    placeholder="/data"
                                    value={volume.target}
                                    spellCheck={false}
                                    onChange={(event) =>
                                        update({
                                            volumes: form.volumes.map((row, at) =>
                                                at === index
                                                    ? { ...row, target: event.target.value }
                                                    : row,
                                            ),
                                        })
                                    }
                                />
                                <label className="flex items-center gap-1 text-xs">
                                    <input
                                        type="checkbox"
                                        checked={volume.readOnly}
                                        onChange={(event) =>
                                            update({
                                                volumes: form.volumes.map((row, at) =>
                                                    at === index
                                                        ? { ...row, readOnly: event.target.checked }
                                                        : row,
                                                ),
                                            })
                                        }
                                    />
                                    {t('readOnly')}
                                </label>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    aria-label={t('removeRow')}
                                    onClick={() =>
                                        update({
                                            volumes: form.volumes.filter((_, at) => at !== index),
                                        })
                                    }
                                >
                                    <Trash2 className="h-4 w-4" aria-hidden />
                                </Button>
                            </div>
                        ))}
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                                update({
                                    volumes: [
                                        ...form.volumes,
                                        { source: '', target: '', readOnly: false },
                                    ],
                                })
                            }
                        >
                            <Plus className="h-4 w-4" aria-hidden /> {t('addVolume')}
                        </Button>
                    </fieldset>

                    <label className="block space-y-1 text-sm">
                        <span>{t('restart')}</span>
                        <select
                            className={FIELD}
                            value={form.restart}
                            onChange={(event) =>
                                update({ restart: event.target.value as FleetRunRestartPolicy })
                            }
                        >
                            {FLEET_RUN_RESTART_POLICIES.map((policy) => (
                                <option key={policy} value={policy}>
                                    {policy}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="block space-y-1 text-sm">
                        <span>{t('command')}</span>
                        <input
                            className={FIELD}
                            value={form.command}
                            onChange={(event) => update({ command: event.target.value })}
                            spellCheck={false}
                        />
                    </label>

                    {built.ok ? (
                        <div className="space-y-1">
                            <span className="text-xs uppercase text-text-muted dark:text-text-muted-dark">
                                {t('preview')}
                            </span>
                            <code
                                className="block break-all rounded bg-surface-secondary dark:bg-surface-secondary-dark p-2 font-mono text-xs"
                                data-testid="fleet-docker-run-preview"
                            >
                                {built.preview}
                            </code>
                        </div>
                    ) : form.image.trim() ? (
                        <p
                            role="alert"
                            className="text-sm text-danger"
                            data-testid="fleet-docker-run-invalid"
                        >
                            {built.hint}
                        </p>
                    ) : null}

                    <DialogFooter>
                        <Button type="button" variant="secondary" onClick={onClose}>
                            {t('cancel')}
                        </Button>
                        <Button
                            type="submit"
                            variant="primary"
                            disabled={!built.ok}
                            loading={pending}
                            data-testid="fleet-docker-run-confirm"
                        >
                            {t('run')}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
    FLEET_VIRTUAL_CPU_CHOICES,
    FLEET_VIRTUAL_DISK_GIB_CHOICES,
    FLEET_VIRTUAL_MEMORY_GIB_CHOICES,
    fleetVirtualCreateSummary,
    isFleetVirtualName,
    type FleetLinkError,
    type FleetVirtualCreateResponse,
    type FleetVirtualOptionsView,
    type FleetVirtualSystem,
} from '@ever-works/contracts';
import { createFleetVirtualAction, fleetVirtualOptionsAction } from '@/app/actions/fleet/virtual';
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
import {
    effectiveHost,
    formatGiB,
    initialVirtualForm,
    VIRTUAL_REASON_KEYS,
    type VirtualForm,
} from './virtual.shared';

const FIELD =
    'h-8 w-full rounded-md border border-border dark:border-border-dark bg-surface dark:bg-surface-dark px-2 text-sm';
const DEFAULT_SYSTEM: FleetVirtualSystem['id'] = 'ubuntu-26.04';

/**
 * Virtual computers (FL-16, spec §0, §5.2, FR-1 – FR-12) — "New virtual
 * computer": name, system (grouped **VM** / **Container**; a Container is
 * never called a VM), host ("Choose for me" names the host it picked before
 * Create — S3; a host that cannot serve the system is greyed with its reason),
 * CPUs, memory and — for Windows only — disk. The note says, before Create,
 * that the machine uses the host's CPU, memory and disk and that nothing is
 * billed. Create sends `confirm: true` (the dialog IS the confirmation, its
 * summary the same sentence the API's 409 carries); a refusal shows its hint
 * inline.
 */
export function NewVirtualComputerDialog({
    open,
    hostNodeId = null,
    onClose,
    onCreated,
}: {
    open: boolean;
    /** Preselect this host (the host page's "New virtual computer…"); null = "Choose for me". */
    hostNodeId?: string | null;
    onClose: () => void;
    onCreated?: (created: FleetVirtualCreateResponse) => void;
}) {
    const t = useTranslations('fleet.virtual');
    const [form, setForm] = useState<VirtualForm>(() => initialVirtualForm(DEFAULT_SYSTEM, hostNodeId));
    const [options, setOptions] = useState<FleetVirtualOptionsView | null>(null);
    const [loadError, setLoadError] = useState<FleetLinkError | null>(null);
    const [error, setError] = useState<FleetLinkError | null>(null);
    const [pending, startTransition] = useTransition();

    // Load (and re-judge) the hosts whenever the dialog opens or the system changes.
    useEffect(() => {
        if (!open) return;
        let live = true;
        setLoadError(null);
        void fleetVirtualOptionsAction(hostNodeId ?? 'auto', form.systemId).then((result) => {
            if (!live) return;
            if (result.ok) setOptions(result.data);
            else setLoadError(result.error);
        });
        return () => {
            live = false;
        };
    }, [open, hostNodeId, form.systemId]);

    useEffect(() => {
        if (open) {
            setForm(initialVirtualForm(DEFAULT_SYSTEM, hostNodeId));
            setError(null);
        }
    }, [open, hostNodeId]);

    const systems = options?.systems ?? [];
    const system = systems.find((entry) => entry.id === form.systemId) ?? null;
    const isVm = system?.kind === 'vm';
    const hosts = options?.hosts ?? [];
    const host = effectiveHost(form, hosts, options?.autoPickNodeId ?? null);
    const nameValid = isFleetVirtualName(form.name);
    const canCreate = Boolean(options && system && host && host.eligible && nameValid && !pending);

    const summary = useMemo(
        () =>
            system && host
                ? fleetVirtualCreateSummary({
                      system,
                      hostName: host.name,
                      cpus: form.cpus,
                      memoryGiB: form.memoryGiB,
                      diskGiB: isVm ? form.diskGiB : null,
                  })
                : null,
        [system, host, form.cpus, form.memoryGiB, form.diskGiB, isVm],
    );

    const set = <K extends keyof VirtualForm>(key: K, value: VirtualForm[K]) =>
        setForm((previous) => ({ ...previous, [key]: value }));

    const create = () => {
        if (!canCreate || !system) return;
        setError(null);
        startTransition(async () => {
            const result = await createFleetVirtualAction(form.hostNodeId === 'auto' ? 'auto' : form.hostNodeId, {
                name: form.name,
                systemId: system.id,
                hostNodeId: form.hostNodeId === 'auto' ? null : form.hostNodeId,
                cpus: form.cpus as 2 | 4 | 8,
                memoryGiB: form.memoryGiB as 4 | 8 | 16,
                ...(isVm ? { diskGiB: form.diskGiB as 64 | 128 | 256 } : {}),
                confirm: true,
            });
            if (result.ok) {
                toast.success(t('create.created', { name: form.name, host: host?.name ?? '' }));
                onCreated?.(result.data);
                onClose();
            } else {
                setError(result.error);
            }
        });
    };

    const containers = systems.filter((entry) => entry.kind === 'container');
    const vms = systems.filter((entry) => entry.kind === 'vm');
    const reason = (option: (typeof hosts)[number]) =>
        option.reason ? t(`reasons.${VIRTUAL_REASON_KEYS[option.reason]}`, { name: option.name, limit: 4 }) : null;

    return (
        <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
            <DialogContent className="max-w-xl" data-testid="fleet-virtual-dialog">
                <DialogHeader>
                    <DialogTitle>{t('create.title')}</DialogTitle>
                    <DialogDescription>{t('create.description')}</DialogDescription>
                </DialogHeader>

                {loadError ? (
                    <p className="text-sm text-danger" role="alert">
                        {loadError.hint || t('create.loadFailed')}
                    </p>
                ) : null}

                <div className="flex flex-col gap-3 text-sm">
                    <label className="flex flex-col gap-1">
                        <span className="font-medium">{t('create.name')}</span>
                        <input
                            className={FIELD}
                            value={form.name}
                            onChange={(event) => set('name', event.target.value.toLowerCase())}
                            placeholder="ubuntu-nina"
                            maxLength={39}
                            aria-invalid={form.name.length > 0 && !nameValid}
                            data-testid="fleet-virtual-name"
                        />
                        {form.name.length > 0 && !nameValid ? (
                            <span className="text-xs text-danger">{t('create.nameHint')}</span>
                        ) : null}
                    </label>

                    <fieldset className="flex flex-col gap-1">
                        <legend className="font-medium">{t('create.system')}</legend>
                        {vms.length > 0 ? (
                            <SystemGroup
                                label={t('create.groupVm')}
                                systems={vms}
                                value={form.systemId}
                                onChange={(id) => set('systemId', id)}
                            />
                        ) : null}
                        <SystemGroup
                            label={t('create.groupContainer')}
                            systems={containers}
                            value={form.systemId}
                            onChange={(id) => set('systemId', id)}
                        />
                    </fieldset>

                    <label className="flex flex-col gap-1">
                        <span className="font-medium">{t('create.host')}</span>
                        <select
                            className={FIELD}
                            value={form.hostNodeId}
                            onChange={(event) => set('hostNodeId', event.target.value)}
                            data-testid="fleet-virtual-host"
                            disabled={!options}
                        >
                            <option value="auto">
                                {options?.autoPickNodeId
                                    ? t('create.chooseForMeNamed', {
                                          name: hosts.find((entry) => entry.nodeId === options.autoPickNodeId)?.name ?? '',
                                      })
                                    : t('create.chooseForMe')}
                            </option>
                            {hosts.map((option) => (
                                <option key={option.nodeId} value={option.nodeId} disabled={!option.eligible}>
                                    {option.eligible
                                        ? t('create.hostLine', {
                                              name: option.name,
                                              memory: formatGiB(option.freeMemoryMiB) ?? '—',
                                              disk: formatGiB(option.freeDiskMiB) ?? '—',
                                          })
                                        : `${option.name} — ${reason(option)}`}
                                </option>
                            ))}
                        </select>
                        {host && !host.eligible ? <span className="text-xs text-danger">{reason(host)}</span> : null}
                        {!host && options && !options.autoPickNodeId ? (
                            <span className="text-xs text-text-muted dark:text-text-muted-dark">{t('menu.noHost')}</span>
                        ) : null}
                    </label>

                    <div className="flex flex-wrap gap-4">
                        <Choice
                            legend={t('create.cpus')}
                            choices={FLEET_VIRTUAL_CPU_CHOICES}
                            value={form.cpus}
                            format={(value) => String(value)}
                            onChange={(value) => set('cpus', value)}
                        />
                        <Choice
                            legend={t('create.memory')}
                            choices={FLEET_VIRTUAL_MEMORY_GIB_CHOICES}
                            value={form.memoryGiB}
                            format={(value) => `${value} GB`}
                            onChange={(value) => set('memoryGiB', value)}
                        />
                        {isVm ? (
                            <Choice
                                legend={t('create.disk')}
                                choices={FLEET_VIRTUAL_DISK_GIB_CHOICES}
                                value={form.diskGiB}
                                format={(value) => `${value} GB`}
                                onChange={(value) => set('diskGiB', value)}
                            />
                        ) : null}
                    </div>

                    <p className="rounded-md bg-surface-secondary dark:bg-surface-secondary-dark p-2 text-xs" data-testid="fleet-virtual-note">
                        {isVm
                            ? t('create.noteVm', { host: host?.name ?? '' })
                            : t('create.noteContainer', { host: host?.name ?? t('create.theHost') })}
                    </p>
                    {summary ? (
                        <p className="text-xs text-text-muted dark:text-text-muted-dark" data-testid="fleet-virtual-summary">
                            {summary}
                        </p>
                    ) : null}
                    {error ? (
                        <p className="text-sm text-danger" role="alert" data-testid="fleet-virtual-error">
                            {error.hint || t('create.failed')}
                        </p>
                    ) : null}
                </div>

                <DialogFooter>
                    <DialogClose asChild>
                        <Button type="button" variant="ghost">
                            {t('create.cancel')}
                        </Button>
                    </DialogClose>
                    <Button type="button" onClick={create} disabled={!canCreate} data-testid="fleet-virtual-create">
                        {isVm ? t('create.createVm') : t('create.createContainer')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function SystemGroup({
    label,
    systems,
    value,
    onChange,
}: {
    label: string;
    systems: FleetVirtualSystem[];
    value: string;
    onChange: (id: FleetVirtualSystem['id']) => void;
}) {
    return (
        <div className="flex flex-wrap items-center gap-3">
            <span className="w-20 text-xs uppercase text-text-muted dark:text-text-muted-dark">{label}</span>
            {systems.map((system) => (
                <label key={system.id} className="inline-flex items-center gap-1">
                    <input
                        type="radio"
                        name="fleet-virtual-system"
                        value={system.id}
                        checked={value === system.id}
                        onChange={() => onChange(system.id)}
                    />
                    {system.label}
                </label>
            ))}
        </div>
    );
}

function Choice<T extends number>({
    legend,
    choices,
    value,
    format,
    onChange,
}: {
    legend: string;
    choices: readonly T[];
    value: number;
    format: (value: T) => string;
    onChange: (value: T) => void;
}) {
    return (
        <fieldset className="flex items-center gap-2">
            <legend className="sr-only">{legend}</legend>
            <span className="font-medium" aria-hidden>
                {legend}
            </span>
            {choices.map((choice) => (
                <label key={choice} className="inline-flex items-center gap-1">
                    <input type="radio" checked={value === choice} onChange={() => onChange(choice)} />
                    {format(choice)}
                </label>
            ))}
        </fieldset>
    );
}

import {
    fleetRunPreview,
    validateFleetRunRequest,
    type FleetContainerPort,
    type FleetContainerView,
    type FleetImageView,
    type FleetRunRequest,
    type FleetRunRestartPolicy,
} from '@ever-works/contracts';

/**
 * Docker tab (FL-09 P2, spec §5.5) — the pure part: port text, row glyphs,
 * the Runs here list, and the Run dialog's form → request, validated with
 * the SAME contracts validator the API and the machine run (FR-28), and its
 * preview line with every environment value masked (FR-29).
 */

/** `:3000→3000`, `(internal)` for an exposed-only port, joined. */
export function portsText(ports: readonly FleetContainerPort[]): string {
    if (ports.length === 0) return '—';
    return ports
        .map((port) =>
            port.hostPort === null
                ? `(internal ${port.containerPort})`
                : `:${port.hostPort}→${port.containerPort}${port.proto === 'tcp' ? '' : `/${port.proto}`}`,
        )
        .join(' ');
}

export function containerGlyph(container: Pick<FleetContainerView, 'state'>): '●' | '○' {
    return container.state === 'running' || container.state === 'restarting' ? '●' : '○';
}

/** Running first, then by name — the Containers list and the Overview's Runs here (spec §5.8). */
export function sortContainers(containers: readonly FleetContainerView[]): FleetContainerView[] {
    const rank = (row: FleetContainerView) => (row.state === 'running' ? 0 : row.state === 'restarting' ? 1 : 2);
    return [...containers].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** The image's display name: its first tag, or its id when dangling. */
export function imageName(image: Pick<FleetImageView, 'repoTags' | 'id'>): string {
    return image.repoTags[0] ?? image.id;
}

/** One editable row of the Run dialog. */
export interface RunFormPort {
    host: string;
    container: string;
    proto: 'tcp' | 'udp';
}

export interface RunFormEnv {
    name: string;
    value: string;
}

export interface RunFormVolume {
    source: string;
    target: string;
    readOnly: boolean;
}

export interface RunForm {
    image: string;
    name: string;
    ports: RunFormPort[];
    env: RunFormEnv[];
    volumes: RunFormVolume[];
    restart: FleetRunRestartPolicy;
    /** The command as one line; split on whitespace, with "double quotes" grouping an argument. */
    command: string;
}

export const EMPTY_RUN_FORM: RunForm = {
    image: '',
    name: '',
    ports: [],
    env: [],
    volumes: [],
    restart: 'unless-stopped',
    command: '',
};

/** Split a command line into argv the way a person expects: whitespace, with "…" or '…' grouping. */
export function splitCommand(line: string): string[] {
    const out: string[] = [];
    const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) !== null) out.push(match[1] ?? match[2] ?? match[3] ?? '');
    return out;
}

/** The form → the request the API takes, validated with the shared validator; blank rows are dropped. */
export function requestFromForm(
    form: RunForm,
): { ok: true; request: FleetRunRequest; preview: string } | { ok: false; field: string; hint: string } {
    const raw: Record<string, unknown> = {
        image: form.image.trim(),
        ports: form.ports
            .filter((port) => port.host.trim() || port.container.trim())
            .map((port) => ({ host: Number(port.host), container: Number(port.container), proto: port.proto })),
        env: form.env.filter((variable) => variable.name.trim()).map((variable) => ({ name: variable.name.trim(), value: variable.value })),
        volumes: form.volumes
            .filter((volume) => volume.source.trim() || volume.target.trim())
            .map((volume) => ({ source: volume.source.trim(), target: volume.target.trim(), readOnly: volume.readOnly })),
        restart: form.restart,
    };
    if (form.name.trim()) raw.name = form.name.trim();
    const command = splitCommand(form.command);
    if (command.length > 0) raw.command = command;
    const validated = validateFleetRunRequest(raw);
    if (!validated.ok) return validated;
    return { ok: true, request: validated.request, preview: fleetRunPreview(validated.request) };
}

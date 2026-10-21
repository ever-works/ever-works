import type { FleetCloudSoftwareId } from '@ever-works/contracts';

/**
 * Cloud computers (FL-17, spec FR-8, FR-9, plan §6, CONTRACTS R-20) — the
 * first-boot script a cloud computer runs: a `#cloud-config` document the
 * platform generates and the provider plugin passes through untouched (one
 * generator for every provider; the token never reaches plugin code paths
 * that log).
 *
 * What it does, in order:
 *
 *  1. creates the unprivileged user `ever` (the node runs as it, never root),
 *     with the throwaway public key so the provider sends no root password —
 *     its private half was discarded before the create (FR-9);
 *  2. writes the ONE secret it carries — the one-time, 15-minute enrolment
 *     token — to `/run/ever-works/enroll-token` (tmpfs, 0600), never to a
 *     command line;
 *  3. writes the systemd template unit (the shipped `ever-works-node@.service`,
 *     whose `ExecStart` here is `start --work --manage` — spec FR-8; no
 *     `--attend`), and the bootstrap itself (no secret in it);
 *  4. installs the chosen software: Docker from the distribution vendor's
 *     official repository, Node.js (always — the runtime needs it) from the
 *     official build checked against its published SHA-256 list, the pinned
 *     `ever-works-node` and, when chosen, the coding-agent CLIs;
 *  5. `sudo -u ever ever-works-node enroll --token-file …` — the node reads and
 *     DELETES the file; the bootstrap deletes it again as a belt;
 *  6. `systemctl enable --now ever-works-node@ever` and writes
 *     `/var/lib/ever-works-node/bootstrap.done`.
 *
 * Every value embedded in the document is validated against a strict pattern
 * first ({@link assertBootstrapSafe}): nothing a caller supplies can break out
 * of a YAML scalar or a shell word. The platform keeps no copy of the result.
 */

/** The `ever-works-node` version a cloud computer installs unless the operator pins another (plan §3). */
export const FLEET_CLOUD_DEFAULT_RUNTIME_VERSION = '0.2.7';

/** The Node.js major line the bootstrap installs (the platform's own runtime line). */
export const FLEET_CLOUD_NODE_MAJOR = 26;

/** Where the token lives on the machine for its single use (tmpfs, 0600). */
export const FLEET_CLOUD_TOKEN_PATH = '/run/ever-works/enroll-token';

/** The node's state directory (the systemd unit's `StateDirectory`). */
export const FLEET_CLOUD_STATE_DIR = '/var/lib/ever-works-node';

/** Written last; reconciliation and support read it to know the bootstrap finished. */
export const FLEET_CLOUD_BOOTSTRAP_DONE = `${FLEET_CLOUD_STATE_DIR}/bootstrap.done`;

/** The user the node runs as on a cloud computer. */
export const FLEET_CLOUD_NODE_USER = 'ever';

/** npm packages of the coding-agent presets (plan §6). */
const AGENT_CLI_PACKAGES: Partial<Record<FleetCloudSoftwareId, string>> = {
    'claude-code': '@anthropic-ai/claude-code',
    codex: '@openai/codex',
};

export interface CloudBootstrapInput {
    /** The Node the machine enrols as (also its provider tag). */
    nodeId: string;
    /** The machine's name (validated: `^[a-z0-9][a-z0-9-]{1,38}$`). */
    name: string;
    /** The API origin the machine enrols against (`https://api.example.com`). */
    apiUrl: string;
    /** The one-time enrolment token (base64url). Only ever written to the 0600 file. */
    token: string;
    /** `ever-works-node@<version>` or an `https://….tgz` (operator override). */
    runtimeSpec: string;
    software: readonly FleetCloudSoftwareId[];
    /** The throwaway OpenSSH public key (FR-9). */
    publicKey?: string | null;
    /**
     * P3 (spec FR-32) — the overlay-VPN client: the operator's install script
     * URL and the one-time auth key entered at create time. Passed into the
     * document once, never stored. Absent = not installed.
     */
    overlayVpn?: {
        installScriptUrl: string;
        /**
         * The operator's join command with a `{keyFile}` placeholder
         * (`/usr/bin/vpn-client up --auth-key-file={keyFile}`), or null to install
         * only. The key is handed over as a 0600 file, never on a command line.
         */
        joinCommand: string | null;
        authKey: string | null;
    } | null;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const API_URL_PATTERN = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~/-]*)?$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,200}$/;
const RUNTIME_SPEC_PATTERN =
    /^ever-works-node(?:@[A-Za-z0-9._+-]{1,64})?$|^https:\/\/[A-Za-z0-9./_~%+-]{1,300}\.tgz$/;
const PUBLIC_KEY_PATTERN = /^ssh-ed25519 [A-Za-z0-9+/=]{40,120}(?: [A-Za-z0-9._-]{1,60})?$/;
const INSTALL_URL_PATTERN = /^https:\/\/[A-Za-z0-9.-]+(?:\/[A-Za-z0-9._~/-]*)?$/;
const VPN_KEY_PATTERN = /^[A-Za-z0-9_:-]{8,200}$/;
const JOIN_COMMAND_PATTERN = /^\/[A-Za-z0-9._/-]+(?: [A-Za-z0-9._/=:-]+)*$/;

/** Where the overlay-VPN key waits for its single use (tmpfs, 0600). */
export const FLEET_CLOUD_VPN_KEY_PATH = '/run/ever-works/overlay-vpn-key';

/** Throws on any value that could escape its YAML scalar or shell word. */
export function assertBootstrapSafe(input: CloudBootstrapInput): void {
    if (!UUID_PATTERN.test(input.nodeId)) throw new Error('bootstrap: the node id is not a uuid');
    if (!NAME_PATTERN.test(input.name)) throw new Error('bootstrap: the name is not a valid computer name');
    if (!API_URL_PATTERN.test(input.apiUrl)) throw new Error('bootstrap: the API URL is not a plain http(s) origin');
    if (!TOKEN_PATTERN.test(input.token)) throw new Error('bootstrap: the enrolment token has an unexpected shape');
    if (!RUNTIME_SPEC_PATTERN.test(input.runtimeSpec)) throw new Error('bootstrap: the runtime spec is not allowed');
    if (input.publicKey && !PUBLIC_KEY_PATTERN.test(input.publicKey)) {
        throw new Error('bootstrap: the public key is not an ed25519 OpenSSH key');
    }
    if (input.overlayVpn) {
        if (!INSTALL_URL_PATTERN.test(input.overlayVpn.installScriptUrl)) {
            throw new Error('bootstrap: the overlay-VPN install URL is not a plain https URL');
        }
        if (input.overlayVpn.authKey !== null && !VPN_KEY_PATTERN.test(input.overlayVpn.authKey)) {
            throw new Error('bootstrap: the overlay-VPN auth key has an unexpected shape');
        }
        const join = input.overlayVpn.joinCommand;
        if (join !== null && (!join.includes('{keyFile}') || !JOIN_COMMAND_PATTERN.test(join.replace('{keyFile}', 'KEYFILE')))) {
            throw new Error('bootstrap: the overlay-VPN join command must be an absolute path with a {keyFile} placeholder');
        }
    }
}

/** The systemd template unit the bootstrap installs (the shipped one, `start --work --manage`). */
export function cloudSystemdUnit(): string {
    return [
        '[Unit]',
        'Description=Ever Works execution node (running as %i)',
        'Documentation=https://docs.ever.works',
        'After=network-online.target',
        'Wants=network-online.target',
        '',
        '[Service]',
        'Type=simple',
        'User=%i',
        'Group=%i',
        // Cloud computers run with --manage (owner sessions, services) but not
        // --attend (spec FR-8).
        'ExecStart=/usr/bin/env ever-works-node start --work --manage',
        'ExecReload=/usr/bin/env ever-works-node pause',
        'KillSignal=SIGTERM',
        'TimeoutStopSec=900',
        'Restart=on-failure',
        'RestartSec=10s',
        'StartLimitIntervalSec=300',
        'StartLimitBurst=5',
        'NoNewPrivileges=true',
        'PrivateTmp=true',
        'ProtectSystem=full',
        'ProtectKernelTunables=true',
        'ProtectControlGroups=true',
        'RestrictSUIDSGID=true',
        'StateDirectory=ever-works-node',
        `ReadWritePaths=${FLEET_CLOUD_STATE_DIR}`,
        'Environment=NODE_ENV=production',
        `Environment=EVER_WORKS_NODE_CONFIG=${FLEET_CLOUD_STATE_DIR}/node-config.json`,
        'EnvironmentFile=-/etc/default/ever-works-node',
        'StandardOutput=journal',
        'StandardError=journal',
        'SyslogIdentifier=ever-works-node',
        '',
        '[Install]',
        'WantedBy=multi-user.target',
        '',
    ].join('\n');
}

/** The bootstrap shell script (no secret in it: the token is read from its file by the node). */
export function cloudBootstrapShell(input: CloudBootstrapInput): string {
    assertBootstrapSafe(input);
    const wants = new Set(input.software);
    const npmPackages = [input.runtimeSpec];
    for (const id of ['claude-code', 'codex'] as const) {
        const pkg = AGENT_CLI_PACKAGES[id];
        if (wants.has(id) && pkg) npmPackages.push(pkg);
    }
    const lines: string[] = [
        '#!/bin/bash',
        '# Ever Works cloud computer bootstrap — generated by the platform; no secret in this file.',
        'set -euo pipefail',
        'exec >>/var/log/ever-works-bootstrap.log 2>&1',
        'echo "ever-works bootstrap: start $(date -u +%FT%TZ)"',
        'export DEBIAN_FRONTEND=noninteractive',
        `STATE=${FLEET_CLOUD_STATE_DIR}`,
        `TOKEN_FILE=${FLEET_CLOUD_TOKEN_PATH}`,
        `NODE_USER=${FLEET_CLOUD_NODE_USER}`,
        `cleanup() { rm -f "$TOKEN_FILE" ${FLEET_CLOUD_VPN_KEY_PATH}; }`,
        'trap cleanup EXIT',
        'apt-get update -qq',
        'apt-get install -y -qq --no-install-recommends ca-certificates curl git xz-utils sudo >/dev/null',
    ];
    if (wants.has('docker')) {
        lines.push(
            '# Docker from the vendor repository.',
            'install -m 0755 -d /etc/apt/keyrings',
            'curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc',
            'chmod a+r /etc/apt/keyrings/docker.asc',
            'CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")',
            'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${CODENAME} stable" >/etc/apt/sources.list.d/docker.list',
            'apt-get update -qq',
            'apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null',
            'usermod -aG docker "$NODE_USER"',
            'systemctl enable --now docker',
        );
    }
    lines.push(
        '# Node.js (the runtime needs it, so it is always installed), checked against SHASUMS256.txt.',
        'case "$(uname -m)" in x86_64) NARCH=x64 ;; aarch64) NARCH=arm64 ;; *) echo "unsupported processor $(uname -m)"; exit 1 ;; esac',
        `BASE=https://nodejs.org/dist/latest-v${FLEET_CLOUD_NODE_MAJOR}.x`,
        'curl -fsSL "$BASE/SHASUMS256.txt" -o /tmp/node-shasums.txt',
        'NODE_TAR=$(awk \'{print $2}\' /tmp/node-shasums.txt | grep -E "^node-v[0-9.]+-linux-${NARCH}\\.tar\\.xz$" | head -n1)',
        'curl -fsSL "$BASE/$NODE_TAR" -o "/tmp/$NODE_TAR"',
        '(cd /tmp && grep " $NODE_TAR\\$" node-shasums.txt | sha256sum -c -)',
        'tar -xJf "/tmp/$NODE_TAR" -C /usr/local --strip-components=1',
        'rm -f "/tmp/$NODE_TAR" /tmp/node-shasums.txt',
        `npm install -g --no-fund --no-audit ${npmPackages.join(' ')}`,
    );
    if (input.overlayVpn) {
        lines.push(
            '# Overlay-VPN client (operator-configured install script).',
            `curl -fsSL ${input.overlayVpn.installScriptUrl} -o /tmp/overlay-vpn-install.sh`,
            'sh /tmp/overlay-vpn-install.sh',
            'rm -f /tmp/overlay-vpn-install.sh',
        );
        if (input.overlayVpn.authKey && input.overlayVpn.joinCommand) {
            // The key goes through a 0600 file that is removed at once, never argv.
            lines.push(
                `${input.overlayVpn.joinCommand.replace('{keyFile}', FLEET_CLOUD_VPN_KEY_PATH)} || echo "overlay-VPN join failed"`,
            );
        }
        lines.push(`rm -f ${FLEET_CLOUD_VPN_KEY_PATH}`);
    }
    lines.push(
        '# Enrol by file (the node reads and deletes it), then run as a service.',
        'install -d -m 0700 -o "$NODE_USER" -g "$NODE_USER" "$STATE"',
        'chown "$NODE_USER:$NODE_USER" "$TOKEN_FILE"',
        'chmod 0600 "$TOKEN_FILE"',
        `sudo -u "$NODE_USER" -H env EVER_WORKS_NODE_CONFIG="$STATE/node-config.json" ever-works-node enroll --api-url ${input.apiUrl} --token-file "$TOKEN_FILE" --name ${input.name}`,
        'rm -f "$TOKEN_FILE"',
        'systemctl daemon-reload',
        'systemctl enable --now "ever-works-node@${NODE_USER}"',
        `date -u +%FT%TZ >${FLEET_CLOUD_BOOTSTRAP_DONE}`,
        'echo "ever-works bootstrap: done $(date -u +%FT%TZ)"',
        '',
    );
    return lines.join('\n');
}

/** Indent a multi-line block for a YAML literal (`|`) scalar. */
function literal(block: string, indent: string): string {
    return block
        .split('\n')
        .map((line) => (line.length ? `${indent}${line}` : ''))
        .join('\n');
}

/**
 * The `#cloud-config` user data (spec FR-8). The token appears exactly once,
 * as the content of the 0600 `write_files` entry at {@link FLEET_CLOUD_TOKEN_PATH};
 * nowhere else — not in `runcmd`, not on any command line.
 */
export function buildCloudBootstrap(input: CloudBootstrapInput): string {
    assertBootstrapSafe(input);
    const shell = cloudBootstrapShell(input);
    const out: string[] = [
        '#cloud-config',
        '# Ever Works cloud computer — generated by the platform.',
        'users:',
        '  - default',
        `  - name: ${FLEET_CLOUD_NODE_USER}`,
        '    gecos: Ever Works node',
        '    shell: /bin/bash',
        '    lock_passwd: true',
    ];
    if (input.publicKey) {
        out.push('    ssh_authorized_keys:', `      - '${input.publicKey}'`);
    }
    out.push(
        'ssh_pwauth: false',
        'write_files:',
        // root-owned at write time (cloud-init writes files before it creates
        // users); the script hands it to the node user right before enrolling.
        `  - path: ${FLEET_CLOUD_TOKEN_PATH}`,
        "    permissions: '0600'",
        '    owner: root:root',
        `    content: '${input.token}'`,
    );
    if (input.overlayVpn?.authKey && input.overlayVpn.joinCommand) {
        out.push(
            `  - path: ${FLEET_CLOUD_VPN_KEY_PATH}`,
            "    permissions: '0600'",
            '    owner: root:root',
            `    content: '${input.overlayVpn.authKey}'`,
        );
    }
    out.push(
        '  - path: /etc/systemd/system/ever-works-node@.service',
        "    permissions: '0644'",
        '    owner: root:root',
        '    content: |',
        literal(cloudSystemdUnit(), '      '),
        '  - path: /usr/local/sbin/ever-works-bootstrap.sh',
        "    permissions: '0700'",
        '    owner: root:root',
        '    content: |',
        literal(shell, '      '),
        'runcmd:',
        '  - [ bash, /usr/local/sbin/ever-works-bootstrap.sh ]',
        '',
    );
    return out.join('\n');
}

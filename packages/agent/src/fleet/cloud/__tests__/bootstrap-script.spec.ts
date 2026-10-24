import {
    assertBootstrapSafe,
    buildCloudBootstrap,
    cloudBootstrapShell,
    FLEET_CLOUD_TOKEN_PATH,
    type CloudBootstrapInput,
} from '../bootstrap-script';
import { generateThrowawayPublicKey } from '../throwaway-key';

/**
 * Cloud computers (FL-17, T-11, spec FR-8, FR-9) — the first-boot document:
 * the token lives only in the 0600 file, never on a command line; the runtime
 * is pinned and started `--work --manage`; software is installed only when
 * chosen; nothing a caller supplies can escape its scalar.
 */

const TOKEN = 'tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_xyz';

function input(overrides: Partial<CloudBootstrapInput> = {}): CloudBootstrapInput {
    return {
        nodeId: '0f8fad5b-d9cb-469f-a165-70867728950e',
        name: 'nyc-ops',
        apiUrl: 'https://api.ever.works',
        token: TOKEN,
        runtimeSpec: 'ever-works-node@0.2.7',
        software: ['docker', 'node', 'claude-code', 'codex'],
        publicKey: generateThrowawayPublicKey(),
        ...overrides,
    };
}

describe('cloud bootstrap (FL-17)', () => {
    it('writes the token exactly once, into the 0600 tmpfs file', () => {
        const doc = buildCloudBootstrap(input());
        expect(doc.startsWith('#cloud-config\n')).toBe(true);
        expect(doc.split(TOKEN)).toHaveLength(2);
        const at = doc.indexOf(TOKEN);
        const entry = doc.slice(doc.lastIndexOf('- path:', at), at);
        expect(entry).toContain(FLEET_CLOUD_TOKEN_PATH);
        expect(entry).toContain("permissions: '0600'");
    });

    it('enrols by file, never with --token on a command line', () => {
        const shell = cloudBootstrapShell(input());
        expect(shell).toContain('--token-file "$TOKEN_FILE"');
        expect(shell).not.toMatch(/--token(?!-file)/);
        expect(shell).not.toContain(TOKEN);
        // The file is removed after enrolment and on any exit.
        expect(shell).toContain('rm -f "$TOKEN_FILE"');
        expect(shell).toContain('trap cleanup EXIT');
    });

    it('pins the runtime and starts the node --work --manage, without --attend', () => {
        const doc = buildCloudBootstrap(input());
        expect(doc).toContain('npm install -g --no-fund --no-audit ever-works-node@0.2.7');
        expect(doc).toContain('ExecStart=/usr/bin/env ever-works-node start --work --manage');
        expect(doc).not.toContain('--attend');
        expect(doc).toContain('systemctl enable --now "ever-works-node@${NODE_USER}"');
    });

    it('installs only what was chosen (Node.js always: the runtime needs it)', () => {
        const bare = cloudBootstrapShell(input({ software: [] }));
        expect(bare).not.toContain('download.docker.com');
        expect(bare).not.toContain('@anthropic-ai/claude-code');
        expect(bare).not.toContain('@openai/codex');
        expect(bare).toContain('nodejs.org/dist/latest-v26.x');
        expect(bare).toContain('sha256sum -c -');
        const full = cloudBootstrapShell(input());
        expect(full).toContain('download.docker.com');
        expect(full).toContain('@anthropic-ai/claude-code');
        expect(full).toContain('@openai/codex');
    });

    it('authorises only the throwaway public key and no password', () => {
        const doc = buildCloudBootstrap(input());
        expect(doc).toMatch(/ssh_authorized_keys:\n {6}- 'ssh-ed25519 [A-Za-z0-9+/=]+ ever-works-throwaway'/);
        expect(doc).toContain('lock_passwd: true');
        expect(doc).toContain('ssh_pwauth: false');
        expect(doc).not.toContain('BEGIN OPENSSH PRIVATE KEY');
    });

    it('carries the overlay-VPN key only when given, through a file', () => {
        const without = buildCloudBootstrap(input());
        expect(without).not.toContain('overlay-vpn-key\n    permissions');
        const withKey = buildCloudBootstrap(
            input({
                overlayVpn: {
                    installScriptUrl: 'https://vpn.example.com/install.sh',
                    joinCommand: '/usr/bin/vpn up --auth-key-file={keyFile}',
                    authKey: 'vpnkey-1234567890',
                },
            }),
        );
        expect(withKey.split('vpnkey-1234567890')).toHaveLength(2);
        expect(withKey).toContain('/usr/bin/vpn up --auth-key-file=/run/ever-works/overlay-vpn-key');
    });

    it('refuses anything that could escape a scalar or a shell word', () => {
        expect(() => assertBootstrapSafe(input({ name: "x'; rm -rf /" }))).toThrow();
        expect(() => assertBootstrapSafe(input({ apiUrl: 'https://api.ever.works/$(id)' }))).toThrow();
        expect(() => assertBootstrapSafe(input({ token: "abc'def" }))).toThrow();
        expect(() => assertBootstrapSafe(input({ runtimeSpec: 'left-pad' }))).toThrow();
        expect(() => assertBootstrapSafe(input({ publicKey: 'ssh-rsa AAAA' }))).toThrow();
        expect(() =>
            assertBootstrapSafe(
                input({ overlayVpn: { installScriptUrl: 'http://x', joinCommand: null, authKey: null } }),
            ),
        ).toThrow();
        expect(() => assertBootstrapSafe(input())).not.toThrow();
    });
});

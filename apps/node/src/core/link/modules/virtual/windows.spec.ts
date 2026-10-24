import { describe, expect, it } from 'vitest';
import {
	generateWindowsPassword,
	kvmUsable,
	parseViewerPort,
	resolveWindowsImage,
	windowsFirstBootScript,
	windowsInstallBat,
	windowsRunArgs,
	windowsShare,
	WindowsPasswordStore
} from './windows';

/** Virtual computers, phase 2 (FL-16, T-27 – T-30) — KVM, the installer argv, the password, the first boot. */

const CHILD = '0b9c5f3e-6f0a-4a43-9a51-1f2d3c4b5a69';

describe('kvmUsable (T-27)', () => {
	const ok = () => undefined;
	const denied = () => {
		throw new Error('EACCES');
	};
	it('is true only on Linux x86-64 with read-write /dev/kvm', () => {
		expect(kvmUsable({ platform: 'linux', arch: 'x64', access: ok })).toBe(true);
		expect(kvmUsable({ platform: 'linux', arch: 'x64', access: denied })).toBe(false);
		expect(kvmUsable({ platform: 'linux', arch: 'arm64', access: ok })).toBe(false);
		expect(kvmUsable({ platform: 'darwin', arch: 'x64', access: ok })).toBe(false);
		expect(kvmUsable({ platform: 'win32', arch: 'x64', access: ok })).toBe(false);
	});
});

describe('windowsRunArgs (plan §6.6)', () => {
	const args = windowsRunArgs({
		childNodeId: CHILD,
		name: 'win-11-vm',
		image: `registry.example.com/windows@sha256:${'b'.repeat(64)}`,
		edition: '11',
		cpus: 4,
		memoryGiB: 8,
		diskGiB: 64,
		envFile: `/srv/node/virtual/${CHILD}/run/vm.env`,
		oemDir: `/srv/node/virtual/${CHILD}/oem`,
		sharedDir: `/srv/node/virtual/${CHILD}/shared`,
		shareTarget: '/shared'
	});

	it('never puts the password on the command line — only the env file', () => {
		expect(args.join(' ')).not.toMatch(/PASSWORD=/);
		expect(args).toContain('--env-file');
	});

	it('publishes the viewer on the host loopback only (FR-23)', () => {
		const index = args.indexOf('-p');
		expect(args[index + 1]).toBe('127.0.0.1::8006');
		expect(args.filter((arg) => arg === '-p')).toHaveLength(1);
	});

	it('asks the installer for the size and the account, with a 120 s stop timeout', () => {
		expect(args).toEqual(
			expect.arrayContaining(['VERSION=11', 'RAM_SIZE=8G', 'CPU_CORES=4', 'DISK_SIZE=64G', 'USERNAME=ever'])
		);
		expect(args[args.indexOf('--stop-timeout') + 1]).toBe('120');
		expect(args).toContain('/dev/kvm');
		expect(args.join(' ')).not.toContain('docker.sock');
	});

	it('refuses an edition the catalogue does not name', () => {
		expect(() =>
			windowsRunArgs({
				childNodeId: CHILD,
				name: 'win',
				image: 'x',
				edition: '11; rm',
				cpus: 4,
				memoryGiB: 8,
				diskGiB: 64,
				envFile: '/e',
				oemDir: '/o',
				sharedDir: '/s',
				shareTarget: '/shared'
			})
		).toThrow();
	});

	it('reads the viewer port only when bound to loopback', () => {
		expect(parseViewerPort('127.0.0.1:49153\n')).toBe(49153);
		expect(parseViewerPort('0.0.0.0:49153\n')).toBeNull();
	});
});

describe('the installer image and the share', () => {
	it('has no default image: the operator configures one', () => {
		expect(resolveWindowsImage({})).toBeNull();
		expect(resolveWindowsImage({ EVER_WORKS_NODE_VIRTUAL_WINDOWS_IMAGE: 'registry.example.com/windows:5' })?.ref).toBe(
			'registry.example.com/windows:5'
		);
		expect(resolveWindowsImage({ EVER_WORKS_NODE_VIRTUAL_WINDOWS_IMAGE: 'bad image; rm' })).toBeNull();
	});

	it('falls back to the default share for anything unsafe', () => {
		expect(windowsShare({ EVER_WORKS_NODE_VIRTUAL_WINDOWS_SHARE_DIR: '/../x;y' }).dir).toBe('/shared');
	});
});

describe('the generated password (FR-20)', () => {
	it('is 24 characters with every class', () => {
		const password = generateWindowsPassword();
		expect(password).toHaveLength(24);
		expect(password).toMatch(/[A-Z]/);
		expect(password).toMatch(/[a-z]/);
		expect(password).toMatch(/[0-9]/);
	});

	it('round-trips through the keychain and is deleted with the VM', async () => {
		const kept = new Map<string, string>();
		const store = new WindowsPasswordStore(
			'/srv/node/virtual',
			{
				readFile: async () => null,
				writeFile: async () => undefined,
				mkdir: async () => undefined,
				removeFile: async () => undefined
			},
			{
				label: 'test keychain',
				get: async (account) => kept.get(account) ?? null,
				set: async (account, secret) => {
					kept.set(account, secret);
				},
				delete: async (account) => {
					kept.delete(account);
				}
			}
		);
		await store.set(CHILD, 'Abcdefgh-12345678-Zyxwvu');
		expect(kept.get(`virtual:${CHILD}`)).toBe('Abcdefgh-12345678-Zyxwvu');
		expect(await store.get(CHILD)).toBe('Abcdefgh-12345678-Zyxwvu');
		await store.delete(CHILD);
		expect(await store.get(CHILD)).toBeNull();
	});
});

describe('the first-boot step (T-28)', () => {
	const script = windowsFirstBootScript({
		runtimeSpec: 'ever-works-node@0.2.7',
		nodeMajor: 26,
		apiUrl: 'https://api.ever.works',
		shareUnc: '\\\\host.lan\\Data'
	});

	it('holds no token and no password', () => {
		expect(script).not.toMatch(/PASSWORD|--token(?!-file)/);
		expect(windowsInstallBat()).not.toMatch(/PASSWORD|token/i);
	});

	it('enrols with --token-file and starts at boot as the generated account, never a built-in one (FR-25)', () => {
		expect(script).toContain('enroll --api-url https://api.ever.works --token-file $private');
		expect(script).toContain('-LogonType S4U');
		expect(script).not.toMatch(/SYSTEM|LocalService|NetworkService/);
		expect(script).toContain("-Argument 'start --work --manage'");
	});

	it('says ready only after the runtime installed, and checks the Node.js download', () => {
		expect(script.indexOf('ready.txt')).toBeGreaterThan(script.indexOf('npm.cmd install'));
		expect(script).toContain('Get-FileHash -Algorithm SHA256');
	});
});

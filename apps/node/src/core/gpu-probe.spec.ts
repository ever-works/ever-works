import { describe, expect, it } from 'vitest';
import type { CommandRunner } from './capabilities';
import { classifyGpuVendor, detectGpu, firstAdapterLine, gpuProbesFor } from './gpu-probe';

/** Runner that answers exactly one command and 127s the rest. */
function answering(command: string, stdout: string, code = 0): CommandRunner {
	return {
		run: async (invoked) =>
			invoked === command ? { code, stdout, stderr: '' } : { code: 127, stdout: '', stderr: 'not found' }
	};
}

const silent: CommandRunner = {
	run: async () => ({ code: 127, stdout: '', stderr: 'not found' })
};

describe('classifyGpuVendor', () => {
	it('attributes the common adapter names', () => {
		expect(classifyGpuVendor('NVIDIA GeForce RTX 4090')).toBe('nvidia');
		expect(classifyGpuVendor('AMD Radeon RX 6800')).toBe('amd');
		expect(classifyGpuVendor('Apple M3 Max')).toBe('apple');
		expect(classifyGpuVendor('Intel Iris Xe Graphics')).toBe('intel');
	});

	it('prefers a discrete card over an integrated one listed alongside it', () => {
		// A laptop reports both; scheduling should see the card that matters.
		expect(classifyGpuVendor('Intel UHD Graphics 630\nNVIDIA GeForce GTX 1650')).toBe('nvidia');
	});

	it('falls back to `other` for something it saw but cannot attribute', () => {
		expect(classifyGpuVendor('Matrox G200eW3')).toBe('other');
	});
});

describe('firstAdapterLine', () => {
	it('takes the first non-empty line and caps its length', () => {
		expect(firstAdapterLine('\n\n  NVIDIA A100  \nNVIDIA A100\n')).toBe('NVIDIA A100');
		expect(firstAdapterLine('')).toBeNull();
		expect(firstAdapterLine('   \n  ')).toBeNull();
		expect(firstAdapterLine('x'.repeat(500))?.length).toBe(120);
	});
});

describe('gpuProbesFor', () => {
	it('always tries nvidia-smi first — it is the fastest and most specific', () => {
		for (const platform of ['linux', 'darwin', 'win32']) {
			expect(gpuProbesFor(platform)[0].command).toBe('nvidia-smi');
		}
	});

	it('uses the platform-native enumerator as the second probe', () => {
		expect(gpuProbesFor('win32')[1].command).toBe('powershell');
		expect(gpuProbesFor('darwin')[1].command).toBe('system_profiler');
		expect(gpuProbesFor('linux')[1].command).toBe('lspci');
	});
});

describe('detectGpu', () => {
	it('reports the adapter nvidia-smi names', async () => {
		const gpu = await detectGpu(answering('nvidia-smi', 'NVIDIA RTX A6000\n'), 'linux');
		expect(gpu).toEqual({ vendor: 'nvidia', model: 'NVIDIA RTX A6000' });
	});

	it('parses macOS system_profiler chipset lines', async () => {
		const output = ['Graphics/Displays:', '', '    Apple M3 Max:', '', '      Chipset Model: Apple M3 Max'].join(
			'\n'
		);
		const gpu = await detectGpu(answering('system_profiler', output), 'darwin');
		expect(gpu).toEqual({ vendor: 'apple', model: 'Apple M3 Max' });
	});

	it('parses Windows video controller names', async () => {
		const gpu = await detectGpu(answering('powershell', 'Intel(R) UHD Graphics 770\r\n'), 'win32');
		expect(gpu?.vendor).toBe('intel');
	});

	it('keeps only display controllers out of lspci', async () => {
		const lspci = [
			'00:00.0 Host bridge: Intel Corporation Device 9b53',
			'01:00.0 VGA compatible controller: NVIDIA Corporation GA104 [GeForce RTX 3070]'
		].join('\n');
		const gpu = await detectGpu(answering('lspci', lspci), 'linux');
		expect(gpu?.vendor).toBe('nvidia');
	});

	it('returns null when lspci lists no display controller', async () => {
		const gpu = await detectGpu(answering('lspci', '00:00.0 Host bridge: Intel Corporation Device 9b53'), 'linux');
		expect(gpu).toBeNull();
	});

	it('returns null when nothing answers', async () => {
		expect(await detectGpu(silent, 'linux')).toBeNull();
	});

	it('ignores a probe that exits nonzero', async () => {
		expect(await detectGpu(answering('nvidia-smi', 'garbage', 9), 'linux')).toBeNull();
	});

	it('falls through to the next probe when the first one is absent', async () => {
		const gpu = await detectGpu(answering('lspci', '01:00.0 VGA compatible controller: AMD Radeon'), 'linux');
		expect(gpu?.vendor).toBe('amd');
	});

	it('never throws — a probe that blows up is simply no GPU', async () => {
		const runner: CommandRunner = {
			run: async () => {
				throw new Error('spawn ENOENT');
			}
		};
		await expect(detectGpu(runner, 'linux')).resolves.toBeNull();
	});
});

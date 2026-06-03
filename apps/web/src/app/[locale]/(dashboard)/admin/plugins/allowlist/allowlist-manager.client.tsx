'use client';

/**
 * EW-693 / T35 — Client-side allowlist editor.
 *
 * Separated from `page.tsx` (server component) so the table can use
 * client hooks for optimistic updates without forcing the parent to
 * `'use client'`. The server component fetches the initial list and
 * passes it in as `initial`; subsequent mutations call back through
 * the same `pluginAllowlistAPI` helpers via Next.js server actions
 * (here we use straightforward fetch calls — apps/web's existing
 * pattern is to invoke `pluginAllowlistAPI.*` from server actions
 * but the v1 page goes through a thin client-side fetch wrapper to
 * keep the surface contained).
 *
 * Behaviours pinned:
 * - "Add" form requires `packageName` + `versionRange` (matches the
 *   class-validator DTO server-side).
 * - "Enabled" toggle is one click — PATCH with `{ enabled }` only.
 * - "Remove" prompts for confirmation before DELETE.
 * - Errors from the server (the controller returns 401 / 404 / 409)
 *   surface inline below the row that triggered them.
 */

import { useState, useTransition } from 'react';

interface AllowlistEntry {
	id: string;
	packageName: string;
	versionRange: string;
	integrity?: string;
	source: 'npm' | 'github-packages';
	enabled: boolean;
	createdAt: string;
}

interface Props {
	readonly initial: ReadonlyArray<AllowlistEntry>;
}

async function postJson<T>(method: 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<T> {
	const res = await fetch(url, {
		method,
		headers: body ? { 'content-type': 'application/json' } : undefined,
		body: body ? JSON.stringify(body) : undefined,
		credentials: 'include'
	});
	if (!res.ok) {
		let message = `${method} ${url} failed with ${res.status}`;
		try {
			const j = (await res.json()) as { message?: string };
			if (j?.message) message = j.message;
		} catch {
			/* body not JSON */
		}
		throw new Error(message);
	}
	if (res.status === 204) return undefined as never;
	return (await res.json()) as T;
}

export function AllowlistManager({ initial }: Props) {
	const [entries, setEntries] = useState<AllowlistEntry[]>([...initial]);
	const [packageName, setPackageName] = useState('');
	const [versionRange, setVersionRange] = useState('');
	const [source, setSource] = useState<'npm' | 'github-packages'>('npm');
	const [error, setError] = useState<string | null>(null);
	const [pending, startTransition] = useTransition();

	function addEntry(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		if (!packageName || !versionRange) {
			setError('packageName and versionRange are required.');
			return;
		}
		startTransition(() => {
			void (async () => {
				try {
					const created = await postJson<AllowlistEntry>('POST', '/api/admin/plugins/allowlist', {
						packageName,
						versionRange,
						source,
						enabled: true
					});
					setEntries((rows) => [created, ...rows]);
					setPackageName('');
					setVersionRange('');
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				}
			})();
		});
	}

	function toggleEnabled(row: AllowlistEntry) {
		setError(null);
		startTransition(() => {
			void (async () => {
				try {
					const next = await postJson<AllowlistEntry>(
						'PATCH',
						`/api/admin/plugins/allowlist/${row.id}`,
						{ enabled: !row.enabled }
					);
					setEntries((rows) => rows.map((r) => (r.id === row.id ? next : r)));
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				}
			})();
		});
	}

	function remove(row: AllowlistEntry) {
		if (!confirm(`Remove "${row.packageName}" from the allowlist?`)) return;
		setError(null);
		startTransition(() => {
			void (async () => {
				try {
					await postJson<void>('DELETE', `/api/admin/plugins/allowlist/${row.id}`);
					setEntries((rows) => rows.filter((r) => r.id !== row.id));
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				}
			})();
		});
	}

	return (
		<div className="space-y-6">
			<form
				onSubmit={addEntry}
				className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900"
			>
				<h2 className="mb-3 text-base font-medium">Add package</h2>
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
					<label className="text-sm">
						Package name
						<input
							value={packageName}
							onChange={(e) => setPackageName(e.target.value)}
							placeholder="@some-vendor/cool-plugin"
							className="mt-1 w-full rounded border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-800"
						/>
					</label>
					<label className="text-sm">
						Version range
						<input
							value={versionRange}
							onChange={(e) => setVersionRange(e.target.value)}
							placeholder="^2.0.0"
							className="mt-1 w-full rounded border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-800"
						/>
					</label>
					<label className="text-sm">
						Source
						<select
							value={source}
							onChange={(e) => setSource(e.target.value as 'npm' | 'github-packages')}
							className="mt-1 w-full rounded border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-800"
						>
							<option value="npm">npm</option>
							<option value="github-packages">GitHub Packages</option>
						</select>
					</label>
				</div>
				<div className="mt-3 flex items-center justify-between">
					<button
						type="submit"
						disabled={pending}
						className="rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-black disabled:opacity-50 dark:bg-white dark:text-gray-900"
					>
						{pending ? 'Saving…' : 'Add to allowlist'}
					</button>
				</div>
			</form>

			{error ? (
				<div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-700 dark:bg-red-900/30 dark:text-red-200">
					{error}
				</div>
			) : null}

			<table className="w-full divide-y divide-gray-200 text-left text-sm dark:divide-gray-700">
				<thead className="text-xs uppercase text-gray-500 dark:text-gray-400">
					<tr>
						<th className="py-2">Package</th>
						<th className="py-2">Version range</th>
						<th className="py-2">Source</th>
						<th className="py-2">Enabled</th>
						<th className="py-2 text-right">Actions</th>
					</tr>
				</thead>
				<tbody className="divide-y divide-gray-100 dark:divide-gray-800">
					{entries.length === 0 ? (
						<tr>
							<td colSpan={5} className="py-8 text-center text-gray-500">
								No allowlist entries yet. Add a package above.
							</td>
						</tr>
					) : (
						entries.map((row) => (
							<tr key={row.id}>
								<td className="py-2 font-mono text-xs">{row.packageName}</td>
								<td className="py-2 font-mono text-xs">{row.versionRange}</td>
								<td className="py-2">{row.source}</td>
								<td className="py-2">
									<button
										type="button"
										onClick={() => toggleEnabled(row)}
										disabled={pending}
										className={`rounded px-2 py-0.5 text-xs ${
											row.enabled
												? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200'
												: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
										}`}
									>
										{row.enabled ? 'Enabled' : 'Disabled'}
									</button>
								</td>
								<td className="py-2 text-right">
									<button
										type="button"
										onClick={() => remove(row)}
										disabled={pending}
										className="text-xs text-red-700 hover:underline dark:text-red-300"
									>
										Remove
									</button>
								</td>
							</tr>
						))
					)}
				</tbody>
			</table>
		</div>
	);
}

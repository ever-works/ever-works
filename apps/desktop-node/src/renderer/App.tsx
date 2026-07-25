import { useCallback, useEffect, useState } from 'react';
import type { NodeIdentityView } from '../shared/ipc-contract';
import { StatusScreen } from './StatusScreen';
import { WizardView } from './wizard/WizardView';

export function App() {
	const bridge = window.everworksNode;
	const [identity, setIdentity] = useState<NodeIdentityView | undefined>();

	const refresh = useCallback(() => {
		void bridge?.getConfig().then(setIdentity);
	}, [bridge]);

	useEffect(refresh, [refresh]);

	if (!bridge) {
		return (
			<div className="shell">
				<h1>Ever Works Desktop Node</h1>
				<p className="muted">
					The desktop bridge is unavailable — this UI must run inside the Electron shell (pnpm start). The
					vite dev server alone renders the wizard without live enrollment.
				</p>
			</div>
		);
	}

	if (!identity) {
		return (
			<div className="shell">
				<p className="muted">Loading…</p>
			</div>
		);
	}

	if (!identity.enrolled) {
		return <WizardView bridge={bridge} onEnrolled={setIdentity} />;
	}

	return <StatusScreen bridge={bridge} identity={identity} onUnenrolled={refresh} />;
}

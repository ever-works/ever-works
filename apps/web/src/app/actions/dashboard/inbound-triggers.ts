'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
	inboundTriggersAPI,
	type CreateInboundTriggerInput,
	type InboundTriggerView,
	type InboundTriggerWithSecret
} from '@/lib/api/inbound-triggers';
// Security: defense-in-depth authn guard, mirroring actions/dashboard/schedules.ts.
// serverFetch only attaches the bearer token when an auth cookie is present, so
// without this an unauthenticated invocation would reach the API with no
// Authorization header. The API remains the real authz boundary.
import { getAuthFromCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';

async function requireAuth() {
	const user = await getAuthFromCookie();
	if (!user) {
		redirect(ROUTES.AUTH_LOGIN);
	}
}

/** The Schedules view lives on the Activity page — bust its cache after a mutation. */
function revalidateTriggerSurfaces() {
	revalidatePath('/[locale]/(dashboard)/activity', 'page');
}

type ActionResult<T> = { success: true; data: T } | { success: false; error: string };

function toError(error: unknown, fallback: string): { success: false; error: string } {
	console.error(fallback, error);
	return { success: false, error: error instanceof Error ? error.message : fallback };
}

export async function listInboundTriggersAction(): Promise<ActionResult<InboundTriggerView[]>> {
	await requireAuth();
	try {
		return { success: true, data: await inboundTriggersAPI.list() };
	} catch (error) {
		return toError(error, 'Failed to list triggers');
	}
}

export async function createInboundTriggerAction(
	input: CreateInboundTriggerInput
): Promise<ActionResult<InboundTriggerWithSecret>> {
	await requireAuth();
	try {
		const data = await inboundTriggersAPI.create(input);
		revalidateTriggerSurfaces();
		return { success: true, data };
	} catch (error) {
		return toError(error, 'Failed to create trigger');
	}
}

export async function rotateInboundTriggerSecretAction(
	id: string
): Promise<ActionResult<InboundTriggerWithSecret>> {
	await requireAuth();
	try {
		const data = await inboundTriggersAPI.rotateSecret(id);
		revalidateTriggerSurfaces();
		return { success: true, data };
	} catch (error) {
		return toError(error, 'Failed to rotate secret');
	}
}

export async function pauseInboundTriggerAction(id: string): Promise<ActionResult<InboundTriggerView>> {
	await requireAuth();
	try {
		const data = await inboundTriggersAPI.pause(id);
		revalidateTriggerSurfaces();
		return { success: true, data };
	} catch (error) {
		return toError(error, 'Failed to pause trigger');
	}
}

export async function resumeInboundTriggerAction(id: string): Promise<ActionResult<InboundTriggerView>> {
	await requireAuth();
	try {
		const data = await inboundTriggersAPI.resume(id);
		revalidateTriggerSurfaces();
		return { success: true, data };
	} catch (error) {
		return toError(error, 'Failed to resume trigger');
	}
}

export async function deleteInboundTriggerAction(id: string): Promise<ActionResult<null>> {
	await requireAuth();
	try {
		await inboundTriggersAPI.remove(id);
		revalidateTriggerSurfaces();
		return { success: true, data: null };
	} catch (error) {
		return toError(error, 'Failed to delete trigger');
	}
}

'use server';

import { revalidatePath } from 'next/cache';
import { workProposalsAPI } from '@/lib/api/work-proposals';

export async function refreshProposalsAction() {
	const result = await workProposalsAPI.refresh();
	revalidatePath('/[locale]/(dashboard)/(home)', 'page');
	return result;
}

export async function dismissProposalAction(proposalId: string) {
	await workProposalsAPI.dismiss(proposalId);
	revalidatePath('/[locale]/(dashboard)/(home)', 'page');
	return { ok: true };
}

export async function acceptProposalAction(proposalId: string, workId: string) {
	const result = await workProposalsAPI.accept(proposalId, workId);
	revalidatePath('/[locale]/(dashboard)/(home)', 'page');
	return result;
}

export async function getProposalsStatusAction() {
	return workProposalsAPI.status();
}

export async function listProposalsAction() {
	return workProposalsAPI.list(['pending']);
}

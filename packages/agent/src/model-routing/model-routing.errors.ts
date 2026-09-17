import {
    BadRequestException,
    ConflictException,
    NotFoundException,
    UnprocessableEntityException,
} from '@nestjs/common';

/**
 * Model accounts (AW-16) — the refusals the account and policy services
 * raise. Each carries a stable `code` a client can branch on; the message is
 * the owner-facing sentence. None ever includes a credential value.
 */

export function modelAccountNotFound(): NotFoundException {
    return new NotFoundException({ code: 'not_found', message: 'Model account not found' });
}

export function modelAccountLimitReached(
    scope: 'provider' | 'workspace',
    limit: number,
): ConflictException {
    return new ConflictException({
        code: 'limit_reached',
        scope,
        limit,
        message:
            scope === 'provider'
                ? `You've reached ${limit} accounts for this provider. Remove one before adding another.`
                : `You've reached ${limit} provider accounts in this workspace.`,
    });
}

export function modelAccountDuplicateLabel(label: string): ConflictException {
    return new ConflictException({
        code: 'duplicate_label',
        message: `You already have an account called '${label}'.`,
    });
}

export function modelAccountStaleOrder(): ConflictException {
    return new ConflictException({
        code: 'stale_order',
        message:
            'Someone changed this while you were editing. We reloaded the order — check it and save again.',
    });
}

export function modelAccountCredentialRejected(providerName: string): UnprocessableEntityException {
    return new UnprocessableEntityException({
        code: 'credential_rejected',
        message: `That key didn't work with ${providerName}. Nothing was saved.`,
    });
}

export function modelProviderUnknown(providerPluginId: string): UnprocessableEntityException {
    return new UnprocessableEntityException({
        code: 'unknown_provider',
        message: `No installed AI provider is called '${providerPluginId}'.`,
    });
}

export function modelProviderTakesNoAccounts(providerName: string): UnprocessableEntityException {
    return new UnprocessableEntityException({
        code: 'no_credential_fields',
        message: `${providerName} declares no credential to store, so it has no accounts.`,
    });
}

export function modelAccountInvalidCredentials(message: string): BadRequestException {
    return new BadRequestException({ code: 'invalid_credentials', message });
}

export function modelAccountInvalidLabel(): BadRequestException {
    return new BadRequestException({
        code: 'invalid_label',
        message: 'An account name must be between 1 and 60 characters.',
    });
}

export function modelPolicyInvalid(message: string): BadRequestException {
    return new BadRequestException({ code: 'invalid_policy', message });
}

export function modelPolicyScopeNotFound(): NotFoundException {
    return new NotFoundException({ code: 'not_found', message: 'Not found' });
}

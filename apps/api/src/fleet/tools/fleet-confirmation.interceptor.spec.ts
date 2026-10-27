import { HttpException, HttpStatus } from '@nestjs/common';
import { lastValueFrom, throwError } from 'rxjs';
import {
    FleetConfirmationInterceptor,
    completeFleetConfirmationBody,
    fleetCatalogueEntryForRoute,
    fleetConfirmationHint,
    stripFleetConfirmationTokens,
} from './fleet-confirmation.interceptor';

/** FL-19 T-08 — three classes, the preview shape, token-style fields ignored (spec ACC-FL19-09). */
describe('FleetConfirmationInterceptor', () => {
    it('finds the catalogue row of a Nest route path', () => {
        expect(
            fleetCatalogueEntryForRoute('POST', '/api/fleet/nodes/:id/services/:name/:action')
                ?.name,
        ).toBe('fleet_services_action');
        expect(fleetCatalogueEntryForRoute('GET', '/api/fleet/nodes/:id/services')).toBeUndefined();
    });

    it('words the hint for each class', () => {
        expect(fleetConfirmationHint('confirm')).toBe('call again with confirm: true');
        expect(fleetConfirmationHint('confirm-destructive', 'win-11-vm')).toBe(
            'type the exact name: win-11-vm',
        );
        expect(fleetConfirmationHint('blast-radius')).toContain('acknowledgeBlastRadius: true');
    });

    it('drops token-style fields and nothing else', () => {
        const body: Record<string, unknown> = {
            confirmationToken: 'abc',
            confirm: false,
            name: 'x',
        };
        stripFleetConfirmationTokens(body);
        expect(body).toEqual({ confirm: false, name: 'x' });
    });

    it('fills the class from the route and keeps the summary and sentence', () => {
        const entry = fleetCatalogueEntryForRoute(
            'POST',
            '/api/fleet/nodes/:id/processes/:pid/signal',
        );
        const out = completeFleetConfirmationBody(
            {
                error: {
                    code: 'confirmation_required',
                    hint: '',
                    details: { summary: 'Kill 4242 on build-01?' },
                },
            },
            entry,
        );
        expect(out).toEqual({
            error: {
                code: 'confirmation_required',
                hint: 'call again with confirm: true',
                details: { summary: 'Kill 4242 on build-01?', class: 'confirm' },
            },
        });
    });

    it('keeps a class the service set (blast-radius) and its own hint', () => {
        const out = completeFleetConfirmationBody(
            {
                error: {
                    code: 'confirmation_required',
                    hint: 'acknowledge it',
                    details: { class: 'blast-radius', sentence: 'This stops the network service…' },
                },
            },
            undefined,
        );
        expect(out?.error).toMatchObject({
            hint: 'acknowledge it',
            details: { class: 'blast-radius' },
        });
    });

    it('leaves other 409s alone', () => {
        expect(
            completeFleetConfirmationBody({ error: { code: 'busy', hint: 'Ana' } }, undefined),
        ).toBeNull();
    });

    it('rewrites a 409 confirmation_required thrown by the handler', async () => {
        const interceptor = new FleetConfirmationInterceptor();
        const request = {
            method: 'POST',
            route: { path: '/api/fleet/sessions/:id/end' },
            body: { confirmationToken: 't' },
        };
        const context = { switchToHttp: () => ({ getRequest: () => request }) } as never;
        const handler = {
            handle: () =>
                throwError(
                    () =>
                        new HttpException(
                            {
                                error: {
                                    code: 'confirmation_required',
                                    hint: '',
                                    details: { summary: 'End it?' },
                                },
                            },
                            HttpStatus.CONFLICT,
                        ),
                ),
        };
        await expect(lastValueFrom(interceptor.intercept(context, handler))).rejects.toMatchObject({
            response: {
                error: {
                    code: 'confirmation_required',
                    details: { class: 'confirm', summary: 'End it?' },
                },
            },
        });
        expect(request.body).toEqual({});
    });
});

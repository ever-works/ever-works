import { Controller, Get, Header, Inject, NotFoundException, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';

export const EVER_CONNECT_ADDRESS_CHECK = Symbol('EVER_CONNECT_ADDRESS_CHECK');

/**
 * The statement that proves this installation answers at its published
 * address: a short-lived statement signed with the installation's connect key,
 * which Ever Platform reads while it checks the address. The Ever Connect
 * module, which owns the connect key and the address, provides it.
 */
export interface EverConnectAddressCheck {
    /** The compact signed statement while a check is pending, otherwise `null`. */
    pendingStatement(): Promise<string | null>;
}

/** The default: no address check is ever pending. */
export class NoEverConnectAddressCheck implements EverConnectAddressCheck {
    async pendingStatement(): Promise<null> {
        return null;
    }
}

/**
 * `GET /.well-known/ever-connect` (outside `/api`, like every well-known
 * address): the address statement while Ever Platform checks this
 * installation's published address, `404` at any other time. It exists only
 * when the Ever Connect module is loaded (`EVER_CONNECT_ENABLED=true`).
 */
@ApiExcludeController()
@Controller('.well-known')
export class EverConnectWellKnownController {
    constructor(
        @Inject(EVER_CONNECT_ADDRESS_CHECK) private readonly check: EverConnectAddressCheck,
    ) {}

    @Public()
    @Get('ever-connect')
    @Header('Cache-Control', 'no-store')
    async statement(
        @Res({ passthrough: true }) res: { type?: (value: string) => unknown },
    ): Promise<string> {
        const statement = await this.check.pendingStatement();
        if (!statement) throw new NotFoundException();
        res?.type?.('application/jwt');
        return statement;
    }
}

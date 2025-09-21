import { Controller, Get } from '@nestjs/common';
import { Public } from './auth';

@Controller()
export class APIController {
    @Public()
    @Get()
    home() {
        return { status: 'success', message: 'API is up and running' };
    }
}

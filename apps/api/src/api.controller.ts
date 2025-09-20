import { Controller, Get } from '@nestjs/common';

@Controller()
export class APIController {
    @Get()
    home() {
        return { status: 'success', message: 'API is up and running' };
    }
}

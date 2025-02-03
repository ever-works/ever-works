import { Body, Controller, Param, Post } from '@nestjs/common';
import { VercelService } from './vercel.service';
import { Directory } from '../entities/directory.entity';
import { User } from 'src/entities/user.entity';

@Controller('deploy')
export class DeployController {
    constructor(private readonly vercelService: VercelService) {}
    
    @Post('/:dirname/vercel')
    async toVercel(@Body('token') token: string, @Param('dirname') slug) {
        // some db query result:
        const directory = await Directory.findMock(slug);
        const user = await User.sessionMock();

        await this.vercelService.deploy({
            // TODO: replace with real username from user object:
            owner: directory.owner,
            repo: directory.getWebsiteRepo(),
            provider: 'vercel',
            data: {
                token,
            }
        }, directory, user);
    }
}

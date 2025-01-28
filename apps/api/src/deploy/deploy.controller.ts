import { Body, Controller, Param, Post } from '@nestjs/common';
import { VercelService } from './vercel.service';
import { Directory } from '../data-generator/data-generator.service';

@Controller('deploy')
export class DeployController {
    constructor(private readonly vercelService: VercelService) {}
    
    @Post('/:dirname/vercel')
    async toVercel(@Body('token') token: string, @Param('dirname') slug) {
        // some db query result:
        const directory: Directory = {
            name: '...',
            description: '...',
            slug,
        }

        await this.vercelService.deploy({
            // TODO: replace with real username from user object:
            owner: process.env.GITHUB_USERNAME,
            repo: directory.slug + '-website',
            provider: 'vercel',
            data: {
                token,
            }
        }, directory);
    }
}

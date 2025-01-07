import { Injectable } from '@nestjs/common';

const data = [
    {
        name: 'Ever Clock',
        description: 'Open Time Tracking Platform (WIP)',
        source_url: 'https://github.com/ever-co/ever-cloc',
    },
    {
        name: 'ActivityWatch',
        description: 'Free and open-source automated time tracker. Cross-platform, extensible, privacy-focused.',
        source_url: 'https://activitywatch.net/',
    },
    {
        name: 'Timewrrior',
        desciption: 'Commandline Time Tracking and Reporting.',
        source_url: 'https://github.com/GothenburgBitFactory/timewarrior',

    }
]

@Injectable()
export class AiEngineService {
    getItemsList() {
        return data;
    }
}

import { Injectable } from '@nestjs/common';

export interface Identifable {
    id: string;
    name: string;
}

export interface Category extends Identifable {
    description?: string;
    icon_url?: string;
}

export interface Tag extends Identifable {}

export interface ItemData {
    name: string;
    description: string;
    featured?: boolean;
    source_url: string;
    category: string | string[] | Category | Category[];
    slug?: string;
    tags: string[] | Tag[];
}

export const tags: Tag[] = [
    { id: 'productivity', name: 'Productivity' },
    { id: 'project-management', name: 'Project Management' },
    { id: 'business-management', name: 'Business Management' },
];

const data: Array<ItemData> = [
    {
        name: 'Ever Cloc',
        description: 'Open Time Tracking Platform (WIP)',
        source_url: 'https://github.com/ever-co/ever-cloc',
        category: 'open-source',
        tags: ['productivity'],
    },
    {
        name: 'Ever Team',
        description: 'Open Work and Project Management Platform (including optional screenshots, Desktop & Mobile Apps, etc.)',
        source_url: 'https://ever.team',
        category: 'open-source',
        tags: ['productivity', 'project-management'],
    },
    {
        name: 'Ever Gauzy',
        description: 'Open Business Management Platform (ERP/CRM/HRM) with Time-Tracking functionality (including optional screenshots, Desktop Timer App, etc.)',
        source_url: 'https://gauzy.co',
        category: 'open-source',
        tags: ['business-management', 'productivity'],
    },
    {
        name: 'ActivityWatch',
        description: 'Free and open-source automated time tracker. Cross-platform, extensible, privacy-focused.',
        source_url: 'https://activitywatch.net',
        category: 'open-source',
        tags: ['productivity'],
    },
    {
        name: 'Timewarrior',
        description: 'Commandline Time Tracking and Reporting.',
        source_url: 'https://github.com/GothenburgBitFactory/timewarrior',
        category: 'open-source',
        tags: ['productivity'],

    },
    {
        name: 'Time Tracker',
        description: 'Time Tracker, to be the best time tracker for browsers',
        source_url: 'https://www.wfhg.cc',
        category: 'open-source',
        tags: ['productivity'],
    },
    {
        name: 'TomeTracker',
        description: 'Time tracking app using localstorage.',
        source_url: 'https://github.com/tommerty/TomeTracker',
        category: 'open-source',
        tags: ['productivity'],
    },
    {
        name: 'HubStaff',
        description: 'One app to automate time-tracking processes, workforce management, and productivity metrics.',
        source_url: 'https://hubstaff.com',
        category: 'commercial',
        tags: ['productivity'],
    },
    {
        name: 'TimeOS',
        description: 'AI productivity companion that captures and summarizes your day, organizes all relevant information within the right tool, and proactively surfaces the knowledge you need, when you need it.',
        source_url: 'https://www.timeos.ai',
        category: 'commercial',
        tags: ['productivity'],
    },
    {
        name: 'Invobook',
        description: 'Self-hosted app for Time Tracking, Invoice Generation, Project & Client Management, built with Laravel & Filament.',
        source_url: 'https://github.com/Hasnayeen/invobook',
        category: 'open-source',
        tags: ['productivity'],
    },
    {
        name: 'Titra',
        description: 'Modern open source project time tracking for freelancers and small teams.',
        source_url: 'https://titra.io/en',
        category: 'open-source',
        tags: ['productivity'],
    },
    {
        name: 'Selfspy',
        description: 'Log everything you do on the computer, for statistics, future reference and all-around fun!',
        source_url: 'https://github.com/selfspy/selfspy',
        category: 'open-source',
        tags: ['productivity'],
    },
    {
        name: 'Shion',
        description: 'Time Tracker.',
        source_url: 'https://shion.app',
        category: 'open-source',
        tags: ['productivity'],
    },
    {
        name: 'Timestrap',
        description: 'Time-tracking you can host anywhere. Full export support in multiple formats and easily extensible.',
        source_url: 'https://timestrap.bythewood.me',
        category: 'open-source',
        tags: ['productivity'],
    },
    {
        name: 'GNOME Time Tracker',
        description: 'Hamster is time tracking for individuals. It helps you to keep track of how much time you have spent during the day on activities you choose to track.',
        source_url: 'https://github.com/projecthamster/hamster',
        category: 'open-source',
        tags: ['productivity'],
    },
    {
        name: 'TimeTrex',
        description: 'Taking the Work Out of Workforce Management. Automate your time & attendance, payroll and HR management in one easy-to-use platform',
        source_url: 'https://www.timetrex.com',
        category: 'open-source',
        tags: ['productivity'],
    },
    {
        name: 'ULogMe',
        description: 'Automatically collect and visualize usage statistics in Ubuntu/OSX environments.',
        source_url: 'https://github.com/karpathy/ulogme',
        category: 'open-source',
        tags: ['productivity'],
    },
    {
        name: 'Traggo',
        description: 'Self-hosted tag-based time tracking.',
        source_url: 'https://traggo.net',
        category: 'open-source',
        tags: ['productivity'],
    }
];

@Injectable()
export class AiEngineService {
    async getItemsList(input: { prompt: string, categories: Category[], tags: Tag[] }) {
        return data;
    }

    async getCategoryList(): Promise<Category[]> {
        return [
            { id: 'open-source', name: 'Open Source' },
            { id: 'commercial', name: 'Commercial' },
        ]
    }

    async getTagsList() {
        return tags;
    }

    async getItemDetails(item: ItemData) {
        return (
            `# ${item.name}\n\n` +
            'Lorem ipsum odor amet, consectetuer adipiscing elit.\n' +
            'Augue lobortis tempus ridiculus phasellus platea quis.\n' +
            'Suspendisse enim auctor luctus phasellus pretium natoque laoreet.\n' +
            'Nulla sodales hac accumsan, enim potenti porttitor.\n' +
            '## Another section\n' +
            'Finibus congue natoque placerat lacinia nibh ornare? Morbi netus curabitur, viverra maximus pulvinar efficitur natoque.\n' +
            'Sollicitudin nec porta libero, maecenas nam cursus.\n' +
            'Nascetur ridiculus praesent ac sagittis vel conubia gravida.\n' +
            'Ac tellus molestie vel ad praesent imperdiet.\n' +
            'Taciti vel sagittis nisl fermentum ornare senectus.\n'
        );
    }
}

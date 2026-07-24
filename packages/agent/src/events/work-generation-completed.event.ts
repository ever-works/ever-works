import { Work } from '@src/entities/work.entity';
import { BaseEvent } from './base';

export class WorkGenerationCompletedEvent extends BaseEvent {
    static EVENT_NAME = 'work.generation.completed';

    constructor(public readonly work: Work) {
        super();
    }
}

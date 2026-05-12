import {
	Column,
	CreateDateColumn,
	Entity,
	Index,
	JoinColumn,
	ManyToOne,
	PrimaryGeneratedColumn,
	UpdateDateColumn
} from 'typeorm';
import { User } from './user.entity';
import { Work } from './work.entity';

export type WorkProposalStatus = 'pending' | 'dismissed' | 'accepted';

export type WorkProposalSource = 'auto-signup' | 'user-refresh' | 'discover' | 'scheduled';

export interface WorkProposalCategory {
	name: string;
	slug: string;
}

export type WorkProposalFieldType = 'string' | 'url' | 'image' | 'number' | 'enum' | 'markdown';

export interface WorkProposalField {
	name: string;
	type: WorkProposalFieldType;
}

export interface WorkProposalRecommendedPlugin {
	pluginId: string;
	reason: string;
}

@Entity({ name: 'work_proposals' })
@Index('idx_work_proposals_user_status_generated', ['userId', 'status', 'generatedAt'])
export class WorkProposal {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column('uuid')
	userId: string;

	@ManyToOne(() => User, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'userId' })
	user?: User;

	@Column({ length: 120 })
	title: string;

	@Column({ type: 'text' })
	description: string;

	@Column({ length: 80 })
	slugSuggestion: string;

	@Column('simple-json')
	suggestedCategories: WorkProposalCategory[];

	@Column('simple-json')
	suggestedFields: WorkProposalField[];

	@Column('simple-json')
	recommendedPlugins: WorkProposalRecommendedPlugin[];

	@Column({ type: 'text' })
	reasoning: string;

	@Column({ default: 'auto-signup' })
	source: WorkProposalSource;

	@Column({ default: 'pending' })
	status: WorkProposalStatus;

	@Column('uuid', { nullable: true })
	acceptedWorkId?: string | null;

	@ManyToOne(() => Work, { nullable: true, onDelete: 'SET NULL' })
	@JoinColumn({ name: 'acceptedWorkId' })
	acceptedWork?: Work | null;

	@Column({ nullable: true })
	generationRunId?: string;

	@CreateDateColumn()
	generatedAt: Date;

	@UpdateDateColumn()
	updatedAt: Date;
}

import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

@Entity()
@Index(['owner', 'slug'], { unique: true }) // Unique constraint on owner + slug combination
export class Directory {
	@PrimaryGeneratedColumn()
	id: number;

	@Column()
	name: string;

	@Column()
	slug: string;

	@Column({ nullable: true })
	website: string;

	@Column()
	owner: string;

	@Column({ nullable: true })
	companyName: string;

	@Column({ default: false })
	organization: boolean;

	@Column()
	description: string;

	@Column('simple-json', { nullable: true })
	readmeConfig: MarkdownReadmeConfig;

	getDataRepo() {
		return `${this.slug}-data`;
	}

	getWebsiteRepo() {
		return `${this.slug}-website`;
	}
}

export interface MarkdownReadmeConfig {
	header?: string;
	overwrite_default_header?: boolean;

	footer?: string;
	overwrite_default_footer?: boolean;
}

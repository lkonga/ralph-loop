import * as fs from 'fs';
import * as path from 'path';

export class KnowledgeManager {
	private readonly knowledgePath: string;
	private readonly maxInjectLines: number;

	constructor(knowledgePath: string = 'knowledge.md', maxInjectLines: number = 15) {
		this.knowledgePath = knowledgePath;
		this.maxInjectLines = maxInjectLines;
	}

	extractLearnings(output: string): string[] {
		return this.extractTagged(output, 'LEARNING');
	}

	extractGaps(output: string): string[] {
		return this.extractTagged(output, 'GAP');
	}

	persist(workspaceRoot: string, learnings: string[], gaps: string[]): void {
		if (learnings.length === 0 && gaps.length === 0) { return; }

		const filePath = path.join(workspaceRoot, this.knowledgePath);
		const timestamp = new Date().toISOString().slice(0, 10);

		if (!fs.existsSync(filePath)) {
			fs.writeFileSync(filePath, '# Knowledge\n\n## Learnings\n\n## Gaps\n');
		}

		const entries: string[] = [];
		for (const l of learnings) {
			entries.push(`- ${timestamp}: ${l}\n`);
		}
		if (gaps.length > 0) {
			for (const g of gaps) {
				entries.push(`- ${timestamp}: [GAP] ${g}\n`);
			}
		}

		fs.appendFileSync(filePath, entries.join(''));
	}

	getRelevantLearnings(workspaceRoot: string, taskDescription: string): string[] {
		const filePath = path.join(workspaceRoot, this.knowledgePath);
		if (!fs.existsSync(filePath)) { return []; }

		const keywords = taskDescription
			.split(/\s+/)
			.filter(w => w.length >= 4)
			.map(w => w.toLowerCase());

		if (keywords.length === 0) { return []; }

		const content = fs.readFileSync(filePath, 'utf-8');
		const learningsSection = this.extractSection(content, 'Learnings');

		const learningLines = learningsSection
			.split('\n')
			.filter(line => line.trim().startsWith('- '))
			.map(line => {
				const match = line.match(/^- \d{4}-\d{2}-\d{2}:\s*(.*)$/);
				return match ? match[1] : line.replace(/^- /, '');
			});

		const matched = learningLines.filter(learning => {
			const lower = learning.toLowerCase();
			const matchCount = keywords.filter(kw => lower.includes(kw)).length;
			return matchCount >= 2;
		});

		return matched.slice(-this.maxInjectLines);
	}

	private extractTagged(output: string, tag: string): string[] {
		const regex = new RegExp(`\\[${tag}\\]\\s*`, 'i');
		return output
			.split('\n')
			.filter(line => regex.test(line))
			.map(line => line.replace(regex, '').trim());
	}

	private extractSection(content: string, sectionName: string): string {
		const regex = new RegExp(`## ${sectionName}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`);
		const match = content.match(regex);
		return match ? match[1] : '';
	}
}

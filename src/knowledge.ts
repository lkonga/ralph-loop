import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { KnowledgeEntry, KnowledgeCategory, HarvestConfig } from './types';

export function computeEntryHash(content: string): string {
	return crypto.createHash('md5').update(content.toLowerCase().trim()).digest('hex');
}

export function categorizeEntry(content: string): KnowledgeCategory {
	const lower = content.toLowerCase();
	if (/\[gap\]/i.test(content)) { return 'gap'; }
	if (/\b(fix|resolve|error)\b/i.test(lower)) { return 'fix'; }
	if (/\b(pattern|approach|strategy)\b/i.test(lower)) { return 'pattern'; }
	return 'context';
}

export function extract(output: string, taskId: string): KnowledgeEntry[] {
	const timestamp = new Date().toISOString().slice(0, 10);
	const learningRegex = /\[LEARNING\]\s*/i;
	const gapRegex = /\[GAP\]\s*/i;
	const entries: KnowledgeEntry[] = [];

	for (const line of output.split('\n')) {
		if (learningRegex.test(line)) {
			const content = line.replace(learningRegex, '').trim();
			entries.push({ content, category: 'context', timestamp, taskId, hash: computeEntryHash(content) });
		} else if (gapRegex.test(line)) {
			const content = line.replace(gapRegex, '').trim();
			entries.push({ content, category: 'gap', timestamp, taskId, hash: computeEntryHash(content) });
		}
	}
	return entries;
}

export function dedup(entries: KnowledgeEntry[], existingContent: string): KnowledgeEntry[] {
	const existingHashes = new Set<string>();
	const hashPattern = /<!-- hash:([0-9a-f]+) -->/g;
	let match: RegExpExecArray | null;
	while ((match = hashPattern.exec(existingContent)) !== null) {
		existingHashes.add(match[1]);
	}

	const seen = new Set<string>();
	return entries.filter(entry => {
		if (existingHashes.has(entry.hash) || seen.has(entry.hash)) { return false; }
		seen.add(entry.hash);
		return true;
	});
}

export function categorize(entries: KnowledgeEntry[]): KnowledgeEntry[] {
	return entries.map(entry => {
		if (entry.category === 'gap') { return entry; }
		return { ...entry, category: categorizeEntry(entry.content) };
	});
}

export class HarvestPipeline {
	private readonly stages: Set<string>;

	constructor(config: HarvestConfig) {
		this.stages = new Set(config.stages);
	}

	run(output: string, taskId: string, workspaceRoot: string, knowledgePath: string): KnowledgeEntry[] {
		let entries: KnowledgeEntry[] = [];

		if (this.stages.has('extract')) {
			entries = extract(output, taskId);
		}
		if (entries.length === 0) { return []; }

		if (this.stages.has('dedup')) {
			const filePath = path.join(workspaceRoot, knowledgePath);
			const existingContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
			entries = dedup(entries, existingContent);
		}
		if (entries.length === 0) { return []; }

		if (this.stages.has('categorize')) {
			entries = categorize(entries);
		}

		if (this.stages.has('persist')) {
			this.persist(entries, workspaceRoot, knowledgePath);
		}

		return entries;
	}

	private persist(entries: KnowledgeEntry[], workspaceRoot: string, knowledgePath: string): void {
		if (entries.length === 0) { return; }
		const filePath = path.join(workspaceRoot, knowledgePath);

		if (!fs.existsSync(filePath)) {
			fs.writeFileSync(filePath, '# Knowledge\n\n## Learnings\n\n## Gaps\n');
		}

		const lines = entries.map(e =>
			`- ${e.timestamp}: ${e.content} <!-- hash:${e.hash} -->\n`
		);
		fs.appendFileSync(filePath, lines.join(''));
	}
}

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

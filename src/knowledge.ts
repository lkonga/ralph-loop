import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { KnowledgeEntry, KnowledgeCategory, HarvestConfig, GCPolicy } from './types';

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

export interface EntryMeta {
	hits: number;
	createdAtRun: number;
	lastHitRun: number;
}

export interface GCResult {
	kept: string[];
	archived: string[];
}

export class KnowledgeGC {
	private readonly policy: GCPolicy;

	constructor(policy: GCPolicy) {
		this.policy = policy;
	}

	shouldTrigger(runCount: number): boolean {
		return runCount > 0 && runCount % this.policy.triggerEveryNRuns === 0;
	}

	recordHit(meta: Record<string, EntryMeta>, hash: string, currentRun: number): void {
		if (!meta[hash]) {
			meta[hash] = { hits: 0, createdAtRun: currentRun, lastHitRun: 0 };
		}
		meta[hash].hits++;
		meta[hash].lastHitRun = currentRun;
	}

	collectGarbage(knowledgeContent: string, meta: Record<string, EntryMeta>, currentRun: number): GCResult {
		const hashPattern = /<!-- hash:([0-9a-f]+) -->/;
		const lines = knowledgeContent.split('\n').filter(l => l.trim().startsWith('- ') && hashPattern.test(l));

		if (lines.length === 0) {
			return { kept: [], archived: [] };
		}

		const scored = lines.map(line => {
			const match = line.match(hashPattern);
			const hash = match ? match[1] : '';
			const entry = meta[hash];
			if (!entry) {
				return { line, hash, score: 1, stale: false };
			}
			const age = currentRun - entry.createdAtRun;
			const isStale = entry.hits === 0 && age > this.policy.stalenessThreshold;
			const score = entry.hits + (entry.lastHitRun > 0 ? 1 : 0);
			return { line, hash, score, stale: isStale };
		});

		// First pass: archive stale entries
		let kept = scored.filter(e => !e.stale);
		let archived = scored.filter(e => e.stale);

		// Second pass: enforce maxEntries cap
		if (kept.length > this.policy.maxEntries) {
			kept.sort((a, b) => b.score - a.score);
			const overflow = kept.splice(this.policy.maxEntries);
			archived = archived.concat(overflow);
		}

		return {
			kept: kept.map(e => e.line),
			archived: archived.map(e => e.line),
		};
	}

	runGC(workspaceRoot: string, knowledgePath: string, currentRun: number): void {
		const filePath = path.join(workspaceRoot, knowledgePath);
		if (!fs.existsSync(filePath)) { return; }

		const knowledgeContent = fs.readFileSync(filePath, 'utf-8');

		const metaPath = path.join(workspaceRoot, 'knowledge-meta.json');
		const meta: Record<string, EntryMeta> = fs.existsSync(metaPath)
			? JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
			: {};

		const hashPattern = /<!-- hash:([0-9a-f]+) -->/;
		const entryLines = knowledgeContent.split('\n').filter(l => l.trim().startsWith('- ') && hashPattern.test(l));
		const nonEntryLines = knowledgeContent.split('\n').filter(l => !(l.trim().startsWith('- ') && hashPattern.test(l)));

		const result = this.collectGarbage(entryLines.join('\n'), meta, currentRun);

		if (result.archived.length === 0) { return; }

		const archivePath = path.join(workspaceRoot, 'knowledge-archive.md');
		let archiveContent = '';
		if (fs.existsSync(archivePath)) {
			archiveContent = fs.readFileSync(archivePath, 'utf-8');
		} else {
			archiveContent = '# Knowledge Archive\n\n';
		}
		archiveContent += result.archived.join('\n') + '\n';
		fs.writeFileSync(archivePath, archiveContent);

		const newContent = nonEntryLines.join('\n') + (result.kept.length > 0 ? '\n' + result.kept.join('\n') + '\n' : '\n');
		fs.writeFileSync(filePath, newContent);

		// Clean up meta for archived entries
		for (const line of result.archived) {
			const match = line.match(hashPattern);
			if (match) { delete meta[match[1]]; }
		}
		fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
	}
}

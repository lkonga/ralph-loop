#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import { readPrdSnapshot, pickNextTask, resolvePrdPath } from '../src/prd';
import { DEFAULT_CONFIG, createConsoleLogger } from '../src/types';
import { progressSummary } from '../src/verify';

const logger = createConsoleLogger();

function usage(): void {
	console.log(`
ralph-loop CLI — PRD task runner for VS Code Copilot

Usage:
  ralph status [--prd <path>]     Show PRD progress
  ralph next   [--prd <path>]     Show next pending task
  ralph init   [--prd <path>]     Create a blank PRD.md template
  ralph help                      Show this help

Options:
  --prd <path>   Path to PRD.md (default: PRD.md)
  --cwd <path>   Working directory (default: .)
`);
}

function arg(name: string): string | undefined {
	const idx = process.argv.indexOf(name);
	if (idx !== -1 && idx + 1 < process.argv.length) {
		return process.argv[idx + 1];
	}
	return undefined;
}

const command = process.argv[2];
const prdRelative = arg('--prd') ?? DEFAULT_CONFIG.prdPath;
const cwd = arg('--cwd') ?? process.cwd();
const prdPath = resolvePrdPath(cwd, prdRelative);

switch (command) {
	case 'status': {
		if (!fs.existsSync(prdPath)) {
			logger.error(`PRD not found: ${prdPath}`);
			process.exit(1);
		}
		const { total, completed, remaining } = progressSummary(prdPath);
		console.log(`PRD: ${prdPath}`);
		console.log(`Total: ${total}  Completed: ${completed}  Remaining: ${remaining}`);

		const snapshot = readPrdSnapshot(prdPath);
		for (const task of snapshot.tasks) {
			const mark = task.status === 'complete' ? '[x]' : '[ ]';
			console.log(`  ${mark} ${task.description}`);
		}
		break;
	}

	case 'next': {
		if (!fs.existsSync(prdPath)) {
			logger.error(`PRD not found: ${prdPath}`);
			process.exit(1);
		}
		const snapshot = readPrdSnapshot(prdPath);
		const next = pickNextTask(snapshot);
		if (next) {
			console.log(next.description);
		} else {
			console.log('All tasks complete');
		}
		break;
	}

	case 'init': {
		if (fs.existsSync(prdPath)) {
			logger.warn(`PRD already exists: ${prdPath}`);
			process.exit(1);
		}
		const template = `# Project Requirements Document

## Tasks

- [ ] First task description
- [ ] Second task description
- [ ] Third task description
`;
		fs.writeFileSync(prdPath, template, 'utf-8');
		logger.log(`Created ${prdPath}`);
		break;
	}

	case 'help':
	case '--help':
	case '-h':
	case undefined:
		usage();
		break;

	default:
		logger.error(`Unknown command: ${command}`);
		usage();
		process.exit(1);
}

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ILogger, RalphConfig } from './types';

// Generates the Node.js hook script content that Copilot will invoke on stdin
function generateStopHookScript(prdPath: string): string {
	// The script reads a JSON hook invocation from stdin,
	// checks whether the current task's PRD checkbox is marked,
	// and returns the appropriate result on stdout.
	return `#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const PRD_PATH = ${JSON.stringify(prdPath)};

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => { resolve(data); });
  });
}

async function main() {
  await readStdin();

  let prdContent;
  try {
    prdContent = fs.readFileSync(PRD_PATH, 'utf-8');
  } catch (err) {
    // PRD not found — let Copilot stop (can't verify)
    process.stdout.write(JSON.stringify({ resultKind: 'success' }));
    return;
  }

  const lines = prdContent.split('\\n');
  const unchecked = lines.filter(l => /^\\s*-\\s*\\[\\s*\\]\\s+/.test(l));
  const checked = lines.filter(l => /^\\s*-\\s*\\[x\\]/i.test(l));

  if (unchecked.length === 0 && checked.length > 0) {
    // All tasks done
    process.stdout.write(JSON.stringify({ resultKind: 'success' }));
  } else if (unchecked.length > 0) {
    // Tasks remain — block the stop
    process.stdout.write(JSON.stringify({
      resultKind: 'error',
      stopReason: 'Task not complete \\u2014 checkbox not marked in PRD.md'
    }));
  } else {
    // No tasks at all — let it stop
    process.stdout.write(JSON.stringify({ resultKind: 'success' }));
  }
}

main().catch(() => {
  process.stdout.write(JSON.stringify({ resultKind: 'success' }));
});
`;
}

function generatePostToolUseHookScript(): string {
	// PostToolUse hook: writes a timestamp marker file so the extension can
	// detect tool activity and reset its inactivity timer.
	const markerPath = path.join(os.tmpdir(), 'ralph-loop-tool-activity.marker');
	return `#!/usr/bin/env node
'use strict';

const fs = require('fs');

const MARKER_PATH = ${JSON.stringify(markerPath)};

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => { resolve(data); });
  });
}

async function main() {
  await readStdin();
  // Touch the marker file to signal tool activity
  fs.writeFileSync(MARKER_PATH, Date.now().toString(), 'utf-8');
  process.stdout.write(JSON.stringify({ resultKind: 'success' }));
}

main().catch(() => {
  process.stdout.write(JSON.stringify({ resultKind: 'success' }));
});
`;
}

export interface HookBridgeDisposable {
	dispose(): void;
}

/**
 * Registers ralph-loop as a Copilot chat hook provider via the ChatHookCommand proposed API.
 * Generates small Node.js scripts at runtime for Stop and PostToolUse hooks,
 * writes them to temp files, and registers them in chat.hooks configuration.
 *
 * Requires vscode.proposed.chatHooks API — gated behind useHookBridge config flag.
 */
export function registerHookBridge(
	config: RalphConfig,
	logger: ILogger,
): HookBridgeDisposable {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-hook-'));
	const stopScriptPath = path.join(tmpDir, 'stop-hook.js');
	const postToolUseScriptPath = path.join(tmpDir, 'post-tool-use-hook.js');

	const prdPath = path.resolve(config.workspaceRoot, config.prdPath);

	// Write the hook scripts to temp files
	fs.writeFileSync(stopScriptPath, generateStopHookScript(prdPath), { mode: 0o755 });
	fs.writeFileSync(postToolUseScriptPath, generatePostToolUseHookScript(), { mode: 0o755 });
	logger.log(`Hook bridge scripts written to ${tmpDir}`);

	// Register hooks via VS Code's chat.hooks configuration
	const chatHooksConfig = vscode.workspace.getConfiguration('chat');
	const existingHooks = chatHooksConfig.get<Record<string, unknown>>('hooks', {});

	const stopHookCommand: Record<string, unknown> = {
		command: process.execPath,
		args: [stopScriptPath],
	};

	const postToolUseHookCommand: Record<string, unknown> = {
		command: process.execPath,
		args: [postToolUseScriptPath],
	};

	const updatedHooks = {
		...existingHooks,
		Stop: stopHookCommand,
		PostToolUse: postToolUseHookCommand,
	};

	chatHooksConfig.update('hooks', updatedHooks, vscode.ConfigurationTarget.Workspace).then(
		() => logger.log('Chat hooks registered: Stop, PostToolUse'),
		(err: Error) => logger.error(`Failed to register chat hooks: ${err.message}`),
	);

	// Watch the tool activity marker file to reset inactivity timer
	const markerPath = path.join(os.tmpdir(), 'ralph-loop-tool-activity.marker');
	let markerWatcher: fs.FSWatcher | undefined;

	try {
		// Ensure the marker file exists so we can watch it
		if (!fs.existsSync(markerPath)) {
			fs.writeFileSync(markerPath, '0', 'utf-8');
		}
		markerWatcher = fs.watch(markerPath, () => {
			logger.log('PostToolUse hook fired — tool activity detected');
		});
	} catch {
		logger.warn('Could not watch tool activity marker file');
	}

	return {
		dispose() {
			markerWatcher?.close();

			// Clean up hook scripts
			try { fs.unlinkSync(stopScriptPath); } catch { /* best effort */ }
			try { fs.unlinkSync(postToolUseScriptPath); } catch { /* best effort */ }
			try { fs.rmdirSync(tmpDir); } catch { /* best effort */ }

			// Remove our hooks from configuration
			const config = vscode.workspace.getConfiguration('chat');
			const hooks = config.get<Record<string, unknown>>('hooks', {});
			const cleaned = { ...hooks };
			delete cleaned['Stop'];
			delete cleaned['PostToolUse'];
			config.update('hooks', cleaned, vscode.ConfigurationTarget.Workspace).then(
				() => logger.log('Chat hooks unregistered'),
				() => { /* best effort */ },
			);
		},
	};
}

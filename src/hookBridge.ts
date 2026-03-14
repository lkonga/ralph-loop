import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ILogger, RalphConfig, DEFAULT_PRE_COMPLETE_HOOKS } from './types';

export { DEFAULT_PRE_COMPLETE_HOOKS };

// Generates the Node.js hook script content that Copilot will invoke on stdin
export function generateStopHookScript(prdPath: string, progressPath: string): string {
    // The script reads a JSON hook invocation from stdin,
    // checks whether the current task's PRD checkbox is marked,
    // and runs a full verification gate (TDD is mandatory).
    return `#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { execSync } = require('child_process');

const PRD_PATH = ${JSON.stringify(prdPath)};
const PROGRESS_PATH = ${JSON.stringify(progressPath)};

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => { resolve(data); });
  });
}

function runCommand(cmd) {
  try {
    const stdout = execSync(cmd, { stdio: 'pipe', timeout: 120000 }).toString().trim();
    return { ok: true, stdout: stdout, stderr: '' };
  } catch (err) {
    return { ok: false, stdout: (err.stdout || '').toString().trim(), stderr: (err.stderr || '').toString().trim() };
  }
}

async function main() {
  await readStdin();

  const failures = [];

  // PreComplete hook: prd-checkbox-check
  // Check 1: PRD checkbox is marked
  let prdContent;
  try {
    prdContent = fs.readFileSync(PRD_PATH, 'utf-8');
  } catch (err) {
    process.stdout.write(JSON.stringify({ resultKind: 'success' }));
    return;
  }

  const lines = prdContent.split('\\n');
  const unchecked = lines.filter(l => /^\\s*-\\s*\\[\\s*\\]\\s+/.test(l));
  const checked = lines.filter(l => /^\\s*-\\s*\\[x\\]/i.test(l));

  if (unchecked.length > 0) {
    failures.push('PRD checkbox not marked');
  } else if (checked.length === 0) {
    process.stdout.write(JSON.stringify({ resultKind: 'success' }));
    return;
  }

  // PreComplete hook: progress-updated (mtime within 5 min)
  // Check 2: progress.txt was updated
  try {
    const stat = fs.statSync(PROGRESS_PATH);
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    if (stat.mtimeMs < fiveMinAgo) {
      failures.push('progress.txt not recently updated');
    }
  } catch {
    failures.push('progress.txt not found');
  }

  // Check 3: TypeScript compilation
  const tsc = runCommand('npx tsc --noEmit');
  if (!tsc.ok) {
    failures.push('TypeScript compilation errors: ' + (tsc.stdout || tsc.stderr || 'see tsc output'));
  }

  // Check 4: Test failures
  const vitest = runCommand('npx vitest run');
  if (!vitest.ok) {
    failures.push('Test failures: ' + (vitest.stdout || vitest.stderr || 'see vitest output'));
  }

  if (failures.length === 0) {
    process.stdout.write(JSON.stringify({ resultKind: 'success' }));
  } else {
    process.stdout.write(JSON.stringify({
      resultKind: 'error',
      stopReason: 'Verification failed: ' + failures.join('; ')
    }));
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
    const progressPath = path.resolve(config.workspaceRoot, config.progressPath);

    // Write the hook scripts to temp files
    fs.writeFileSync(stopScriptPath, generateStopHookScript(prdPath, progressPath), { mode: 0o755 });
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

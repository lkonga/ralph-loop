import * as vscode from 'vscode';
import type { LoopState, StateSnapshot } from './types';

let item: vscode.StatusBarItem | undefined;

const STATE_ICONS: Record<string, string> = {
    running: '$(sync~spin)',
    paused: '$(debug-pause)',
    idle: '$(circle-outline)',
};

function formatText(snapshot: StateSnapshot): string {
    const icon = STATE_ICONS[snapshot.state] ?? '$(question)';
    const parts = [`Ralph: ${icon}`];

    if (snapshot.taskId) {
        parts.push(snapshot.taskId);
    }

    const iter = snapshot.iterationCount;
    const nudge = snapshot.nudgeCount;
    if (iter > 0 || nudge > 0) {
        parts.push(`I:${iter} N:${nudge}`);
    }

    return parts.join(' ');
}

function buildTooltip(snapshot: StateSnapshot): vscode.MarkdownString {
    const lines = [
        `**Ralph Loop**`,
        `**State:** ${snapshot.state}`,
    ];
    if (snapshot.taskId) {
        lines.push(`**Task:** ${snapshot.taskId}`);
    }
    if (snapshot.taskDescription) {
        lines.push(`**Description:** ${snapshot.taskDescription}`);
    }
    const iter = snapshot.iterationCount;
    const nudge = snapshot.nudgeCount;
    if (iter > 0 || nudge > 0) {
        lines.push(`**Iterations:** ${iter} | **Nudges:** ${nudge}`);
    }
    const md = new vscode.MarkdownString(lines.join('\n'));
    md.isTrusted = true;
    return md;
}

function ensureItem(): vscode.StatusBarItem {
    if (!item) {
        item = vscode.window.createStatusBarItem('ralph-loop.status', vscode.StatusBarAlignment.Right, 99);
        item.name = 'Ralph Loop Status';
        item.command = 'ralph-loop.status';
    }
    return item;
}

export function updateStatusBar(snapshot: StateSnapshot): void {
    const bar = ensureItem();
    bar.text = formatText(snapshot);
    bar.tooltip = buildTooltip(snapshot);

    if (snapshot.state === 'idle' && !snapshot.taskId) {
        bar.hide();
    } else {
        bar.show();
    }
}

export function showStatusBarIdle(): void {
    updateStatusBar({ state: 'idle', taskId: '', taskDescription: '', iterationCount: 0, nudgeCount: 0 });
}

export function disposeStatusBar(): void {
    item?.dispose();
    item = undefined;
}

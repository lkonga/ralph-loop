import * as vscode from 'vscode';
import type { LoopState, StateSnapshot, PrdSnapshot } from './types';

let item: vscode.StatusBarItem | undefined;
let currentLanes: LaneProgress[] = [];
let focusedLaneId: string | undefined;

export interface LaneProgress {
    readonly repoId: string;
    readonly completed: number;
    readonly total: number;
    readonly allDone: boolean;
}

const STATE_ICONS: Record<string, string> = {
    running: '$(sync~spin)',
    paused: '$(debug-pause)',
    idle: '$(circle-outline)',
};

export function computeLaneProgress(snapshots: Map<string, PrdSnapshot>): LaneProgress[] {
    const result: LaneProgress[] = [];
    for (const [repoId, snap] of snapshots) {
        result.push({
            repoId,
            completed: snap.completed,
            total: snap.total,
            allDone: snap.total > 0 && snap.completed === snap.total,
        });
    }
    return result;
}

export function formatLaneText(snapshot: StateSnapshot, lanes: LaneProgress[]): string {
    const icon = STATE_ICONS[snapshot.state] ?? '$(question)';
    const repoId = snapshot.activeRepoId;

    if (repoId && lanes.length > 0) {
        const lane = lanes.find(l => l.repoId === repoId);
        const progress = lane ? `Task ${lane.completed}/${lane.total}` : '';
        const parts = ['ralph', repoId, snapshot.state, progress].filter(Boolean);
        return `${icon} ${parts.join(' • ')}`;
    }

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

export function buildLaneTooltipLines(lanes: LaneProgress[]): string[] {
    return lanes.map(l => {
        if (l.allDone) {
            return `✓ ${l.repoId}: ${l.completed}/${l.total} done`;
        }
        if (l.total === 0) {
            return `${l.repoId}: idle`;
        }
        return `${l.repoId}: ${l.completed}/${l.total} done`;
    });
}

export function formatLaneSummaryTable(lanes: LaneProgress[]): string {
    if (lanes.length === 0) { return ''; }
    const header = 'Repo           | Progress | Status';
    const separator = '---------------|----------|-------';
    const rows = lanes.map(l => {
        const status = l.allDone ? '✓' : l.total === 0 ? 'idle' : 'running';
        const progress = l.total === 0 ? 'idle' : `${l.completed}/${l.total}`;
        return `${l.repoId.padEnd(15)}| ${progress.padEnd(9)}| ${status}`;
    });
    return [header, separator, ...rows].join('\n');
}

export function buildStatusOutput(state: string, lanes: LaneProgress[]): string {
    const parts = [`Ralph Loop: ${state}`];
    const table = formatLaneSummaryTable(lanes);
    if (table) {
        parts.push('', table);
    }
    return parts.join('\n');
}

function buildTooltip(snapshot: StateSnapshot, lanes: LaneProgress[]): vscode.MarkdownString {
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
    if (snapshot.branch) {
        lines.push(`**Branch:** ${snapshot.branch}`);
    }
    const iter = snapshot.iterationCount;
    const nudge = snapshot.nudgeCount;
    if (iter > 0 || nudge > 0) {
        lines.push(`**Iterations:** ${iter} | **Nudges:** ${nudge}`);
    }
    if (lanes.length > 0) {
        lines.push('', '**Lanes:**');
        lines.push(...buildLaneTooltipLines(lanes));
    }
    const md = new vscode.MarkdownString(lines.join('\n'));
    md.isTrusted = true;
    return md;
}

function ensureItem(): vscode.StatusBarItem {
    if (!item) {
        item = vscode.window.createStatusBarItem('ralph-loop.status', vscode.StatusBarAlignment.Right, 99);
        item.name = 'Ralph Loop Status';
        item.command = 'ralph-loop.selectLane';
    }
    return item;
}

export function setLaneProgress(lanes: LaneProgress[]): void {
    currentLanes = lanes;
}

export function getFocusedLane(): string | undefined {
    return focusedLaneId;
}

export function setFocusedLane(repoId: string | undefined): void {
    focusedLaneId = repoId;
}

export async function showLanePicker(lanes: LaneProgress[]): Promise<string | undefined> {
    const items = [
        { label: '$(list-flat) All Lanes', repoId: undefined as string | undefined },
        ...lanes.map(l => ({
            label: l.allDone ? `✓ ${l.repoId}` : l.repoId,
            description: l.total === 0 ? 'idle' : `${l.completed}/${l.total} done`,
            repoId: l.repoId as string | undefined,
        })),
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select lane to focus on' });
    if (picked) {
        focusedLaneId = picked.repoId;
    }
    return picked?.repoId;
}

export function updateStatusBar(snapshot: StateSnapshot, lanes?: LaneProgress[]): void {
    const bar = ensureItem();
    const effectiveLanes = lanes ?? currentLanes;
    bar.text = formatLaneText(snapshot, effectiveLanes);
    bar.tooltip = buildTooltip(snapshot, effectiveLanes);

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
    currentLanes = [];
    focusedLaneId = undefined;
}

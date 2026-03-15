import * as fs from 'fs';
import * as path from 'path';

export interface SerializedLoopState {
    currentTaskIndex: number;
    iterationCount: number;
    nudgeCount: number;
    retryCount: number;
    circuitBreakerState: string;
    timestamp: number;
    version: number;
}

const SESSION_DIR = '.ralph';
const SESSION_FILE = 'session.json';
const CURRENT_VERSION = 1;
const DEFAULT_EXPIRE_MS = 86400000; // 24 hours

export class SessionPersistence {
    private readonly expireAfterMs: number;

    constructor(expireAfterMs: number = DEFAULT_EXPIRE_MS) {
        this.expireAfterMs = expireAfterMs;
    }

    save(workspaceRoot: string, state: SerializedLoopState): void {
        const dir = path.join(workspaceRoot, SESSION_DIR);
        fs.mkdirSync(dir, { recursive: true });
        const data: SerializedLoopState = { ...state, version: CURRENT_VERSION };
        fs.writeFileSync(path.join(dir, SESSION_FILE), JSON.stringify(data), 'utf-8');
    }

    load(workspaceRoot: string): SerializedLoopState | null {
        const filePath = path.join(workspaceRoot, SESSION_DIR, SESSION_FILE);
        if (!fs.existsSync(filePath)) {
            return null;
        }
        try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SerializedLoopState;
            if (data.version !== CURRENT_VERSION) {
                return null;
            }
            return data;
        } catch {
            return null;
        }
    }

    clear(workspaceRoot: string): void {
        const filePath = path.join(workspaceRoot, SESSION_DIR, SESSION_FILE);
        try {
            fs.unlinkSync(filePath);
        } catch {
            // file may not exist
        }
    }

    hasIncompleteSession(workspaceRoot: string): boolean {
        const state = this.load(workspaceRoot);
        if (!state) {
            return false;
        }
        return (Date.now() - state.timestamp) < this.expireAfterMs;
    }
}

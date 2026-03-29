export const workspace = {
	getConfiguration: () => ({
		get: () => undefined,
		update: () => Promise.resolve(),
	}),
	fs: {
		stat: async () => ({ type: 1, ctime: 0, mtime: 0, size: 0 }),
		readFile: async () => new Uint8Array(),
	},
};
export const window = {
	showInformationMessage: async () => undefined,
	showInputBox: async () => undefined,
	showWarningMessage: async () => undefined,
};
export const env = {
	clipboard: {
		writeText: async () => {},
		readText: async () => '',
	},
};
export const commands = {
	executeCommand: async () => undefined,
};
export const Uri = {
	file: (path: string) => ({ scheme: 'file', path, fsPath: path }),
	parse: (uri: string) => ({ scheme: 'file', path: uri, fsPath: uri }),
};
export const ConfigurationTarget = { Workspace: 2 };

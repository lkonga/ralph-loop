export const workspace = {
	getConfiguration: () => ({
		get: () => undefined,
		update: () => Promise.resolve(),
	}),
};
export const window = {
	showInformationMessage: async () => undefined,
	showInputBox: async () => undefined,
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
export const ConfigurationTarget = { Workspace: 2 };

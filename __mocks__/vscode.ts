export const workspace = {
	getConfiguration: () => ({
		get: () => undefined,
		update: () => Promise.resolve(),
	}),
};
export const window = {};
export const env = {
	clipboard: {
		writeText: async () => {},
		readText: async () => '',
	},
};
export const commands = {
	executeCommand: async () => { throw new Error('not available'); },
};
export const ConfigurationTarget = { Workspace: 2 };

export const workspace = {
	getConfiguration: () => ({
		get: () => undefined,
		update: () => Promise.resolve(),
	}),
};
export const window = {};
export const ConfigurationTarget = { Workspace: 2 };

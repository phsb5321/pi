/** Loads the MCP extension's heavy tool, resource, and UI modules on first use. */
export const loadMcpModules = () =>
	Promise.all([
		import("../codemode/tool.ts"),
		import("../tool-search/tool.ts"),
		import("./resources.ts"),
		import("./tools.ts"),
		import("./ui.ts"),
	]);

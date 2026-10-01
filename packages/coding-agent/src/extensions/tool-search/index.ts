/**
 * The `tool_search` tool as an extension. The CLI loads it as a built-in extension; SDK users add
 * `createToolSearchExtension()` to their extension factories.
 *
 * `tool_search` is registered inactive. Activate it with `--tools`, the `defaultTools` setting, or
 * `setActiveTools()`.
 */

import type { ExtensionFactory } from "../../core/extensions/types.ts";
import { loadToolSearchTool } from "./tool.lazy.ts";

export function createToolSearchExtension(): ExtensionFactory {
	return async (pi) => {
		const { createToolSearchToolDefinition } = await loadToolSearchTool();
		pi.registerTool({ ...createToolSearchToolDefinition({ tools: pi }), defaultActive: false });
	};
}

export default createToolSearchExtension();

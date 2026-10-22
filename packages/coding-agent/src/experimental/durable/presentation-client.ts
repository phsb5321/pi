import { attachSession, Client } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { openDurablePresentation } from "./presentation-service.ts";
import { runDurableTui } from "./tui.ts";

/** Native terminal consumer; SDK creation and account contexts stay in the host. */
export async function runSharedDurableTui(options: {
	readonly socket: string;
	readonly serverId: string;
	readonly sessionId: string;
	readonly settings: SettingsManager;
}): Promise<void> {
	const client = await Client.connect({
		serverId: options.serverId,
		transportFactory: createUnixTransportFactory({ path: options.socket }),
	});
	try {
		const attachment = await attachSession(client, options.sessionId);
		const presentation = await openDurablePresentation(attachment.transport);
		try {
			await runDurableTui(presentation.view, presentation.controller, options.settings);
		} finally {
			await presentation.close();
		}
	} finally {
		await client.dispose();
	}
}

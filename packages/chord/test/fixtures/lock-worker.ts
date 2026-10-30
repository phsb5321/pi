// Minimal real child for kernel-lock/replacement tests; RPC host behavior has separate coverage.
import { childControl } from "../../src/manager.ts";

const control = childControl();
await control.lock().catch(() => {
	// Let the fatal control message reach the parent before exiting.
	setTimeout(() => process.exit(1), 200);
	return new Promise<never>(() => {});
});
await control.init;
control.onShutdown(() => process.exit(0));
control.ready();

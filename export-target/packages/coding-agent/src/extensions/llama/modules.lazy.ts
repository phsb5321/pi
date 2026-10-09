/** Loads the llama.cpp extension's provider at factory time (it registers there); the provider value-imports client.ts, so client.ts evaluates here too. */
export const loadLlamaProvider = () => import("./provider.ts");
/** Loads the modules the /llama command path uses. Hugging Face and UI are command-time-only; client is already resident via the provider import. */
export const loadLlamaCommandModules = () =>
	Promise.all([import("./client.ts"), import("./huggingface.ts"), import("./ui.ts")]);

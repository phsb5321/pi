/** Loads the llama.cpp extension's client, Hugging Face, provider, and UI modules on first use. */
export const loadLlamaModules = () =>
	Promise.all([import("./client.ts"), import("./huggingface.ts"), import("./provider.ts"), import("./ui.ts")]);

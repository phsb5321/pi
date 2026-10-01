import type { FileSystem } from "../../types.ts";
import type { SessionCreateOptions, SessionMetadata } from "../types.ts";

export const JSONL_FORMAT_VERSION = 4;
export const JSONL_STORAGE_VERSION = 1;

export interface JsonlStorageHeader {
	v: typeof JSONL_FORMAT_VERSION;
	kind: "header";
	id: string;
	storageVersion: number;
	createdAt: number;
	cwd: string;
	parentSessionId?: string;
	legacyParentSessionPath?: string;
	/** Sequence high-water mark written by snapshot rewrites. */
	nextSeq?: number;
}

export interface JsonlStorageOptions {
	fileSystem: FileSystem;
	path: string;
	now?: () => number;
	/** Retention window for full Entry objects (MS-21 s1). Entries beyond the
	 * window keep only their tree skeleton and hydrate from the JSONL on
	 * demand; behavior is unchanged for every read. Defaults to 300; <= 0 or
	 * undefined on legacy v3 backing disables windowing. */
	retentionWindowEntries?: number;
}

export interface JsonlSessionMetadata extends SessionMetadata {
	cwd: string;
	path: string;
	/** Filesystem modification time as milliseconds since Unix epoch. */
	modifiedAt: number;
}

export interface JsonlSessionCreateOptions extends SessionCreateOptions {
	cwd: string;
}

export interface JsonlSessionListOptions {
	cwd?: string;
}

export interface JsonlSessionRepoOptions {
	fileSystem: FileSystem;
	sessionsRoot: string;
	now?: () => number;
}

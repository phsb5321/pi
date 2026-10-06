/** ROOT2016 SOURCE path plumbing: real fixture bytes/filesystem, injected SDK/adapter, no SQLite runtime. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const evidence = new URL("../specs/1256-packed-source/evidence/sqlite-path-2016/", import.meta.url);
const candidatePath = new URL("./packed-isolation-306.ts", import.meta.url);
const read = (url: URL) => readFileSync(url, "utf8");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const baseline = read(new URL("before-packed-isolation-306.ts.txt", evidence));
const candidate = read(candidatePath);
assert.equal(sha(baseline), "bd67d8b079286855edaf0bb0b6637d9efb84e38682e0931fdcd82c98fdd6a619");
assert.equal(sha(read(new URL("../packages/coding-agent/src/experimental/durable/shared-host-acceptance-kit.ts", import.meta.url))), "e7d24d8e0b3790c88535d2dd2006e39c54567a64e4ad74473d7e058d8756f2d8");
assert.equal(sha(read(new URL("./packed-source-regression-1256.ts", import.meta.url))), "185bf0e63aa18cfdd9c6dd6146557d178ce33e2773b30cdffc3b934150dbfc74");

function between(source: string, start: string, end: string) {
	const from = source.indexOf(start);
	const to = source.indexOf(end, from + start.length);
	assert(from >= 0 && to > from, `missing actual fixture slice: ${start}`);
	return source.slice(from + start.length, to);
}

function pieces(source: string) {
	const openStart = source.indexOf("const sessionDirectories =") >= 0 ? "const sessionDirectories =" : "const openOffline =";
	const offset = source.indexOf(openStart);
	assert(offset >= 0);
	return {
		opener: source.slice(offset, source.indexOf("\n// Each session", offset)),
		initial: between(source, "\t\tconst id = metadata.id;", "\t\t// (b)"),
		close: between(source, "\t\t\t\tasync () => {\n", "\n\t\t\t\t},\n\t\t\t),\n\t\t\treleaseResidency"),
		park: between(source, "\t\t\treleaseResidency: async () => {\n", "\n\t\t\t},\n\t\t\tresumeResidency"),
		resume: between(source, "\t\t\tresumeResidency: async () => {\n", "\n\t\t\t},\n\t\t};"),
		consumer: "let storesOpened = 0;" + between(source, "\tlet storesOpened = 0;", "\n\t// (c)"),
	};
}

const before = pieces(baseline);
const after = pieces(candidate);
assert.equal(after.initial, before.initial, "actual initial caller retained");
assert.equal(after.close, before.close, "actual engine close retained");
assert.equal(after.park, before.park, "actual park release retained");
assert.equal(after.resume, before.resume, "actual resume caller retained");
assert.equal(between(candidate, "const faux =", "// Both opens reuse"), between(baseline, "const faux =", "// Both opens reuse"), "frozen offline factory unchanged");
assert.equal(between(candidate, "const checks =", "const PACKED ="), between(baseline, "const checks =", "const PACKED ="), "live counter untouched");
assert.equal(candidate.slice(candidate.lastIndexOf("} catch (error) {")), baseline.slice(baseline.lastIndexOf("} catch (error) {")), "catch/completeness13/finalizer untouched");
assert.equal(between(candidate, "\ntry {", "} catch (error) {").match(/\brunCheck\(/gu)?.length, 12);
const nativeRuntime = read(new URL("native-runtime-f667.ts.txt", evidence));
const nativeSessions = read(new URL("native-sessions-f667.ts.txt", evidence));
assert.match(nativeRuntime, /session: \{ id: location\.id, directory: location\.directory, cwd: location\.cwd \}/u);
assert.match(nativeSessions, /database: join\(directory, "session\.sqlite"\)/u);

function program(source: string, phase: string) {
	const subject = pieces(source);
	// Execute actual opener/callers/releases/consumer, never a copied path algorithm.
	// SDK returns and adapter are explicit SOURCE seams; files are not SQLite databases.
	return `import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const phase = ${JSON.stringify(phase)};
const root = mkdtempSync(join(tmpdir(), "sqlite-path-2016-"));
const cohort = Array.from({length:8}, (_, i) => "s" + (i+1));
const locations = new Map();
for (const [i,id] of cohort.entries()) {
 mkdirSync(join(root,id));
 // Opaque schema-shaped SDK metadata, not an implementation of selectSession.
 const dir = join(root,"agent","experimental","durable-sessions",String(i+1).padStart(24,"0"),"1791329600000-00000000-0000-0000-0000-00000000000"+i);
 mkdirSync(dir,{recursive:true}); writeFileSync(join(dir,"session.sqlite"),"SOURCE path witness, not SQLite\\n"); locations.set(id,dir);
}
const offlineModelRuntime = {};
const faux = {provider:{id:"source-faux"},getModel:()=>({id:"source-model"})};
const calls = [], handles = [], modelCalls = [], storeFiles = [], storeCloses = [];
const openDurable = async (options) => {
 const id = options.cwd.split("/").at(-1); calls.push({id,...options});
 const handle = {closed:false, view:{current:()=>({session:{directory:locations.get(id)}})},
 controller:{setModel:async(ref)=>{modelCalls.push(ref);}}, close:async()=>{handle.closed=true;}};
 handles.push(handle); return handle;
};
const openNodeSqliteStorage = async (file) => {
 assert(statSync(file).isFile()); storeFiles.push(file);
 return {close:async()=>{storeCloses.push(file);}};
};
const runCheck = (label, condition) => assert.equal(condition, true, label);
${subject.opener}
const opened = new Map();
const parkState = new Map();
async function initial(metadata) { const id = metadata.id; ${subject.initial} }
async function closeEngine(id) { ${subject.close} }
async function park(id) { ${subject.park} }
async function resume(id) { ${subject.resume} }
async function consumeStores() { ${subject.consumer} return storesOpened; }
for (const id of cohort) await initial({id});
for (const id of cohort) await park(id);
assert.equal(opened.size,0);
if (phase === "baseline") {
 try { await consumeStores(); } catch (error) {
  if (error.code !== "ERR_ASSERTION" || !error.message.includes("packed store persists")) throw error;
  process.stderr.write(String(error.stack)+"\\nSOURCE BASELINE RED3: actual cwd consumer cannot find the injected native-directory files\\n");
  process.exit(3);
 }
 throw new Error("baseline unexpectedly accepted unrelated cwd");
}
assert.equal(sessionDirectories.size,8);
assert.equal(await consumeStores(),8);
assert.deepEqual(storeFiles,cohort.map(id=>join(locations.get(id),"session.sqlite")));
assert.deepEqual(storeCloses,storeFiles);
assert(cohort.every(id=>readdirSync(join(root,id)).length===0));
for (const id of cohort) await resume(id);
assert.equal(opened.size,8);
assert(calls.slice(0,8).every(c=>c.continueSession===false && c.modelRuntime===offlineModelRuntime));
assert(calls.slice(8,16).every(c=>c.continueSession===true && c.modelRuntime===offlineModelRuntime));
assert(modelCalls.every(ref=>ref.provider===faux.provider.id && ref.modelId===faux.getModel().id));
const retained = sessionDirectories.get(cohort[0]);
await closeEngine(cohort[0]); assert.equal(opened.has(cohort[0]),false); assert.equal(sessionDirectories.get(cohort[0]),retained);
const changedDir = join(root,"agent","experimental","durable-sessions","resume-newest","returned-session");
mkdirSync(changedDir,{recursive:true}); writeFileSync(join(changedDir,"session.sqlite"),"SOURCE resumed path witness\\n");
locations.set(cohort[0],changedDir); await resume(cohort[0]); assert.equal(sessionDirectories.get(cohort[0]),changedDir);
storeFiles.length=0; storeCloses.length=0;
assert.equal(await consumeStores(),8);
assert.deepEqual(storeFiles,cohort.map(id=>join(locations.get(id),"session.sqlite")));
for (const id of cohort) await park(id);
assert.equal(opened.size,0); assert.equal(sessionDirectories.size,8);
assert(cohort.every(id=>parkState.get(id).released && parkState.get(id).resumes >= 1));
const last = cohort.at(-1), file = join(locations.get(last),"session.sqlite");
unlinkSync(file);
try { await consumeStores(); throw new Error("missing eighth file accepted"); }
catch (error) { assert.equal(error.code,"ENOENT"); process.stderr.write("SOURCE expected missing-eighth-store: "+error.message+"\\n"); }
writeFileSync(file,"SOURCE restored path witness\\n");
sessionDirectories.delete(last);
await assert.rejects(consumeStores,/missing retained native session directory/);
sessionDirectories.set(last,locations.get(last));
for (const missing of [undefined, ""]) {
 locations.set("missing",missing);
 await assert.rejects(openOffline("missing",false),/missing native session directory/);
 assert.equal(handles.at(-1).closed,true);
 assert.equal(sessionDirectories.has("missing"),false);
}
unlinkSync(file); mkdirSync(file);
await assert.rejects(consumeStores,/missing native SQLite store/);
process.stdout.write(JSON.stringify({phase,result:"GREEN",accepted:"actual opener/callers/close/park/resume/consumer SOURCE bytes + real filesystem, all8; injected SDK metadata and adapter only",initial_and_resume:true,park_and_engine_close_directory_retained:true,resume_directory_refreshed:true,missing_eighth_store_rejected:true,missing_native_metadata_rejected:true,non_file_store_rejected:true,actual_SQLite_open:false})+"\\n");`;
}

const runs = ["baseline", "candidate"].map((phase) => {
	const subject = phase === "baseline" ? baseline : candidate;
	const executable = stripTypeScriptTypes(program(subject, phase), { mode: "strip" });
	const argv = ["--input-type=module", "--eval", executable];
	const child = spawnSync(process.execPath, argv, { encoding: "utf8", timeout: 10000, maxBuffer: 128 * 1024, env: { ...process.env } });
	writeFileSync(new URL(`${phase}.stdout.txt`, evidence), child.stdout ?? "");
	writeFileSync(new URL(`${phase}.stderr.txt`, evidence), child.stderr ?? "");
	const row = { phase, exit: child.status, signal: child.signal, error: child.error?.message, program_sha256: sha(executable), source_sha256: sha(subject), stdout_sha256: sha(child.stdout ?? ""), stderr_sha256: sha(child.stderr ?? "") };
	writeFileSync(new URL(`${phase}.result.json`, evidence), JSON.stringify(row, null, 2) + "\n");
	assert(!child.error && child.signal === null, "import/refusal/timeout is not SOURCE RED/GREEN");
	assert.equal(child.status, phase === "baseline" ? 3 : 0, `${phase}: actual causal path exit required`);
	if (phase === "baseline") assert(child.stderr.includes("SOURCE BASELINE RED3"));
	else assert.equal(JSON.parse(child.stdout).result, "GREEN");
	return row;
});
const receipt = {
	result: "PASS_SOURCE_PATH_RED3_GREEN0", acceptance: "SOURCE filesystem path plumbing, actual fixture bytes; injected SDK/adapter, NOT native SQLite or full306 acceptance",
	node: process.version, check_sha256: sha(read(new URL(import.meta.url))), before_fixture_sha256: sha(baseline), candidate_fixture_sha256: sha(candidate),
	actual_slice_hashes: Object.fromEntries(Object.entries(after).map(([name,text]) => [name,sha(text)])),
	native_immutable_object: "f6674860a3b5e812b38211161ce6965546ba2f9a", native_runtime_sha256: sha(nativeRuntime), native_sessions_sha256: sha(nativeSessions),
	native_adapter_execution: "NOT_RUN: local packages/durable/src/storage/sqlite/node.ts absent ENOENT; no borrowed source/dist/hydration/dependencies", runs,
	thread_env: { UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE, OMP_NUM_THREADS: process.env.OMP_NUM_THREADS, NODE_OPTIONS: process.env.NODE_OPTIONS },
	preserved: "counter/catch/completeness13/frozen offline factory unchanged; no SDK/provider/model/compiler/network/full306/installed/RAM/N1 acceptance",
};
writeFileSync(new URL("source-check-2016.json", evidence), JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify(receipt, null, 2));

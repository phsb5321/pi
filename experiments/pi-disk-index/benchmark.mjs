// Deterministic synthetic memory comparison; no Pi, providers, or private sessions.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const workers = 32;
const messages = 350;
const payload = 'context '.repeat(500); // about 4 KiB per message
const dir = mkdtempSync(join(tmpdir(), 'pi-disk-bench-'));
try {
  for (let s=0; s<workers; s++) {
    const entries = [{type:'session',id:`s${s}`,cwd:`/tmp/workspace${s}`,version:3}];
    for (let m=0; m<messages; m++) entries.push({type:'message',id:`s${s}-${m}`,parentId:m?`s${s}-${m-1}`:null,
      message:{role:m%2?'assistant':'user',content:payload+` seat=${s}, message=${m}`}});
    writeFileSync(join(dir,`s${s}.jsonl`), entries.map(x => JSON.stringify(x)).join('\n')+'\n');
  }
  const rows=[];
  for (const mode of ['disk','baseline']) {
    const p=spawnSync(process.execPath,['--expose-gc',new URL('./benchmark-worker.mjs', import.meta.url).pathname,mode,dir],
      {encoding:'utf8',timeout:120000,maxBuffer:10*1024*1024});
    if(p.status!==0) throw new Error(`${mode}: ${p.stderr || p.stdout}`);
    rows.push(JSON.parse(p.stdout.trim()));
  }
  const [disk,baseline]=rows;
  console.log(JSON.stringify({kind:'synthetic-32-seat-history-retention-only',seats:workers,messagesPerSeat:messages,
    notes:['A single shared Node process is used in each arm; not 32 independent Pi runtimes.',
       'The disk arm opens/closes SQLite indexes and hydrates only one message per seat; it does not test a Pi UI or model run.',
       'Does not prove live fleet savings or resume fidelity.'],
    disk,baseline,pssReductionPct:+(100*(1-disk.pssKiB/baseline.pssKiB)).toFixed(1),
    heapReductionPct:+(100*(1-disk.heapUsedBytes/baseline.heapUsedBytes)).toFixed(1)},null,2));
} finally {rmSync(dir,{recursive:true,force:true});}

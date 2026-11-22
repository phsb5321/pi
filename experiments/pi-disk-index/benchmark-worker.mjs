// One synthetic retention arm for the disk-backed Pi index experiment.
import { readdirSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DiskSessionIndex } from './disk-session-index.mjs';

const mode=process.argv[2];
const dir=process.argv[3];
const files=readdirSync(dir).filter(f=>f.endsWith('.jsonl')).sort().map(f=>join(dir,f));
const hold=[];
let observed=0;
if(mode==='baseline') {
  for (const f of files) {
    const entries=readFileSync(f,'utf8').split('\n').filter(Boolean).map(x=>JSON.parse(x));
    const byId=new Map(entries.map(x=>[x.id,x]));
    const stateMessages=entries.filter(x=>x.type==='message').map(x=>({...x.message}));
    hold.push({entries,byId,stateMessages});
    observed+=stateMessages.length;
  }
} else if (mode==='disk') {
  for (let s=0;s<files.length;s++) {
    const idx=new DiskSessionIndex(files[s]);
    const id=files[s].split('/').at(-1).replace('.jsonl','');
    const last=idx.get(`${id}-349`);
    if(!last) throw new Error('missing indexed entry');
    observed+=idx.count()-1;
    idx.close();
  }
} else throw new Error(`unknown mode ${mode}`);
if(globalThis.gc) globalThis.gc();
const usage=process.memoryUsage();
const pss=readFileSync('/proc/self/smaps_rollup','utf8').match(/^Pss:\s+(\d+) kB/m);
const result={mode,recordsObserved:observed,pssKiB:pss?Number(pss[1]):null,rssBytes:usage.rss,heapUsedBytes:usage.heapUsed};
// hold retains the baseline structures until after memory collection.
if (hold.length!==0 && hold.length!==files.length) throw new Error('baseline arrays missing');
process.stdout.write(JSON.stringify(result)+'\n');

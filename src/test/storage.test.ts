import {strict as assert} from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {Storage} from '../storage';
describe('storage',()=>{
 it('initializes, serializes writes and persists atomically',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codepulse-'));const s=new Storage(dir);await s.initialize();
  await Promise.all([s.addInterval({id:'1',start:1,end:1001,project:'A',language:'ts',hour:1,date:'2025-01-01'}),s.addInterval({id:'2',start:1001,end:2001,project:'B',language:'js',hour:1,date:'2025-01-01'})]);
  await s.flush();const raw=JSON.parse(await fs.readFile(path.join(dir,'codepulse-data.json'),'utf8'));assert.equal(raw.sessions.length,2);
  await fs.rm(dir,{recursive:true,force:true});
 });
});

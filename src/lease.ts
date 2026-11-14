import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Lease } from './types';
const LEASE_MS=15000;
export class LeaseCoordinator {
  private readonly file:string;
  private readonly lock:string;
  constructor(directory:string,private readonly owner:string) {
    this.file=path.join(directory,'heartbeat.json'); this.lock=this.file+'.lock';
  }
  async renew(now=Date.now()):Promise<boolean> {
    await fs.mkdir(path.dirname(this.file),{recursive:true});
    try { await fs.mkdir(this.lock); }
    catch {
      try {
        const st=await fs.stat(this.lock);
        if(now-st.mtimeMs>5000){await fs.rm(this.lock,{recursive:true,force:true});await fs.mkdir(this.lock);}
        else return false;
      } catch { return false; }
    }
    try {
      let current:Lease|undefined;
      try { current=JSON.parse(await fs.readFile(this.file,'utf8')) as Lease; } catch { /* recover absent/corrupt lease */ }
      if(current && current.owner!==this.owner && current.expiresAt>now) return false;
      const lease:Lease={owner:this.owner,heartbeat:now,expiresAt:now+LEASE_MS};
      const tmp=this.file+'.tmp-'+this.owner;
      await fs.writeFile(tmp,JSON.stringify(lease),{mode:0o600});
      await fs.rename(tmp,this.file);
      return true;
    } finally { await fs.rm(this.lock,{recursive:true,force:true}); }
  }
  async release():Promise<void> {
    try {
      const lease=JSON.parse(await fs.readFile(this.file,'utf8')) as Lease;
      if(lease.owner===this.owner) await fs.writeFile(this.file,JSON.stringify({...lease,expiresAt:0}));
    } catch { /* nothing to release */ }
  }
}

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Database, SCHEMA_VERSION } from './types';

export class Storage {
  private queue: Promise<unknown> = Promise.resolve();
  private db: Database = {schemaVersion:SCHEMA_VERSION,sessions:[],updatedAt:Date.now()};
  private loaded = false;
  private readonly file: string;
  private readonly backup: string;
  constructor(directory: string) {
    this.file = path.join(directory,'codepulse-data.json');
    this.backup = path.join(directory,'codepulse-data.bak.json');
  }
  private valid(value: unknown): value is Database {
    if (!value || typeof value !== 'object') return false;
    const v = value as Database;
    return Number.isInteger(v.schemaVersion) && Array.isArray(v.sessions) &&
      v.sessions.every(s => s && typeof s.id==='string' && Number.isFinite(s.start) &&
      Number.isFinite(s.end) && Number.isFinite(s.durationMs) && typeof s.date==='string');
  }
  async initialize(): Promise<void> {
    if (this.loaded) return;
    await fs.mkdir(path.dirname(this.file),{recursive:true});
    try {
      const raw = JSON.parse(await fs.readFile(this.file,'utf8')) as unknown;
      if (this.valid(raw)) {
        if (raw.schemaVersion > SCHEMA_VERSION) throw new Error('Database was created by a newer CodePulse version.');
        this.db = {...raw,schemaVersion:SCHEMA_VERSION};
      } else throw new Error('Invalid CodePulse database structure.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        try {
          const backup = JSON.parse(await fs.readFile(this.backup,'utf8')) as unknown;
          if (this.valid(backup)) this.db = {...backup,schemaVersion:SCHEMA_VERSION};
        } catch { /* retain a clean in-memory database; damaged files remain untouched */ }
      }
    }
    this.loaded = true;
  }
  snapshot(): Database { return structuredClone(this.db); }
  async addInterval(session: {id:string;start:number;end:number;project:string;language:string;hour:number;date:string}): Promise<void> {
    await this.enqueue(async () => {
      const durationMs = Math.max(0,session.end-session.start);
      if (!durationMs) return;
      const last = this.db.sessions[this.db.sessions.length-1];
      if (last && last.id===session.id && last.date===session.date && last.end===session.start &&
          last.project===session.project && last.language===session.language) {
        last.end=session.end; last.durationMs+=durationMs;
      } else {
        this.db.sessions.push({...session,durationMs});
      }
      this.db.updatedAt=Date.now();
    });
  }
  async reset(): Promise<void> {
    await this.enqueue(async()=>{this.db={schemaVersion:SCHEMA_VERSION,sessions:[],updatedAt:Date.now()};});
    await this.flush();
  }
  async flush(): Promise<void> {
    await this.enqueue(async()=>{
      const tmp=this.file+'.tmp';
      const data=JSON.stringify(this.db,null,2);
      await fs.writeFile(tmp,data,{encoding:'utf8',mode:0o600});
      try { await fs.copyFile(this.file,this.backup); } catch (e) {
        if ((e as NodeJS.ErrnoException).code!=='ENOENT') throw e;
      }
      await fs.rename(tmp,this.file);
    });
  }
  private enqueue<T>(fn:()=>Promise<T>):Promise<T> {
    const next=this.queue.then(fn,fn);
    this.queue=next.then(()=>undefined,()=>undefined);
    return next;
  }
}

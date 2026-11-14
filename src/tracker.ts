import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { Storage } from './storage';
import { LeaseCoordinator } from './lease';
import { splitAtLocalMidnight, localHour } from './utils/time';
import { BreakReminders } from './reminders';
import { TrackingMode } from './types';

export interface TrackerOptions {mode:TrackingMode;graceSeconds:number}
export class Tracker implements vscode.Disposable {
  private timer:NodeJS.Timeout|undefined; private last=Date.now(); private focused=true;
  private lostAt:number|undefined; private paused=false; private sessionId=randomUUID();
  private context:{project:string;language:string}={project:'No workspace',language:'Unknown'};
  constructor(private readonly storage:Storage,private readonly lease:LeaseCoordinator,private readonly reminders:BreakReminders,private options:TrackerOptions){}
  start():void {this.stopTimer();this.last=Date.now();this.timer=setInterval(()=>void this.tick(),1000);}
  configure(options:TrackerOptions):void {this.options=options;this.last=Date.now();this.start();}
  setFocused(value:boolean):void {this.focused=value;if(value)this.lostAt=undefined;else this.lostAt=Date.now();}
  setPaused(value:boolean):void {this.paused=value;this.last=Date.now();}
  updateContext():void {
    const folders=vscode.workspace.workspaceFolders;
    const project=folders?.map(f=>f.name).join(', ')||'No workspace';
    const language=vscode.window.activeTextEditor?.document.languageId||'Unknown';
    if(project!==this.context.project||language!==this.context.language){
      this.context={project,language};this.sessionId=randomUUID();
    }
  }
  private shouldTrack(now:number):boolean {
    if(this.paused)return false;
    if(this.options.mode==='alwaysOpen')return true;
    if(this.focused)return true;
    return this.lostAt!==undefined && now-this.lostAt<=this.options.graceSeconds*1000;
  }
  private async tick():Promise<void>{
    const now=Date.now(),start=this.last;this.last=now;
    const delta=now-start;
    if(delta<=0||delta>300000||!this.shouldTrack(now))return;
    this.updateContext();
    if(!await this.lease.renew(now))return;
    const slices=splitAtLocalMidnight(start,now);
    for(const slice of slices){
      await this.storage.addInterval({id:this.sessionId,start:slice.start,end:slice.end,project:this.context.project,language:this.context.language,hour:localHour(slice.start),date:slice.date});
    }
    this.reminders.addTrackedTime(delta);
  }
  async flush():Promise<void>{await this.tick();await this.storage.flush();}
  private stopTimer():void{if(this.timer)clearInterval(this.timer);this.timer=undefined;}
  dispose():void{this.stopTimer();void this.lease.release();void this.storage.flush();this.reminders.dispose();}
}

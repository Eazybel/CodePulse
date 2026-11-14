import * as vscode from 'vscode';
export class BreakReminders {
  private timer:NodeJS.Timeout|undefined;
  private elapsed=0;
  constructor(private minutes:number,private readonly onReminder:()=>void){}
  configure(minutes:number):void {this.minutes=Math.max(0,minutes);this.elapsed=0;this.restart();}
  addTrackedTime(ms:number):void {
    if(this.minutes<=0)return;
    this.elapsed+=ms;
    const threshold=this.minutes*60000;
    if(this.elapsed>=threshold){this.elapsed%=threshold;this.onReminder();}
  }
  private restart():void {if(this.timer)clearInterval(this.timer);this.timer=undefined;}
  dispose():void {this.restart();}
}

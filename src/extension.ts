import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { Storage } from './storage';
import { LeaseCoordinator } from './lease';
import { Tracker } from './tracker';
import { Dashboard } from './dashboard';
import { BreakReminders } from './reminders';
import { formatDuration } from './utils/format';

export async function activate(context:vscode.ExtensionContext):Promise<void>{
  const storage=new Storage(context.globalStorageUri.fsPath);await storage.initialize();
  const cfg=()=>vscode.workspace.getConfiguration('codepulse');
  const goal=()=>Math.max(1,cfg().get<number>('dailyGoalMinutes',240));
  const reminders=new BreakReminders(cfg().get<number>('breakReminderMinutes',90),()=>void vscode.window.showInformationMessage('CodePulse: You have been active for a while. Consider taking a short break.'));
  const lease=new LeaseCoordinator(context.globalStorageUri.fsPath,randomUUID());
  const tracker=new Tracker(storage,lease,reminders,{mode:cfg().get<'alwaysOpen'|'windowFocused'>('trackingMode','alwaysOpen'),graceSeconds:cfg().get<number>('focusGracePeriodSeconds',30)});
  const dashboard=new Dashboard(context.extensionUri,storage,goal);
  const status=vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left,90);
  status.command='codepulse.openDashboard';status.tooltip='CodePulse Tracker · Open analytics';status.show();
  const updateStatus=()=>{const s=storage.snapshot().sessions.filter(x=>x.date===new Date().toLocaleDateString('en-CA')).reduce((a,x)=>a+x.durationMs,0);status.text='$(clock) '+formatDuration(s);status.tooltip='Today: '+formatDuration(s)+' · Daily goal: '+goal()+'m';dashboard.refresh();};
  const tick=setInterval(updateStatus,10000);
  tracker.start();updateStatus();
  context.subscriptions.push(status,{dispose:()=>clearInterval(tick)},tracker,{dispose:()=>void storage.flush()});
  context.subscriptions.push(vscode.window.onDidChangeWindowState(s=>tracker.setFocused(s.focused)));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(()=>tracker.updateContext()));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(()=>tracker.updateContext()));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e=>{
    if(e.affectsConfiguration('codepulse')){
      tracker.configure({mode:cfg().get<'alwaysOpen'|'windowFocused'>('trackingMode','alwaysOpen'),graceSeconds:cfg().get<number>('focusGracePeriodSeconds',30)});
      reminders.configure(cfg().get<number>('breakReminderMinutes',90));updateStatus();
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('codepulse.openDashboard',()=>dashboard.open()));
  context.subscriptions.push(vscode.commands.registerCommand('codepulse.pauseTracking',()=>{tracker.setPaused(true);void vscode.window.showInformationMessage('CodePulse tracking paused.');}));
  context.subscriptions.push(vscode.commands.registerCommand('codepulse.resumeTracking',()=>{tracker.setPaused(false);void vscode.window.showInformationMessage('CodePulse tracking resumed.');}));
  context.subscriptions.push(vscode.commands.registerCommand('codepulse.exportData',async()=>{
    const uri=await vscode.window.showSaveDialog({defaultUri:vscode.Uri.file('codepulse-export.json'),filters:{'JSON':['json'],'CSV':['csv']}});
    if(!uri)return;
    try{const data=storage.snapshot();const content=uri.fsPath.endsWith('.csv')?'id,start,end,durationMs,project,language,hour,date\n'+data.sessions.map(s=>[s.id,s.start,s.end,s.durationMs,s.project,s.language,s.hour,s.date].map(v=>{const t=String(v);return /[",\r\n]/.test(t)?'"'+t.replace(/"/g,'""')+'"':t;}).join(',')).join('\n'):JSON.stringify({exportedAt:new Date().toISOString(),schemaVersion:data.schemaVersion,...data},null,2);await vscode.workspace.fs.writeFile(uri,Buffer.from(content,'utf8'));void vscode.window.showInformationMessage('CodePulse data exported.');}catch(e){void vscode.window.showErrorMessage('CodePulse export failed: '+String(e));}
  }));
  context.subscriptions.push(vscode.commands.registerCommand('codepulse.resetStatistics',async()=>{
    const answer=await vscode.window.showWarningMessage('Permanently reset all CodePulse activity statistics? This cannot be undone.','Reset statistics');
    if(answer==='Reset statistics'){await storage.reset();updateStatus();dashboard.refresh();void vscode.window.showInformationMessage('CodePulse statistics reset.');}
  }));
  context.subscriptions.push({dispose:()=>{void tracker.flush();void storage.flush();}});
}
export function deactivate():void{}

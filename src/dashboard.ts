import * as vscode from 'vscode';
import { Storage } from './storage';
import { summarize } from './analytics';
import { formatDuration } from './utils/format';
import { randomBytes } from 'node:crypto';

export class Dashboard {
  private panel:vscode.WebviewPanel|undefined;
  constructor(private readonly extensionUri:vscode.Uri,private readonly storage:Storage,private readonly goal:()=>number){}
  open():void {
    if(this.panel){this.panel.reveal();void this.send();return;}
    this.panel=vscode.window.createWebviewPanel('codepulse.dashboard','CodePulse Tracker',vscode.ViewColumn.One,{enableScripts:true,retainContextWhenHidden:true,localResourceRoots:[vscode.Uri.joinPath(this.extensionUri,'media')]});
    this.panel.webview.html=this.html(this.panel.webview);
    this.panel.onDidDispose(()=>{this.panel=undefined;});
    this.panel.webview.onDidReceiveMessage(async msg=>{
      if(!msg||typeof msg!=='object'||msg.type!=='ready')return;
      await this.send();
    });
  }
  refresh():void{if(this.panel?.visible)void this.send();}
  private async send():Promise<void>{
    if(!this.panel)return;
    const data=this.storage.snapshot(),summary=summarize(data.sessions,Date.now(),this.goal());
    await this.panel.webview.postMessage({type:'data',summary,sessions:data.sessions.slice(-100).reverse(),today:formatDuration(summary.daily[29]?.ms||0)});
  }
  private html(webview:vscode.Webview):string{
    const nonce=randomBytes(18).toString('base64');
    const csp=`default-src 'none'; img-src ${webview.cspSource} data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>CodePulse</title>
<style nonce="${nonce}">
:root{color-scheme:light dark}body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:24px;max-width:1200px;margin:auto}
header{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}h1{font-size:24px;margin:0}.muted{color:var(--vscode-descriptionForeground)}.tabs{display:flex;gap:8px;margin:24px 0}.tabs button,button{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:1px solid var(--vscode-panel-border);border-radius:8px;padding:9px 14px;cursor:pointer}.tabs button[aria-selected=true]{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(175px,1fr));gap:12px}.card{border:1px solid var(--vscode-panel-border);border-radius:12px;padding:16px;background:var(--vscode-sideBar-background)}.metric{font-size:25px;font-weight:650;margin-top:8px}.section{margin-top:24px}.bars{display:flex;align-items:end;gap:5px;height:150px;padding:10px 0}.bar{flex:1;min-width:4px;background:var(--vscode-charts-blue);border-radius:4px 4px 0 0;position:relative}.bar:hover{background:var(--vscode-charts-green)}.list{display:grid;gap:10px}.item{display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid var(--vscode-panel-border);padding:8px 0}.heat{display:grid;grid-template-columns:repeat(13,minmax(9px,1fr));gap:4px}.cell{aspect-ratio:1;border-radius:3px;background:var(--vscode-input-background);border:1px solid var(--vscode-panel-border)}.cell[data-level="1"]{background:#155e75}.cell[data-level="2"]{background:#0e7490}.cell[data-level="3"]{background:#0891b2}.cell[data-level="4"]{background:#22d3ee}.timeline{display:grid;grid-template-columns:repeat(24,1fr);gap:3px}.hour{height:46px;border-radius:4px;background:var(--vscode-input-background);border:1px solid var(--vscode-panel-border)}.empty{padding:32px;text-align:center;border:1px dashed var(--vscode-panel-border);border-radius:12px}.progress{height:8px;background:var(--vscode-input-background);border-radius:8px;overflow:hidden;margin-top:10px}.progress span{display:block;height:100%;background:var(--vscode-charts-blue)}@media(max-width:600px){body{padding:14px}.heat{grid-template-columns:repeat(10,minmax(8px,1fr))}}
</style></head><body><header><div><h1>CodePulse Tracker</h1><p class="muted">Your activity, measured locally.</p></div><span id="updated" class="muted">Waiting for activity…</span></header>
<nav class="tabs" aria-label="Analytics period"><button data-tab="daily" aria-selected="true">Daily</button><button data-tab="weekly" aria-selected="false">Weekly</button><button data-tab="monthly" aria-selected="false">Monthly</button></nav>
<section class="grid" id="metrics"><div class="card">Tracked today<div class="metric" id="today">—</div></div><div class="card">Daily goal<div class="metric" id="goal">—</div><div class="progress"><span id="goalbar" style="width:0%"></span></div></div><div class="card">Current streak<div class="metric" id="streak">—</div></div><div class="card">All-time tracked<div class="metric" id="total">—</div></div><div class="card">Sessions<div class="metric" id="sessions">—</div></div><div class="card">Daily average<div class="metric" id="average">—</div></div></section>
<section class="section card"><h2 id="chartTitle">Last 7 days</h2><div class="bars" id="chart" role="img" aria-label="Activity chart"></div><div class="muted" id="chartNote"></div></section>
<section class="section grid"><div class="card"><h2>Contribution activity</h2><div class="heat" id="heat"></div><p class="muted">Each square represents a local calendar day.</p></div><div class="card"><h2>Hourly activity</h2><div class="timeline" id="hours"></div><p class="muted" id="bestHour"></p></div></section>
<section class="section grid"><div class="card"><h2>Projects</h2><div class="list" id="projects"></div></div><div class="card"><h2>Languages</h2><div class="list" id="languages"></div></div></section>
<section class="section card"><h2>Recent sessions</h2><div class="list" id="recent"></div></section>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();let state=null,tab='daily';
const $=id=>document.getElementById(id);
const fmt=ms=>{let m=Math.floor(Math.max(0,ms)/60000),h=Math.floor(m/60);return h?(h+'h '+(m%60)+'m'):(m+'m')};
const safe=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function rows(id,items){$(id).innerHTML=items.length?items.slice(0,8).map(x=>'<div class="item"><span>'+safe(x.name)+'</span><strong>'+fmt(x.ms)+'</strong></div>').join(''):'<p class="muted">No activity recorded yet.</p>'}
function render(){
 if(!state)return;const s=state.summary,goal=Math.max(1,Number(s.goalPercent)||0);
 $('today').textContent=state.today;$('goal').textContent=s.goalPercent+'%';$('goalbar').style.width=Math.min(100,s.goalPercent)+'%';$('streak').textContent=s.streak+' days';$('total').textContent=fmt(s.total);$('sessions').textContent=s.sessions;$('average').textContent=fmt(s.average);
 const days=tab==='daily'?s.daily.slice(-7):tab==='weekly'?s.daily.slice(-7):s.daily;
 $('chartTitle').textContent=tab==='daily'?'Last 7 days':tab==='weekly'?'This week':'Last 30 days';
 const max=Math.max(1,...days.map(d=>d.ms));$('chart').innerHTML=days.map(d=>'<div class="bar" title="'+safe(d.date)+': '+fmt(d.ms)+'" style="height:'+Math.max(2,d.ms/max*100)+'%"></div>').join('');
 $('chartNote').textContent='Most productive hour: '+s.bestHour+':00 · Longest session: '+fmt(s.longest);
 $('heat').innerHTML=s.daily.map(d=>'<div class="cell" data-level="'+(d.ms===0?0:d.ms<1800000?1:d.ms<7200000?2:d.ms<14400000?3:4)+'" title="'+safe(d.date)+': '+fmt(d.ms)+'" aria-label="'+safe(d.date)+': '+fmt(d.ms)+'"></div>').join('');
 $('hours').innerHTML=s.hours.map((v,i)=>'<div class="hour" title="'+i+':00 · '+fmt(v)+'" style="opacity:'+(v?0.35+0.65*v/Math.max(1,...s.hours):0.12)+'"></div>').join('');
 $('bestHour').textContent='Peak coding hour: '+s.bestHour+':00';rows('projects',s.projects);rows('languages',s.languages);
 $('recent').innerHTML=state.sessions.length?state.sessions.map(x=>'<div class="item"><span>'+safe(x.project)+' · '+safe(x.language)+'<small class="muted"> '+safe(x.date)+'</small></span><strong>'+fmt(x.durationMs)+'</strong></div>').join(''):'<div class="empty">No activity yet. Start working in VS Code and CodePulse will record your sessions.</div>';
 $('updated').textContent='Updated just now';
}
document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>{tab=b.dataset.tab;document.querySelectorAll('[data-tab]').forEach(x=>x.setAttribute('aria-selected',String(x===b)));render()}));
window.addEventListener('message',e=>{if(e.data?.type==='data'){state=e.data;render()}});
vscode.postMessage({type:'ready'});
</script></body></html>`;
  }
}

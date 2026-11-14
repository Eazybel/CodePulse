import { ActivitySession } from './types';
import { localDate } from './utils/time';
export interface Summary {total:number;days:number;average:number;streak:number;goalPercent:number;projects:Array<{name:string;ms:number}>;languages:Array<{name:string;ms:number}>;hours:number[];daily:Array<{date:string;ms:number}>;sessions:number;longest:number;bestHour:number}
export function summarize(sessions:ActivitySession[],now=Date.now(),goalMinutes=240):Summary {
  const today=localDate(now), byDay=new Map<string,number>(), projects=new Map<string,number>(), langs=new Map<string,number>(), hours=Array(24).fill(0) as number[];
  let total=0,longest=0;
  for(const s of sessions){const ms=Math.max(0,s.durationMs);total+=ms;byDay.set(s.date,(byDay.get(s.date)||0)+ms);projects.set(s.project,(projects.get(s.project)||0)+ms);langs.set(s.language,(langs.get(s.language)||0)+ms);hours[s.hour]=(hours[s.hour]||0)+ms;longest=Math.max(longest,ms);}
  const daily=Array.from({length:30},(_,i)=>{const d=new Date(now);d.setHours(0,0,0,0);d.setDate(d.getDate()-(29-i));const date=localDate(d.getTime());return {date,ms:byDay.get(date)||0};});
  let streak=0; const cursor=new Date(now);cursor.setHours(0,0,0,0);
  if((byDay.get(today)||0)===0) cursor.setDate(cursor.getDate()-1);
  while((byDay.get(localDate(cursor.getTime()))||0)>0 && streak<366){streak++;cursor.setDate(cursor.getDate()-1);}
  const productiveDays=[...byDay.values()].filter(v=>v>0);
  const bestHour=hours.indexOf(Math.max(0,...hours));
  const projectsOut=[...projects].map(([name,ms])=>({name,ms})).sort((a,b)=>b.ms-a.ms);
  const languagesOut=[...langs].map(([name,ms])=>({name,ms})).sort((a,b)=>b.ms-a.ms);
  const todayMs=byDay.get(today)||0;
  return {total,days:productiveDays.length,average:productiveDays.length?productiveDays.reduce((a,b)=>a+b,0)/productiveDays.length:0,streak,goalPercent:Math.min(100,Math.round(todayMs/(goalMinutes*60000)*100)),projects:projectsOut,languages:languagesOut,hours,daily,sessions:sessions.length,longest,bestHour};
}

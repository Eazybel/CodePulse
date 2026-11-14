import {strict as assert} from 'node:assert';
import {summarize} from '../analytics';
import {ActivitySession} from '../types';
describe('analytics',()=>{
 const now=new Date(2025,4,15,12).getTime();
 const sample:ActivitySession[]=[{id:'a',start:now-3600000,end:now,durationMs:3600000,project:'App',language:'typescript',hour:11,date:'2025-05-15'}];
 it('calculates totals and project breakdown',()=>{const s=summarize(sample,now,60);assert.equal(s.total,3600000);assert.equal(s.projects[0].name,'App');assert.equal(s.goalPercent,100);});
 it('handles empty data',()=>{const s=summarize([],now);assert.equal(s.total,0);assert.equal(s.streak,0);assert.equal(s.sessions,0);});
});

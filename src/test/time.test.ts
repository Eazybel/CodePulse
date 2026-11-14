import {strict as assert} from 'node:assert';
import {splitAtLocalMidnight,safeElapsed} from '../utils/time';
describe('time utilities',()=>{
 it('splits at local midnight',()=>{const start=new Date(2025,0,1,23,59).getTime(),end=new Date(2025,0,2,0,1).getTime();const a=splitAtLocalMidnight(start,end);assert.equal(a.length,2);assert.equal(a[0].date,'2025-01-01');assert.equal(a[1].date,'2025-01-02');});
 it('rejects negative or invalid elapsed time',()=>{assert.equal(safeElapsed(5,4),0);assert.equal(safeElapsed(NaN,10),0);});
 it('preserves normal elapsed time',()=>assert.equal(safeElapsed(100,1100),1000));
});

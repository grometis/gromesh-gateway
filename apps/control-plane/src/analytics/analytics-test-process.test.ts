import {expect,it} from 'vitest';
import {createAnalyticsTestProcess} from '../../test/integration/analytics-test-process.js';
it('loads real Control Plane modules in an owned Node process and stops only that process',async()=>{
 const worker=await createAnalyticsTestProcess();try{expect(worker.pid).not.toBe(process.pid);expect(worker.pid).toBeGreaterThan(0);expect(await worker.call('pid')).toBe(worker.pid);}finally{await worker.close();}expect(worker.exited()).toBe(true);
});

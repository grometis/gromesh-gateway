import {EventEmitter} from 'node:events';
import type {Request,Response} from 'express';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {analyticsHttpContext,observeAnalyticsHttp,type AnalyticsHttpObservation} from './analytics-http-observation.js';
beforeEach(()=>vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']}));
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
function fixture(deadlineMs=8000,path='/api/v2/workspaces/example/requests'){
 const request=Object.assign(new EventEmitter(),{path}) as unknown as Request;
 const response=Object.assign(new EventEmitter(),{statusCode:200}) as unknown as Response;
 const observed:AnalyticsHttpObservation[]=[];const next=vi.fn();
 observeAnalyticsHttp({deadlineMs,onObserved:value=>observed.push(value)})(request,response,next);
 return{request,response,observed,next};
}
it('observes guards, parsing and response completion separately from operation time',()=>{
 const f=fixture();vi.advanceTimersByTime(30);const done=analyticsHttpContext(f.request)!.beginOperation();vi.advanceTimersByTime(20);done();vi.advanceTimersByTime(10);f.response.emit('finish');
 expect(f.next).toHaveBeenCalledOnce();expect(f.observed).toEqual([{elapsedMs:60,deadlineMs:8000,deadlineExceeded:false,completion:'finished',status:200,operationMs:20}]);expect(analyticsHttpContext(f.request)).toBeUndefined();expect(vi.getTimerCount()).toBe(0);
});
it.each([401,404,422])('records early HTTP%d without fabricating an operation budget',status=>{
 const f=fixture();f.response.statusCode=status;vi.advanceTimersByTime(25);f.response.emit('finish');expect(f.observed[0]).toMatchObject({status,operationMs:null,elapsedMs:25});
});
it('signals expiry before an operation and refuses late entry without claiming prior SQL cancellation',()=>{
 const f=fixture(50),context=analyticsHttpContext(f.request)!;vi.advanceTimersByTime(50);expect(context.signal.aborted).toBe(true);expect(()=>context.check()).toThrow();expect(()=>context.beginOperation()).toThrow();f.response.statusCode=502;f.response.emit('finish');expect(f.observed[0]).toMatchObject({deadlineExceeded:true,operationMs:null});
});
it('checks monotonic time even when a blocked event loop has not fired the timer',()=>{
 const f=fixture(50);vi.spyOn(performance,'now').mockReturnValue(51);expect(()=>analyticsHttpContext(f.request)!.check()).toThrow();f.response.emit('finish');expect(f.observed[0]!.deadlineExceeded).toBe(true);
});
it('reports late framework completion as exceeded instead of inventing an HTTP hard deadline',()=>{
 const f=fixture(50);analyticsHttpContext(f.request)!.beginOperation()();vi.advanceTimersByTime(60);f.response.emit('finish');expect(f.observed[0]).toMatchObject({status:200,completion:'finished',deadlineExceeded:true,operationMs:0});
});
it('propagates a disconnected client and cleans up listeners exactly once',()=>{
 const f=fixture(),context=analyticsHttpContext(f.request)!;context.beginOperation();f.request.emit('aborted');expect(context.signal.aborted).toBe(true);f.response.emit('close');f.response.emit('finish');expect(f.observed).toHaveLength(1);expect(f.observed[0]).toMatchObject({completion:'closed'});expect(f.response.listenerCount('close')).toBe(0);expect(f.request.listenerCount('aborted')).toBe(0);expect(vi.getTimerCount()).toBe(0);
});
it('retains the aborted weak context for a guard that resumes after the client disconnected',()=>{
 const f=fixture(),context=analyticsHttpContext(f.request)!;f.response.emit('close');expect(analyticsHttpContext(f.request)).toBe(context);expect(()=>analyticsHttpContext(f.request)!.beginOperation()).toThrow();expect(vi.getTimerCount()).toBe(0);
});
it('does not instrument unrelated routes or accept an unbounded deadline',()=>{
 const f=fixture(8000,'/api/v1/sessions');expect(f.next).toHaveBeenCalledOnce();expect(analyticsHttpContext(f.request)).toBeUndefined();expect(vi.getTimerCount()).toBe(0);for(const deadlineMs of [0,-1,8001,Infinity])expect(()=>observeAnalyticsHttp({deadlineMs})).toThrow();
});
it('matches mixed-case routes accepted by the Express router',()=>{
 const f=fixture(50,'/API/v2/WoRkSpAcEs/example/REQUESTS/');expect(analyticsHttpContext(f.request)).toBeDefined();vi.advanceTimersByTime(50);expect(()=>analyticsHttpContext(f.request)!.check()).toThrow();f.response.emit('finish');expect(f.observed[0]!.deadlineExceeded).toBe(true);
});
it('isolates concurrent requests and records response failure without leaking timers',()=>{
 const a=fixture(50),b=fixture(100);vi.advanceTimersByTime(50);expect(analyticsHttpContext(a.request)!.signal.aborted).toBe(true);expect(analyticsHttpContext(b.request)!.signal.aborted).toBe(false);a.response.emit('error',Error('synthetic'));b.response.emit('finish');expect(a.observed[0]!.completion).toBe('error');expect(b.observed[0]!.deadlineExceeded).toBe(false);expect(vi.getTimerCount()).toBe(0);
});

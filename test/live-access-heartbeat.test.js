import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createLiveAccessHeartbeat} from '../electron/live-access-heartbeat.js';
test('host access renews without microphone or viewers and stops applying late results after host end',async()=>{
 let clock=0;let current={status:'live',version:1};let calls=0;let release=(_value)=>{};const pending=new Promise(r=>{release=r;});let signal = new AbortController().signal;
 const heartbeat=createLiveAccessHeartbeat({getSession:()=>current,now:()=>clock,request:async(_session,input)=>{calls++;signal=input;return calls===1?{ok:true,data:{version:2,expiresAt:'2030-01-01T00:00:00Z'}}:pending;}});
 await heartbeat.tick();assert.equal(current.version,2);await heartbeat.tick();assert.equal(calls,1);
 clock=300000;const operation=heartbeat.tick();current=null;await heartbeat.tick();assert.equal(signal.aborted,true);
 release({ok:true,data:{version:3,expiresAt:'2030-01-02T00:00:00Z'}});await operation;assert.equal(current,null);heartbeat.close();
});

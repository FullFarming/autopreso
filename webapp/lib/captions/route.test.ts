import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { AuthenticationError } from "../auth/live-auth";
import { assertStrictOrigin, CsrfError } from "../security/csrf";
import * as bounded from "../security/bounded-json-body";
import { CaptionBrokerError } from "./broker";

function load({authenticated=true,failure=false}:{authenticated?:boolean;failure?:boolean}={}) {
  let calls=0;
  const modules:Record<string,unknown>={
    "../auth/live-auth":{AuthenticationError,requireHost:async()=>{if(!authenticated)throw new AuthenticationError("auth");return {hostId:"user-a"};}},
    "../security/api-response":{apiSuccess:(data:unknown,init:ResponseInit)=>Response.json({ok:true,data},init),apiError:(error:string,code:string,status:number,headers:HeadersInit)=>Response.json({ok:false,error,code},{status,headers})},
    "../security/bounded-json-body":bounded,"../security/csrf":{assertStrictOrigin,CsrfError},"./broker":{CaptionBrokerError},
    "./runtime":{getCaptionBroker:()=>({credentials:async()=>{calls++;if(failure)throw new CaptionBrokerError("limit","CAPTION_RATE_LIMITED",429);return {apiKey:"temporary-fixture"};}})},
  };
  const exports:Record<string,unknown>={};
  const compiled=ts.transpileModule(readFileSync(new URL("./route.ts",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const run=vm.runInThisContext(`(function(exports,require){${compiled}\n})`) as (e:Record<string,unknown>,r:(id:string)=>unknown)=>void;
  run(exports,(id)=>{assert.ok(id in modules,id);return modules[id];});
  const factory=exports.createCaptionHandler as (op:string)=>(request:Request)=>Promise<Response>;
  return {handler:factory("credentials"),calls:()=>calls};
}
const request=(origin:string|null,body:string="{}")=>new Request("https://nova.test/api/captions/credentials",{method:"POST",headers:{"content-type":"application/json",...(origin?{origin}:{})},body});
test("caption broker rejects missing or lookalike origins and unauthenticated clients before issuing credentials",async()=>{
  const previous=process.env.ALLOWED_ORIGINS;process.env.ALLOWED_ORIGINS="https://nova.test";
  try {
    const route=load();
    for(const origin of [null,"https://nova.test.evil.test","https://nova.test:444"]){const result=await route.handler(request(origin));assert.equal(result.status,403);}
    assert.equal(route.calls(),0);
    assert.equal((await load({authenticated:false}).handler(request("https://nova.test"))).status,401);
    assert.equal((await route.handler(request("https://nova.test","x".repeat(131073)))).status,413);
    assert.equal(route.calls(),0);
  }finally{if(previous===undefined)delete process.env.ALLOWED_ORIGINS;else process.env.ALLOWED_ORIGINS=previous;}
});
test("broker success and rate limit replies are private no-store and rate limits carry Retry-After",async()=>{
  const previous=process.env.ALLOWED_ORIGINS;process.env.ALLOWED_ORIGINS="https://nova.test";
  try {
    const success=await load().handler(request("https://nova.test"));assert.equal(success.status,200);assert.equal(success.headers.get("cache-control"),"private, no-store");assert.equal(success.headers.get("vary"),"Cookie");
    const limited=await load({failure:true}).handler(request("https://nova.test"));assert.equal(limited.status,429);assert.equal(limited.headers.get("retry-after"),"60");
    assert.ok(!JSON.stringify(await limited.json()).includes("apiKey"));
  }finally{if(previous===undefined)delete process.env.ALLOWED_ORIGINS;else process.env.ALLOWED_ORIGINS=previous;}
});

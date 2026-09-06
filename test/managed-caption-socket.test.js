import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';
import {createManagedCaptionSocket} from '../src/caption-engine/managed-caption-socket.js';
class Socket extends EventEmitter { readyState=0; bufferedAmount=0; sent=[]; send(value){this.sent.push(value);} close(){this.readyState=3;this.emit('close',1000);} }
test('managed Soniox fetches a fresh credential per socket and replaces only setup credentials',async()=>{
 let issued=0; const upstream=[];
 const create=()=>createManagedCaptionSocket({url:'wss://stt-rt.soniox.com/transcribe-websocket',provider:'soniox',getCredential:async()=>({apiKey:`temporary-${++issued}`}),createWebSocket:()=>{const s=new Socket();upstream.push(s);return s;}});
 const first=create(); first.on('error',()=>{}); await new Promise(r=>setImmediate(r));
 first.send(JSON.stringify({api_key:'managed',model:'stt-rt-v5'}));
 assert.equal(JSON.parse(upstream[0].sent[0]).api_key,'temporary-1');
 first.close(); const second=create(); second.on('error',()=>{}); await new Promise(r=>setImmediate(r));
 second.send(JSON.stringify({api_key:'managed',model:'stt-rt-v5'}));
 assert.equal(JSON.parse(upstream[1].sent[0]).api_key,'temporary-2');second.close();
});
test('host stop during credential request prevents a later paid connection',async()=>{
 let finish = (_value) => {}; const pending=new Promise(resolve=>{finish=resolve;});let connections=0;
 const socket=createManagedCaptionSocket({url:'wss://example.invalid',provider:'gemini',getCredential:()=>pending,createWebSocket:()=>{connections++;return new Socket();}});
 socket.close();finish({apiKey:'fixture'});await new Promise(r=>setImmediate(r));assert.equal(connections,0);
});

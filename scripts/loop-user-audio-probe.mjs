// Loop test for a user-provided audio file: stream /tmp/usr-audio.wav through the
// live subtitle pipeline CYCLES times, capture all subtitle + debug events, then
// report the displayed-subtitle timeline (to spot mid-utterance language flips /
// source echoes) and replay into the real overlay to count simultaneous-lane frames.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
const PORT=process.env.PORT||3211, URL=`ws://localhost:${PORT}/ws`, PACE=170, FRAME=8192;
const WAV=process.env.WAV||"/tmp/usr-audio.wav";
const CYCLES=Number(process.env.CYCLES||1);
const OUT="/tmp/usr-events.jsonl";
function pcm(w){const b=fs.readFileSync(w);let o=12,s=-1,l=0;while(o+8<=b.length){const id=b.toString("ascii",o,o+4),sz=b.readUInt32LE(o+4);if(id==="data"){s=o+8;l=sz;break}o+=8+sz+(sz%2)}return b.subarray(s,s+l)}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const detect=t=>{const k=(t.match(/[가-힣]/g)||[]).length,e=(t.match(/[A-Za-z]/g)||[]).length;if(k>0&&k>=e)return"ko";if(e>0)return"en";return"?"};
const buf=pcm(WAV);
const ws=new WebSocket(URL);await new Promise(r=>ws.on("open",r));
const sid=`usr-${Date.now()}`, out=fs.createWriteStream(OUT), t0=Date.now(), el=()=>((Date.now()-t0)/1000).toFixed(2);
ws.on("message",raw=>{let m;try{m=JSON.parse(raw.toString())}catch{return}if(["subtitle:partial","subtitle:committed","subtitle:debug","subtitle:clear"].includes(m.type))out.write(JSON.stringify({t:el(),...m})+"\n")});
ws.send(JSON.stringify({type:"subtitle:start",sessionId:sid,settings:{translationProvider:"gemini",inputMode:"mic",languagePair:{a:"en",b:"ko"}}}));
await sleep(900);
for(let c=0;c<CYCLES;c++){
  out.write(JSON.stringify({t:el(),marker:`CYCLE_${c}`})+"\n");
  console.log(`[${el()}s] cycle ${c+1}/${CYCLES} streaming ${(buf.length/2/24000).toFixed(0)}s`);
  for(let j=0;j<buf.length;j+=FRAME){ws.send(JSON.stringify({type:"subtitle:audio",sessionId:sid,source:"mic",audio:buf.subarray(j,j+FRAME).toString("base64")}));await sleep(PACE)}
}
await sleep(3500);ws.send(JSON.stringify({type:"subtitle:stop",sessionId:sid}));await sleep(600);out.end();
console.log("done; events:",fs.readFileSync(OUT,"utf8").trim().split("\n").length);
ws.close();process.exit(0);

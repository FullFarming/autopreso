// Language-SWITCH loop test: stream real Korean and English speech ALTERNATING in
// ONE continuous session (ko→en→ko→en…), the exact scenario where the user saw
// "영어로 얘기하면 원문 영어로 돌아갔다 한글로 돌아가는" flicker and "둘 다 동시에 뜸".
// Verifies, per spoken segment: the EXPECTED translation language is produced, no
// source-language echo, and (via overlay replay) the two lanes never show at once.
//
// Prereqs: SUBTITLE_DEBUG dev server on :3211, /tmp/v2ko.wav (Korean) + /tmp/v1en.wav (English).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";

const PORT = process.env.PORT || 3211;
const URL = `ws://localhost:${PORT}/ws`;
const PACE_MS = 170, FRAME = 8192;
const SEG = Number(process.env.SEG || 14);      // seconds per spoken segment
const CYCLES = Number(process.env.CYCLES || 2); // ko+en per cycle
const OUTPUT_MODE = process.env.OUTPUT_MODE || "captions";
const AUDIO_LANGUAGE = process.env.AUDIO_LANGUAGE || "";
const SWITCH_GRACE_MS = Number(process.env.SWITCH_GRACE_MS || 2000);
const SWITCH_SILENCE_MS = Number(process.env.SWITCH_SILENCE_MS || 0);
const OUT = "/tmp/loop-switch-events.jsonl";

function pcm(w){const b=fs.readFileSync(w);let o=12,s=-1,l=0;while(o+8<=b.length){const id=b.toString("ascii",o,o+4),sz=b.readUInt32LE(o+4);if(id==="data"){s=o+8;l=sz;break}o+=8+sz+(sz%2)}return b.subarray(s,s+l)}
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const ko = pcm(process.env.KO_WAV || "/tmp/v2ko.wav");
const en = pcm(process.env.EN_WAV || "/tmp/v1en.wav");
const R = 24000*2;
const detect = (t)=>{const k=(t.match(/[가-힣]/g)||[]).length,e=(t.match(/[A-Za-z]/g)||[]).length;if(k>0&&k>=e)return"ko";if(e>0)return"en";return"?"};

// Build the alternating timeline of spoken segments.
const segments = [];
for (let c=0;c<CYCLES;c++){
  segments.push({ lang:"ko", buf: ko.subarray(c*SEG*R, (c+1)*SEG*R), expect:"en" });
  segments.push({ lang:"en", buf: en.subarray(c*SEG*R, (c+1)*SEG*R), expect:"ko" });
}

const ws = new WebSocket(URL); await new Promise(r=>ws.on("open",r));
const sid = `loopswitch-${Date.now()}`;
const out = fs.createWriteStream(OUT);
const t0 = Date.now(); const el = ()=>((Date.now()-t0)/1000).toFixed(2);
let spoken = "ko"; // current spoken language (updated as segments stream)

const stats = segments.map(s=>({ lang:s.lang, expect:s.expect, expected:0, echo:0, graceEcho:0, passthrough:0, audio:0, audioClears:0 }));
let segIdx = 0;
let segmentStartedAt = Date.now();
ws.on("message", raw=>{
  let m; try{m=JSON.parse(raw.toString())}catch{return}
  if(!["subtitle:partial","subtitle:committed","subtitle:debug","subtitle:translated-audio","subtitle:audio-control","subtitle:error","subtitle:status"].includes(m.type))return;
  const safeEvent = m.type === "subtitle:translated-audio" ? { ...m, audio: `[${String(m.audio || "").length} base64 chars]` } : m;
  out.write(JSON.stringify({t:el(),spoken,...safeEvent})+"\n");
  if(m.type==="subtitle:error"){console.error(`[${el()}s] ${m.code || "SUBTITLE_ERROR"}: ${m.message || "unknown error"}`);return}
  if(m.type==="subtitle:status")return;
  const st=stats[segIdx]; if(!st)return;
  if(m.type==="subtitle:translated-audio"){st.audio++;return}
  if(m.type==="subtitle:audio-control"){st.audioClears++;return}
  if(m.type==="subtitle:debug")return;
  const text=(m.translatedText||"").trim(); if(!text)return;
  const lang=detect(text);
  if(m.targetLanguage===st.expect && lang===st.expect) st.expected++;
  // echo = subtitle in the SAME language as currently spoken, on that language's lane
  if(lang===st.lang && m.targetLanguage===st.lang) {
    if (Date.now() - segmentStartedAt <= SWITCH_GRACE_MS) st.graceEcho++;
    else st.echo++;
  }
  // passthrough = expected lane carrying the SPOKEN (source) language text
  if(m.targetLanguage===st.expect && lang===st.lang) st.passthrough++;
});

ws.send(JSON.stringify({type:"subtitle:start",sessionId:sid,settings:{translationProvider:"gemini",voiceProvider:"gemini",inputMode:"mic",languagePair:{a:"en",b:"ko"},translationLanguages:["en","ko"],outputMode:OUTPUT_MODE,audioVolume:0.8,...(AUDIO_LANGUAGE?{audioLanguage:AUDIO_LANGUAGE}:{})}}));
await sleep(900);
for(let i=0;i<segments.length;i++){
  if (i > 0 && SWITCH_SILENCE_MS > 0) {
    const silenceBytes = Math.round((R * SWITCH_SILENCE_MS) / 1000);
    const silence = Buffer.alloc(silenceBytes - (silenceBytes % 2));
    for(let j=0;j<silence.length;j+=FRAME){ ws.send(JSON.stringify({type:"subtitle:audio",sessionId:sid,source:"mic",audio:silence.subarray(j,j+FRAME).toString("base64")})); await sleep(PACE_MS); }
  }
  segIdx=i; spoken=segments[i].lang; segmentStartedAt=Date.now();
  out.write(JSON.stringify({t:el(),marker:`SPEAK_${segments[i].lang.toUpperCase()}_seg${i}`})+"\n");
  console.log(`[${el()}s] speaking ${segments[i].lang.toUpperCase()} (expect ${segments[i].expect.toUpperCase()} subtitles)`);
  const buf=segments[i].buf;
  for(let j=0;j<buf.length;j+=FRAME){ ws.send(JSON.stringify({type:"subtitle:audio",sessionId:sid,source:"mic",audio:buf.subarray(j,j+FRAME).toString("base64")})); await sleep(PACE_MS); }
}
await sleep(3500);
ws.send(JSON.stringify({type:"subtitle:stop",sessionId:sid})); await sleep(600); out.end();

console.log("\n========== SWITCH LOOP SUMMARY (server stream) ==========");
let ok=true;
stats.forEach((s,i)=>{
  const good = s.expected>0 && s.echo===0 && s.passthrough===0;
  if(!good) ok=false;
  console.log(`${good?"✅":"❌"} seg${i} speak=${s.lang.toUpperCase()}→expect ${s.expect.toUpperCase()}: expected=${s.expected} sourceEcho=${s.echo} graceTail=${s.graceEcho} passthrough=${s.passthrough} audio=${s.audio} clears=${s.audioClears}`);
});
console.log(ok?"\n🎉 server stream clean per segment":"\n⚠️ issues in server stream");

// Replay into the REAL overlay module to check the two lanes never show at once.
const OURL=pathToFileURL(path.join(process.cwd(),"public","subtitle-overlay.js")).href;
const LP=20,VP=60;
class CL{constructor(){this.s=new Set()}add(n){this.s.add(n)}toggle(n,f){const on=f??!this.s.has(n);on?this.s.add(n):this.s.delete(n);return on}contains(n){return this.s.has(n)}}
class FE{constructor(t="div"){this.tag=t;this._cn="";this.hidden=false;this.children=[];this.parentNode=null;this._text="";this.dataset={};this.classList=new CL();this.style={setProperty(){},transform:""}}
 get scrollHeight(){return this.children.length*LP}get clientHeight(){return VP}
 set className(v){this._cn=String(v??"")}get className(){return this._cn}_classes(){return this._cn.split(/\s+/).filter(Boolean)}
 append(...n){for(const x of n){if(x.parentNode){const s=x.parentNode.children,k=s.indexOf(x);if(k>=0)s.splice(k,1)}x.parentNode=this;this.children.push(x)}this._text=""}
 replaceChildren(...n){this.children=[];this._text="";this.append(...n)}appendChild(n){this.append(n);return n}
 removeChild(n){const k=this.children.indexOf(n);if(k>=0)this.children.splice(k,1);n.parentNode=null;return n}
 get childNodes(){return this.children}get lastChild(){return this.children[this.children.length-1]??null}
 set textContent(v){this._text=String(v??"");this.children=[]}get textContent(){return this.children.length?this.children.map(c=>c.textContent).join(""):this._text}
 matchesSelector(s){const d=s.match(/^\[data-zone="(.+)"\]$/);if(d)return this.dataset.zone===d[1];if(s.startsWith("."))return this._classes().includes(s.slice(1));return false}
 querySelector(s){for(const c of this.children){if(c.matchesSelector(s))return c;const n=c.querySelector(s);if(n)return n}return null}}
const ov=new FE("main");ov.dataset.id="subtitle-overlay";
for(const z of["top-center","middle-center","bottom-center"]){const e=new FE("div");e.dataset.zone=z;e.className=`subtitle-zone position-${z}`;ov.append(e)}
let ows=null;globalThis.document={documentElement:new FE("html"),getElementById:id=>id==="subtitle-overlay"?ov:null,createElement:t=>new FE(t)};
globalThis.window=globalThis;globalThis.location={protocol:"http:",host:"x"};
globalThis.WebSocket=class{constructor(){this.readyState=1;this._h={};ows=this}addEventListener(t,c){this._h[t]=c}send(){}close(){}recv(m){this._h.message?.({data:JSON.stringify(m)})}open(){this._h.open?.()}};
await import(`${OURL}?v=loopswitch`);
ows.open();ows.recv({type:"settings",settings:{subtitle:{translationLanguages:["en","ko"],subtitlePositions:{en:"bottom-center",ko:"top-center"},maxSubtitleLines:3}}});
const zt=z=>{const e=ov.querySelector(`[data-zone="${z}"]`);const b=e?.querySelector(".subtitle-box");if(!b||b.hidden)return"";return(b.querySelector(".translation-line")?.textContent??"").trim()};
const lines=fs.readFileSync(OUT,"utf8").trim().split("\n").map(l=>JSON.parse(l));
let both=0,frames=0;
for(const m of lines){ if(m.type==="subtitle:partial"||m.type==="subtitle:committed"||m.type==="subtitle:clear"){ows.recv(m);frames++;const top=zt("top-center"),bot=zt("bottom-center");if(top&&bot)both++;}}
console.log("\n========== OVERLAY REPLAY ==========");
console.log("rendered frames:",frames,"| SIMULTANEOUS both-lanes frames:",both);
console.log(both===0?"🎉 the two lanes NEVER show at once (no 동시 표시/섞임)":"⚠️ simultaneous display occurred");
ws.close(); process.exit(0);

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {resolveControllerDisplay,resolveOverlayDisplays} from '../src/live-caption-ipc-relay.js';
import {DEFAULT_SUBTITLE_SETTINGS,validateSubtitleSettings} from '../src/settings-store.js';
test('controller stays on built-in screen even when external monitor is primary or overlay selected',()=>{
 const builtin={id:1,internal:true};const external={id:2,internal:false};
 assert.equal(resolveControllerDisplay([external,builtin],builtin,external),builtin);
 assert.equal(resolveControllerDisplay([external,builtin],external,external),builtin);
 assert.equal(resolveControllerDisplay([external],external,external),external);
});
test('new defaults show captions everywhere and explicit screen subsets can include none',()=>{
 assert.equal(DEFAULT_SUBTITLE_SETTINGS.overlayAllDisplays,true);
 const screens=[{id:1},{id:2},{id:3}];
 assert.deepEqual(resolveOverlayDisplays(screens,'',screens[0],false,['1','3']).map(d=>d.id),[1,3]);
 assert.deepEqual(resolveOverlayDisplays(screens,'',screens[0],true,[]),[]);
 assert.doesNotThrow(()=>validateSubtitleSettings({opacity:0}));
});

test('appearance drag coalesces latest values and final zero is persisted immediately',async()=>{
 const {createLatestAppearanceSender,applyControllerAppearance}=await import('../public/controller-appearance.js');
 const emitted=[];const sender=createLatestAppearanceSender(value=>emitted.push(value),10);
 sender.input({command:'opacity',opacity:.5});sender.input({command:'opacity',opacity:.1});sender.commit({command:'opacity',opacity:0});
 await new Promise(r=>setTimeout(r,20));assert.deepEqual(emitted,[{command:'opacity',opacity:0,preview:false}]);
 assert.equal(applyControllerAppearance({opacity:.92},{command:'opacity',opacity:0}).opacity,0);
 sender.close();
});

test('late settings acknowledgement cannot replace the newest appearance preview',async()=>{
 const {acknowledgeAppearance}=await import('../public/controller-appearance.js');
 const latest={opacity:0,translationFontSize:61};
 const stale=acknowledgeAppearance({opacity:.4,translationFontSize:38,overlayEnabled:false},latest);
 assert.equal(stale.settings.opacity,0);assert.equal(stale.settings.translationFontSize,61);assert.equal(stale.settings.overlayEnabled,false);
 const acknowledged=acknowledgeAppearance({opacity:0,translationFontSize:61},stale.edits);
 assert.deepEqual(acknowledged.edits,{});
});
test('loading a stored single display preference preserves it against the new all-screen default',async()=>{
 const fs=await import('node:fs/promises');const os=await import('node:os');const path=await import('node:path');
 const {createSettingsStore}=await import('../src/settings-store.js');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'controller-display-'));
 try{const filePath=path.join(dir,'settings.json');await fs.writeFile(filePath,JSON.stringify({subtitle:{overlayDisplayId:'2',opacity:0}}));
 const settings=await createSettingsStore({filePath,env:{}}).load();
 assert.equal(settings.subtitle.overlayDisplayId,'2');assert.equal(settings.subtitle.overlayAllDisplays,false);assert.equal(settings.subtitle.opacity,0);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

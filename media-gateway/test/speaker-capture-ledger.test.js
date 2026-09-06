import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeakerCaptureLedger } from '../src/speaker-capture-ledger.js';
const profile = (id) => ({ id, version: 1, displayName: id, company: 'Company', department: 'Dept', photoAssetId: null });
test('capture ledger binds delayed A B C finals to immutable captured profiles', () => {
 const ledger = new SpeakerCaptureLedger(); const a = profile('A');
 ledger.capture(40, { speakerProfile: a, floor: null }); a.displayName = 'changed';
 ledger.capture(40, { speakerProfile: profile('B'), floor: null });
 ledger.capture(40, { speakerProfile: profile('C'), floor: null });
 assert.equal(ledger.resolve({sourceSessionStartOffsetMs:0,sourceSessionEndOffsetMs:40}).speakerProfile.displayName,'A');
 assert.equal(ledger.resolve({sourceSessionStartOffsetMs:40,sourceSessionEndOffsetMs:80}).speakerProfile.id,'B');
 assert.equal(ledger.resolve({sourceSessionStartOffsetMs:80,sourceSessionEndOffsetMs:120}).speakerProfile.id,'C');
});
test('onsetless and cross-identity segments stay unresolved instead of current speaker', () => {
 const ledger = new SpeakerCaptureLedger(); ledger.capture(40,{speakerProfile:profile('A')}); ledger.capture(40,{speakerProfile:profile('B')});
 assert.equal(ledger.resolve({}).unresolved,true);
 assert.equal(ledger.resolve({sourceSessionStartOffsetMs:20,sourceSessionEndOffsetMs:60}).unresolved,true);
 assert.equal(ledger.resolve({sourceGenerationStartOffsetMs:40}).speakerProfile.id,'B');
});
test('captured linked participant remains immutable and old bounds cannot guess', () => {
 const ledger = new SpeakerCaptureLedger(); const floor = { participantId:'p',displayName:'Participant' };
 ledger.capture(40,{floor,speakerProfile:profile('P')}); floor.displayName='Changed';
 assert.equal(ledger.resolve({sourceSessionStartOffsetMs:0,sourceSessionEndOffsetMs:40}).floor.displayName,'Participant');
 assert.equal(ledger.resolve({sourceSessionStartOffsetMs:90}).unresolved,true);
});

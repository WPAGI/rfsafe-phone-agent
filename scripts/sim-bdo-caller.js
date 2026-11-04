const path=require('path'),fs=require('fs'),os=require('os');process.chdir('/workspace/code/rpa-callrec');
const {CallSession}=require('../src/xai');const {Newsletter}=require('../src/newsletter');const {MockRealtimeWs}=require('../src/mocks');const {TenantRegistry}=require('../src/tenants');
const T=new TenantRegistry('deploy/bestdealon/tenants').byId.get('bestdealon');
const nl=new Newsletter({secret:'x'.repeat(32),file:path.join(fs.mkdtempSync(path.join(os.tmpdir(),'s')),'n.jsonl')});
nl.record({e:'mock.person@quantaxtechnology.com',n:'Mock Caller',t:'bestdealon'},'confirmed');nl.linkPhone({tenant:'bestdealon',email:'mock.person@quantaxtechnology.com',phone:'+15550001001'});
const ws=new MockRealtimeWs();const s=new CallSession({ws,tenant:T,callId:'sim',caller:'+15550001001',tools:{definitions:()=>[]},afterHours:false,log:()=>{},newsletter:nl,siteProfile:null,onEnd:()=>{}});clearTimeout(s.timer);
const all=JSON.stringify(ws.sent);console.log('GREETING:',ws.sent.find(x=>x.item&&x.item.type==='force_message').item.content[0].text);
console.log((ws.sent.find(x=>x.type==='session.update').session.instructions.match(/[^\n]*(Should someone|on file|NOT verified)[^\n]*/g)||[]).join('\n').slice(0,900));
console.log('address leaked:',all.includes('mock.person'));process.exit(0);

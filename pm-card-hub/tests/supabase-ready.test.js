// Dependency-free regression test exercising the new async V10 handlers and local storage adapter.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const sourceDir = path.join(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-cloud-test-'));
for (const name of ['server.js', 'storage.js']) fs.copyFileSync(path.join(sourceDir,name),path.join(temp,name));
const routes = new Map();
const app = {
  disable() {}, use() {}, listen() {},
  get(route,...fns) {routes.set('GET '+route.toString(),fns);},
  post(route,...fns) {routes.set('POST '+route.toString(),fns);},
  delete(route,...fns) {routes.set('DELETE '+route.toString(),fns);}
};
function express(){return app;}
express.json=()=>()=>{}; express.static=()=>()=>{};
function multer(){return {fields:()=>()=>{},single:()=>()=>{}};}
multer.memoryStorage=()=>({});multer.MulterError=class extends Error {};
let exported={};
const sandbox={
  __dirname:temp,console,Buffer,module:{exports:exported},require(moduleName){
    if(moduleName==='express')return express;
    if(moduleName==='multer')return multer;
    if(moduleName==='dotenv')return {config(){return {}}};
    if(moduleName==='./storage')return require(path.join(temp,'storage.js'));
    return require(moduleName);
  },process:{env:{ADMIN_PASSWORD:'test-private-password'},pid:process.pid},
};
async function run(){
  try {
    vm.runInNewContext(fs.readFileSync(path.join(temp,'server.js'),'utf8'),sandbox,{filename:'server.js'});
    const a={id:'a',image:'/uploads/a.png',backImage:'/uploads/a-back.png'};
    const b={id:'b',image:'/uploads/b.png',backImage:'/uploads/b-back.png'};
    const enemy={id:'e',image:'/uploads/e.png',backImage:'/uploads/e-back.png'};
    const state={
      cards:[a,b],decks:{Alice:['a'],Bob:['b']},unlocks:{Alice:['a'],Bob:['b']},players:['Alice','Bob'],
      enemies:[{id:'middle',name:'Middle',cards:[enemy]}],
      arena:{enemyId:'middle',cardIds:['e'],instances:[{instanceId:'enemy1',cardId:'e',used:false,targeted:false}]},
      combat:{players:{},actions:[],round:1,emotionLevel:1,showSpeeds:false,enemySpeeds:{},enemyDiscarded:0}
    };
    fs.writeFileSync(path.join(temp,'data.json'),JSON.stringify(state));
    async function call(method,url,body={},admin=false,query={}){
      const fns=routes.get(method+' '+url);assert.ok(fns,url+' registered');
      let status=200,payload;
      const req={body,query,get(name){return name==='x-admin-password'&&admin?'test-private-password':'';}};
      const res={status(code){status=code;return this;},json(data){payload=data;return this;}};
      for (const fn of fns){
        let called=false;
        await fn(req,res,()=>{called=true;});
        if(payload!==undefined || !called)break;
      }
      return {status,payload};
    }
    const read=()=>JSON.parse(fs.readFileSync(path.join(temp,'data.json'),'utf8'));
    function ok(result){assert.equal(result.status,200,JSON.stringify(result.payload));return result.payload;}
    ok(await call('POST','/api/battle/start',{player:'Alice'}));
    ok(await call('POST','/api/battle/start',{player:'Bob'}));
    let d=read();assert.equal(d.combat.players.Alice.hand.length,4);
    const alice=d.combat.players.Alice.hand[0].instanceId;
    const bob=d.combat.players.Bob.hand[0].instanceId;
    ok(await call('POST','/api/battle/attack',{player:'Alice',instanceId:alice,enemyInstanceId:'enemy1'}));
    ok(await call('POST','/api/battle/attack',{player:'Bob',instanceId:bob,enemyInstanceId:'enemy1'}));
    ok(await call('POST','/api/battle/undo-attack',{player:'Alice',instanceId:alice}));
    assert.equal(read().arena.instances[0].targeted,true);
    ok(await call('POST','/api/battle/undo-attack',{player:'Bob',instanceId:bob}));
    assert.equal(read().arena.instances[0].targeted,false);
    ok(await call('POST','/api/battle/attack',{player:'Alice',instanceId:alice,enemyInstanceId:'enemy1'}));
    ok(await call('POST','/api/gm/combat/end-round',{expectedRound:1},true));
    assert.equal(read().combat.round,2);
    ok(await call('POST','/api/gm/combat/end-round',{expectedRound:2},true));
    assert.equal(read().combat.round,3);
    ok(await call('POST','/api/gm/combat/emotion',{level:5},true));
    assert.equal(ok(await call('POST','/api/gm/combat/end-round',{expectedRound:3},true)).summary.requestedDraw,3);
    assert.equal((await call('POST','/api/gm/combat/end-round',{expectedRound:3},true)).status,409);
    assert.equal((await call('POST','/api/gm/combat/clear-feed',{},false)).status,401);
    // Same storage adapter handles local uploads and retained filenames.
    const adapter=require(path.join(temp,'storage.js'));
    assert.equal(adapter.isCloud,false);
    const f={originalname:'combat.png',mimetype:'image/png',buffer:Buffer.from('fake-png')};
    const img=await adapter.uploadMedia(f);assert.match(img,/^\/uploads\/[a-z0-9.-]+\.png$/);
    const loc=await adapter.mediaUrl(img.slice('/uploads/'.length));
    assert.ok(fs.existsSync(loc));
    await adapter.removeMediaUrls([img]);assert.equal(fs.existsSync(loc),false);
    console.log('PASS: V10 round actions, duplicate players, undo, emotion 5, GM password, local adapter media persistence');
  } finally {fs.rmSync(temp,{recursive:true,force:true});}
}
run().catch(e=>{console.error(e);process.exitCode=1;});

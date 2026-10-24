// Dependency-free integration tests: use the actual server.js route handlers
// with a lightweight fake Express registration layer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-v10-test-'));
const routes = new Map();
const app = {
  use() {}, listen() {},
  get(url, ...fns) { routes.set('GET ' + url, fns); },
  post(url, ...fns) { routes.set('POST ' + url, fns); },
  delete(url, ...fns) { routes.set('DELETE ' + url, fns); }
};
function express() { return app; }
express.json = () => (_req, _res, next) => next();
express.static = () => (_req, _res, next) => next();
function multer() { return { single: () => (_req, _res, next) => next(), array: () => (_req, _res, next) => next(), fields: () => (_req, _res, next) => next() }; }
multer.diskStorage = () => ({});
multer.MulterError = class extends Error {};
const sandbox = {
  __dirname: temp, console, Buffer, process: {env:{ADMIN_PASSWORD:'safe-test-pass'}},
  require(name) {
    if (name === 'express') return express;
    if (name === 'multer') return multer;
    return require(name);
  }
};
try {
  vm.runInNewContext(source, sandbox, {filename:'server.js'});
  const dataFile = path.join(temp, 'data.json');
  const a = {id:'a',image:'/uploads/a.png',backImage:'/uploads/a-back.png'};
  const b = {id:'b',image:'/uploads/b.png',backImage:'/uploads/b-back.png'};
  const enemyCard = {id:'e',image:'/uploads/e.png',backImage:'/uploads/e-back.png'};
  function seed() {
    fs.writeFileSync(dataFile, JSON.stringify({
      cards:[a,b], decks:{Alice:['a'], Bob:['b']}, unlocks:{Alice:['a'],Bob:['b']},
      players:['Alice','Bob'], enemies:[{id:'middle',name:'Middle Grunt',cards:[enemyCard]}],
      arena:{enemyId:'middle',cardIds:['e'],instances:[{instanceId:'enemy1',cardId:'e',used:false,targeted:false}]},
      combat:{players:{},actions:[],showSpeeds:false,enemySpeeds:{},round:1,emotionLevel:1,enemyDiscarded:0}
    }, null, 2));
  }
  async function call(method, url, body={}, admin=false, query={}) {
    const fns = routes.get(method+' '+url);
    assert.ok(fns, 'route '+method+' '+url+' exists');
    let status=200, payload;
    const req={body,query,get(key){return key==='x-admin-password' && admin ? 'safe-test-pass' : '';}};
    const res={status(n){status=n;return this;},json(v){payload=v;return this;}};
    for (const fn of fns) {
      let next=false;
      const result=fn(req,res,()=>{next=true;});
      if(result && typeof result.then==='function')await result;
      if(payload !== undefined || !next) break;
    }
    return {status,payload};
  }
  const read=()=>JSON.parse(fs.readFileSync(dataFile,'utf8'));
  function expectOk(r){assert.equal(r.status,200,JSON.stringify(r.payload));return r.payload;}
  (async()=>{
    seed();
    expectOk(await call('POST','/api/battle/start',{player:'Alice'}));
    expectOk(await call('POST','/api/battle/start',{player:'Bob'}));
    let d=read();
    assert.equal(d.combat.players.Alice.hand.length,4);
    const alice=d.combat.players.Alice.hand[0].instanceId;
    const bob=d.combat.players.Bob.hand[0].instanceId;
    expectOk(await call('POST','/api/battle/attack',{player:'Alice',instanceId:alice,enemyInstanceId:'enemy1'}));
    expectOk(await call('POST','/api/battle/attack',{player:'Bob',instanceId:bob,enemyInstanceId:'enemy1'}));
    assert.equal(read().combat.actions.filter(x=>x.kind==='player').length,2);
    expectOk(await call('POST','/api/battle/undo-attack',{player:'Alice',instanceId:alice}));
    d=read();
    assert.equal(d.combat.players.Alice.hand[0].pending,false);
    assert.equal(d.arena.instances[0].targeted,true,'Bob still targets enemy');
    assert.equal(d.combat.actions.filter(x=>x.kind==='player').length,1,'cancelled event disappears');
    assert.equal((await call('POST','/api/battle/undo-attack',{player:'Alice',instanceId:alice})).status,409);
    expectOk(await call('POST','/api/battle/undo-attack',{player:'Bob',instanceId:bob}));
    assert.equal(read().arena.instances[0].targeted,false,'enemy unqueued after last attack is cancelled');
    expectOk(await call('POST','/api/battle/attack',{player:'Alice',instanceId:alice,enemyInstanceId:'enemy1'}));
    assert.equal((await call('POST','/api/battle/undo-attack',{player:'Bob',instanceId:alice})).status,409);
    let end=expectOk(await call('POST','/api/gm/combat/end-round',{expectedRound:1},true));
    assert.equal(end.summary.finishedRound,1);
    assert.equal(end.summary.round,2);
    assert.equal(end.summary.players.find(x=>x.player==='Alice').discarded,1);
    assert.equal(end.summary.players.find(x=>x.player==='Alice').drawn,1);
    assert.equal(end.summary.players.find(x=>x.player==='Bob').drawn,1);
    assert.equal(read().arena.instances.length,0,'targeted enemy discarded');
    assert.equal((await call('POST','/api/battle/undo-attack',{player:'Alice',instanceId:alice})).status,409,'too late to undo');
    assert.equal((await call('POST','/api/gm/combat/end-round',{expectedRound:1},true)).status,409,'stale click does not skip round');
    end=expectOk(await call('POST','/api/gm/combat/end-round',{expectedRound:2},true));
    assert.equal(end.summary.round,3,'GM can end multiple successive rounds');
    expectOk(await call('POST','/api/gm/combat/emotion',{level:5},true));
    end=expectOk(await call('POST','/api/gm/combat/end-round',{expectedRound:3},true));
    assert.equal(end.summary.requestedDraw,3);
    assert.equal(end.summary.players.length,2);
    assert.equal((await call('POST','/api/gm/combat/end-round',{expectedRound:4},false)).status,401,'GM route protected');
    const js=fs.readFileSync(path.join(__dirname,'..','public','app.js'),'utf8');
    assert.match(js,/const button = event\.currentTarget;/);
    assert.match(js,/finally \{[\s\S]*?button\.disabled = false;/);
    assert.match(js,/data-undo-attack/);
    console.log('PASS: two-player undo, shared enemy targeting, action removal, successive rounds, stale click guard, emotion drawing, GM auth and button recovery');
  })().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>fs.rmSync(temp,{recursive:true,force:true}));
} catch (e) {fs.rmSync(temp,{recursive:true,force:true});throw e;}

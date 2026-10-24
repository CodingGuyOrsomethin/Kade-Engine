// Mock Supabase cloud adapter and verify private bucket / DB integration offline.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'storage.js'), 'utf8');
let current = {cards:[],decks:{},enemies:[]};
const objects = new Map();
const bucket = {
  upload: async (name, content)=>{objects.set(name,content);return {error:null};},
  remove: async keys=>{keys.forEach(k=>objects.delete(k));return {error:null};},
  createSignedUrl: async (key)=>({data:objects.has(key)?{signedUrl:`https://example.supabase.co/private/${key}?token=short`}:null,error:objects.has(key)?null:new Error('missing')}),
};
const client = {
  from: ()=>({
    select:()=>({eq:()=>({single:async()=>({data:{id:1,data:current},error:null})})}),
    upsert:async row=>{current=row.data;return {error:null};}
  }),
  storage: {from:()=>bucket,getBucket:async()=>({data:{name:'card-hub-media'},error:null})}
};
const sandbox={
  __dirname:path.join(__dirname,'..'),console,Buffer,module:{exports:{}},process:{env:{SUPABASE_URL:'https://example.supabase.co',SUPABASE_SECRET_KEY:'sb_secret_TEST',SUPABASE_BUCKET:'card-hub-media'}},
  require(name){if(name==='@supabase/supabase-js')return {createClient:()=>client};return require(name);}
};
vm.runInNewContext(source,sandbox,{filename:'storage.js'});
const store=sandbox.module.exports;
(async()=>{
  assert.equal(store.isCloud,true);
  await store.checkConnection();
  await store.saveState({cards:[{id:'abc'}],decks:{Alice:['abc']},enemies:[]});
  assert.equal((await store.loadState()).cards[0].id,'abc');
  const file={originalname:'test.png',mimetype:'image/png',buffer:Buffer.from([42])};
  const uri=await store.uploadMedia(file);
  const key=uri.slice('/uploads/'.length);
  assert.ok(objects.has(key));
  assert.match(await store.mediaUrl(key),/^https:\/\/example/);
  await store.removeMediaUrls([uri]);
  assert.equal(objects.has(key),false);
  console.log('PASS: mock Supabase database and private media upload, signed link, deletion');
})().catch(e=>{console.error(e);process.exitCode=1;});

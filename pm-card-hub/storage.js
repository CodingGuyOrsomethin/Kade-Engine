// One adapter for local development and private Supabase persistence on Render.
const fs = require('node:fs/promises');
const fssync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const DATA_FILE = path.join(ROOT, 'data.json');
const BUCKET = process.env.SUPABASE_BUCKET || 'card-hub-media';
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!!url !== !!key) throw new Error('Set both SUPABASE_URL and SUPABASE_SECRET_KEY (or SERVICE_ROLE_KEY).');
const isCloud = Boolean(url && key);
let supabase;
if (isCloud) {
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
}
const freshState = () => ({ cards: [], decks: {}, unlocks: {}, players: [], enemies: [], arena: { enemyId: null, cardIds: [], instances: [] }, combat: { players: {}, actions: [], showSpeeds: false, enemySpeeds: {}, round: 1, emotionLevel: 1 } });
function check(error, context) { if (error) throw new Error(`${context}: ${error.message}`); }
async function loadState() {
  if (isCloud) {
    const { data, error } = await supabase.from('card_hub_state').select('data').eq('id', 1).single();
    check(error, 'Supabase read');
    return data.data;
  }
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  try { return JSON.parse(await fs.readFile(DATA_FILE, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; return freshState(); }
}
async function saveState(state) {
  if (isCloud) {
    const { error } = await supabase.from('card_hub_state').upsert({ id: 1, data: state, updated_at: new Date().toISOString() }, { onConflict: 'id' });
    check(error, 'Supabase write');
  } else {
    const temp = `${DATA_FILE}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state, null, 2));
    await fs.rename(temp, DATA_FILE);
  }
}
function mediaKeyFromUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('/uploads/')) return null;
  const objectPath = value.substring('/uploads/'.length);
  if (!/^(?:music\/)?[a-zA-Z0-9._-]+$/.test(objectPath) || objectPath.includes('..')) return null;
  return objectPath;
}
const contentTypes = { '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.mp3':'audio/mpeg','.ogg':'audio/ogg','.wav':'audio/wav','.m4a':'audio/mp4' };
async function putObject(objectPath, buffer, mimetype, options = {}) {
  if (isCloud) {
    const { error } = await supabase.storage.from(BUCKET).upload(objectPath, buffer, { contentType: mimetype, upsert: !!options.upsert });
    check(error, `Supabase upload ${objectPath}`);
  } else {
    const diskPath = path.join(UPLOAD_DIR, objectPath);
    await fs.mkdir(path.dirname(diskPath), { recursive: true });
    await fs.writeFile(diskPath, buffer);
  }
}
async function uploadMedia(file, prefix = '') {
  const ext = path.extname(file.originalname).toLowerCase();
  const name = `${Date.now()}-${crypto.randomBytes(12).toString('hex')}${ext}`;
  const objectPath = prefix + name;
  await putObject(objectPath, file.buffer, file.mimetype);
  return `/uploads/${objectPath}`;
}
async function removeMediaUrls(values) {
  const keys = [...new Set(values.map(mediaKeyFromUrl).filter(Boolean))];
  if (!keys.length) return;
  if (isCloud) {
    const { error } = await supabase.storage.from(BUCKET).remove(keys);
    check(error, 'Supabase remove media');
  } else {
    await Promise.all(keys.map(key => fs.rm(path.join(UPLOAD_DIR, key), { force: true })));
  }
}
async function mediaUrl(objectPath) {
  if (isCloud) {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(objectPath, 600);
    // 404 vs transient storage failures should not leak private internals.
    if (error) return null;
    return data?.signedUrl || null;
  }
  const diskPath = path.join(UPLOAD_DIR, objectPath);
  if (!fssync.existsSync(diskPath)) return null;
  return diskPath;
}
async function checkConnection() {
  if (isCloud) {
    const { data, error } = await supabase.from('card_hub_state').select('id').eq('id', 1).single();
    check(error, 'Supabase startup check: complete Step 2 SQL and check server credentials');
    if (data?.id !== 1) throw new Error('Supabase card_hub_state row 1 is missing.');
    const { error: bucketError } = await supabase.storage.getBucket(BUCKET);
    check(bucketError, `Supabase storage bucket '${BUCKET}'`);
  } else await fs.mkdir(UPLOAD_DIR, { recursive: true });
}
module.exports = { isCloud, loadState, saveState, uploadMedia, removeMediaUrls, mediaUrl, putObject, mediaKeyFromUrl, checkConnection, contentTypes, freshState };

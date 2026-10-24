// One-time migration: local V10 data.json + uploads -> private Supabase.
// Run ONLY on your PC, with both the backup data and Supabase credentials.
require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');
const storage = require('../storage');
const root = path.join(__dirname, '..');
const sourceFile = process.env.MIGRATE_DATA_FILE || path.join(root, 'data.json');
const sourceUploads = process.env.MIGRATE_UPLOADS_DIR || path.join(root, 'uploads');
async function run() {
  if (!storage.isCloud) throw new Error('This command requires SUPABASE_URL and SUPABASE_SECRET_KEY in .env.');
  await storage.checkConnection();
  const source = JSON.parse(await fs.readFile(sourceFile, 'utf8'));
  if (!Array.isArray(source.cards) || !source.decks || !Array.isArray(source.enemies)) {
    throw new Error('The supplied data.json is not recognized as a V10 Card Hub save.');
  }
  const current = await storage.loadState();
  if (current && (current.cards?.length || current.enemies?.length || current.players?.length ||
    Object.keys(current.decks || {}).length || Object.keys(current.unlocks || {}).length ||
    Object.keys(current.combat?.players || {}).length || current.combat?.actions?.length ||
    current.arena?.instances?.length || current.music)) {
    throw new Error('Supabase already contains game data; migration stopped to avoid overwriting it.');
  }
  const files = new Set();
  for (const card of [...source.cards, ...source.enemies.flatMap(e => e.cards || [])]) {
    for (const value of [card.image, card.backImage]) {
      const name = storage.mediaKeyFromUrl(value);
      if (name) files.add(name);
    }
  }
  const music = storage.mediaKeyFromUrl(source.music?.url);
  if (music) files.add(music);
  console.log(`Importing ${files.size} media files from local V10...`);
  // Check that every referenced file exists BEFORE uploading or writing state.
  const entries = [];
  for (const objectPath of files) {
    const filepath = path.join(sourceUploads, objectPath);
    const data = await fs.readFile(filepath);
    entries.push({ objectPath, data, type: storage.contentTypes[path.extname(objectPath).toLowerCase()] || 'application/octet-stream' });
  }
  // Use the original paths so existing /uploads/... references keep working.
  for (const [i, entry] of entries.entries()) {
    await storage.putObject(entry.objectPath, entry.data, entry.type, {upsert: true});
    console.log(`Uploaded ${i + 1}/${entries.length}: ${entry.objectPath}`);
  }
  await storage.saveState(source);
  console.log('SUCCESS: saved game state and all referenced uploads moved to Supabase. Keep your original backup.');
}
run().catch(e => { console.error('Migration stopped:', e.message); process.exitCode = 1; });

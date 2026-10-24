const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();
const mediaStore = require('./storage');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (process.env.NODE_ENV === 'production' ? '' : 'change-this-password');
if (!ADMIN_PASSWORD || (process.env.NODE_ENV === 'production' && ADMIN_PASSWORD === 'change-this-password')) {
  throw new Error('Set a strong ADMIN_PASSWORD environment variable before deploying publicly.');
}
if (process.env.NODE_ENV === 'production' && !mediaStore.isCloud) {
  throw new Error('Supabase variables must be set on Render; its local filesystem is not persistent.');
}
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
// Serialize API requests (including reads) to prevent the three players from
// overwriting each other's single-row saved game state with simultaneous writes.
let apiQueue = Promise.resolve();
app.use('/api', (req, res, next) => {
  let release;
  const myTurn = new Promise(resolve => { release = resolve; });
  const prior = apiQueue;
  apiQueue = myTurn;
  prior.then(() => {
    let done = false;
    const unlock = () => { if (!done) { done = true; release(); } };
    res.once('finish', unlock);
    res.once('close', unlock);
    next();
  }).catch(next);
});
// Original image URLs remain valid. Objects are in a private Supabase bucket;
// the server issues short-lived media URLs only for filenames that were shared.
app.get(/^\/uploads\/(.+)$/, async (req, res) => {
  const storedPath = req.params[0];
  if (!/^(?:music\/)?[a-zA-Z0-9._-]+$/.test(storedPath) || storedPath.includes('..')) {
    return res.status(400).send('Invalid media path');
  }
  const target = await mediaStore.mediaUrl(storedPath);
  if (!target) return res.status(404).send('Media unavailable');
  res.set('Cache-Control', 'private, max-age=45');
  if (mediaStore.isCloud) res.redirect(302, target);
  else res.sendFile(target);
});
app.use(express.static(require('path').join(__dirname, 'public')));

async function readData() {
  const raw = await mediaStore.loadState();
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  data.cards ||= []; data.decks ||= {}; data.enemies ||= []; data.arena ||= { enemyId: null, cardIds: [] }; data.music ||= null;
  data.combat ||= { players: {}, actions: [], showSpeeds: false, enemySpeeds: {} };
  data.combat.players ||= {};
  if (Array.isArray(data.combat.players)) data.combat.players = {};
  data.combat.actions ||= []; data.combat.enemySpeeds ||= {}; data.combat.showSpeeds ||= false;
  data.combat.round ||= 1;
  data.combat.emotionLevel = Number.isInteger(data.combat.emotionLevel) && data.combat.emotionLevel >= 1 && data.combat.emotionLevel <= 5 ? data.combat.emotionLevel : 1;
  data.combat.enemyDiscarded ||= 0;
  const needsArenaMigration = !Array.isArray(data.arena.instances);
  if (needsArenaMigration) {
    data.arena.instances = (data.arena.cardIds || []).map(cardId => ({ instanceId: crypto.randomUUID(), cardId, used: false, targeted: false }));
  }
  for (const battle of Object.values(data.combat.players)) {
    battle.hand ||= []; battle.drawPile ||= []; battle.discarded ||= [];
    for (const card of battle.hand) card.pending ||= false;
  }
  if (!data.unlocks) data.unlocks = Object.fromEntries(Object.entries(data.decks).map(([name, ids]) => [name, [...new Set(ids)]]));
  data.players ||= [...new Set([...Object.keys(data.decks), ...Object.keys(data.unlocks)])];
  data.players = [...new Set(data.players.filter(name => typeof name === 'string' && !!cleanPlayerName(name)))];
  if (needsArenaMigration) await writeData(data);
  return data;
}
async function writeData(data) { await mediaStore.saveState(data); }
function cleanPlayerName(value) { return typeof value === 'string' ? value.trim().replace(/[<>\u0000-\u001f]/g, '').slice(0, 24) : ''; }
function adminOnly(req, res, next) {
  const a = Buffer.from(req.get('x-admin-password') || '');
  const b = Buffer.from(ADMIN_PASSWORD);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Incorrect GM password.' });
  next();
}
// Images and audio arrive in memory, then are stored in Supabase (or in local
// uploads/ during development). No user uploads go to Render's ephemeral disk.
const imageUpload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 200 },
  fileFilter: (_req, file, cb) => {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.mimetype))
      return cb(new Error('Use PNG, JPG, WebP, or GIF image files.'));
    cb(null, true);
  }
});
const AUDIO_FORMATS = new Map([
  ['.mp3', ['audio/mpeg', 'audio/mp3']],
  ['.ogg', ['audio/ogg', 'application/ogg']],
  ['.wav', ['audio/wav', 'audio/x-wav', 'audio/wave']],
  ['.m4a', ['audio/mp4', 'audio/x-m4a']]
]);
const musicUpload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = require('path').extname(file.originalname).toLowerCase();
    if (!AUDIO_FORMATS.get(ext)?.includes(file.mimetype))
      return cb(new Error('Use an MP3, OGG, WAV, or M4A audio file.'));
    cb(null, true);
  }
});
async function removeMusicFile(music) {
  if (!music?.url?.startsWith('/uploads/music/')) return;
  await mediaStore.removeMediaUrls([music.url]);
}
app.post('/api/gm/music', adminOnly, musicUpload.single('music'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose an audio file first.' });
  const uploaded = await mediaStore.uploadMedia(req.file, 'music/');
  const data = await readData(); const previous = data.music;
  data.music = { url: uploaded, originalName: require('path').basename(req.file.originalname).slice(0, 180), updatedAt: Date.now() };
  try { await writeData(data); } catch (e) { await mediaStore.removeMediaUrls([uploaded]); throw e; }
  await removeMusicFile(previous);
  res.json({ ok: true, music: data.music });
});
app.delete('/api/gm/music', adminOnly, async (_req, res) => {
  const data = await readData(); const previous = data.music;
  data.music = null; await writeData(data); await removeMusicFile(previous);
  res.json({ ok: true });
});
async function imagePair(front, back) {
  const frontUrl = await mediaStore.uploadMedia(front);
  try {
    const backUrl = await mediaStore.uploadMedia(back);
    return {
      id: crypto.randomUUID(), image: frontUrl, backImage: backUrl,
      originalName: require('path').basename(front.originalname).slice(0, 180),
      backOriginalName: require('path').basename(back.originalname).slice(0, 180),
      uploadedAt: new Date().toISOString()
    };
  } catch (e) { await mediaStore.removeMediaUrls([frontUrl]); throw e; }
}
async function removeImages(cards) {
  await mediaStore.removeMediaUrls(cards.flatMap(c => [c.image, c.backImage]));
}
async function storePairs(fronts, backs) {
  const added = [];
  try {
    for (let i = 0; i < fronts.length; i++) added.push(await imagePair(fronts[i], backs[i]));
    return added;
  } catch (e) { await removeImages(added); throw e; }
}
function publicArena(data) {
  const enemy = data.enemies.find(e => e.id === data.arena.enemyId);
  if (!enemy) return { enemyId: null, enemyName: null, cards: [], updatedAt: data.arena.updatedAt || null };
  const cardsById = new Map(enemy.cards.map(c => [c.id, c]));
  return { enemyId: enemy.id, enemyName: enemy.name,
    cards: data.arena.instances.map(slot => {
      const card = cardsById.get(slot.cardId);
      return card && { ...card, instanceId: slot.instanceId, pending: !!(slot.used || slot.targeted),
        used: !!slot.used, targeted: !!slot.targeted,
        speed: data.combat.showSpeeds ? (data.combat.enemySpeeds[slot.instanceId] ?? data.combat.enemySpeeds[slot.cardId] ?? null) : null };
    }).filter(Boolean), updatedAt: data.arena.updatedAt || null };
}
function currentEnemy(data) { return data.enemies.find(e => e.id === data.arena.enemyId); }
function battlefieldSlot(data, instanceId) { return data.arena.instances.find(slot => slot.instanceId === instanceId); }
function drawCountForEmotion(level) { return level === 1 ? 1 : level === 2 ? 2 : 3; }

// Player identity is name-based in this prototype, not authenticated. For a public
// deployment, add individual login credentials before treating unlocks as secure.
function unlockedIds(data, player) { return new Set(player ? (data.unlocks[player] || []) : []); }
app.get('/api/state', async (req, res) => {
  const data = await readData(); const player = cleanPlayerName(req.query.player || '');
  const allowed = unlockedIds(data, player);
  res.json({ cards: data.cards.filter(c => allowed.has(c.id)), deck: player ? (data.decks[player] || []).filter(id => allowed.has(id)) : [], arena: publicArena(data), music: data.music, battle: publicPlayerBattle(data, player), combatActions: visibleActions(data, player), showSpeeds: data.combat.showSpeeds, round: data.combat.round, emotionLevel: data.combat.emotionLevel, lastRoundSummary: data.combat.lastRoundSummary || null });
});
app.post('/api/player/register', async (req, res) => {
  const player = cleanPlayerName(req.body.player);
  if (!player) return res.status(400).json({ error: 'Enter a player name.' });
  const data = await readData();
  if (!data.players.includes(player)) data.players.push(player);
  data.unlocks[player] ||= [];
  data.decks[player] ||= [];
  await writeData(data);
  res.json({ ok: true, player });
});
// The GM sees the entire vault and can grant/revoke individual cards per player.
app.get('/api/gm/cards', adminOnly, async (_req, res) => {
  const data = await readData();
  res.json({ cards: data.cards, players: data.players, unlocks: data.unlocks });
});
app.post('/api/gm/players', adminOnly, async (req, res) => {
  const player = cleanPlayerName(req.body.player);
  if (!player) return res.status(400).json({ error: 'Enter a player name.' });
  const data = await readData();
  if (!data.players.includes(player)) data.players.push(player);
  data.unlocks[player] ||= []; data.decks[player] ||= [];
  await writeData(data); res.json({ ok: true, player });
});
app.post('/api/gm/grants', adminOnly, async (req, res) => {
  const player = cleanPlayerName(req.body.player);
  const { cardId, grant } = req.body;
  const data = await readData();
  if (!player || !data.players.includes(player)) return res.status(400).json({ error: 'Add or select a player first.' });
  if (typeof cardId !== 'string' || !data.cards.some(c => c.id === cardId)) return res.status(400).json({ error: 'Invalid card.' });
  if (typeof grant !== 'boolean') return res.status(400).json({ error: 'Invalid unlock action.' });
  const allowed = new Set(data.unlocks[player] || []);
  if (grant) allowed.add(cardId); else allowed.delete(cardId);
  data.unlocks[player] = [...allowed];
  if (!grant) { data.decks[player] = (data.decks[player] || []).filter(id => id !== cardId); delete data.combat.players[player]; }
  await writeData(data); res.json({ ok: true, player, cardId, granted: grant });
});
app.post('/api/deck', async (req, res) => {
  const player = cleanPlayerName(req.body.player);
  const ids = Array.isArray(req.body.cardIds) ? [...new Set(req.body.cardIds.filter(x => typeof x === 'string'))] : [];
  if (!player) return res.status(400).json({ error: 'Enter a player name first.' });
  if (ids.length > 5) return res.status(400).json({ error: 'Your deck can contain up to 5 cards.' });
  const data = await readData(); const validIds = unlockedIds(data, player);
  if (ids.some(id => !validIds.has(id))) return res.status(403).json({ error: 'Your GM has not unlocked one or more of those cards. Refresh and try again.' });
  const previous = data.decks[player] || [];
  if (previous.length !== ids.length || previous.some(id => !ids.includes(id))) delete data.combat.players[player];
  data.decks[player] = ids; await writeData(data); res.json({ ok: true, deck: ids });
});
app.post('/api/upload', adminOnly, imageUpload.fields([{ name: 'fronts', maxCount: 100 }, { name: 'backs', maxCount: 100 }]), async (req, res) => {
  const fronts = req.files?.fronts || []; const backs = req.files?.backs || [];
  if (!fronts.length || fronts.length !== backs.length) {

    return res.status(400).json({ error: 'Each card needs one front and one back image.' });
  }
  const added = await storePairs(fronts, backs);
  const data = await readData(); data.cards.push(...added);
  try { await writeData(data); } catch (e) { await removeImages(added); throw e; }
  res.json({ ok: true, added: added.length });
});
app.delete('/api/cards/:id', adminOnly, async (req, res) => {
  const data = await readData(); const card = data.cards.find(c => c.id === req.params.id);
  if (!card) return res.status(404).json({ error: 'Card not found.' });
  data.cards = data.cards.filter(c => c.id !== req.params.id);
  for (const [player, deck] of Object.entries(data.decks)) { data.decks[player] = deck.filter(id => id !== card.id); delete data.combat.players[player]; }
  for (const [player, ids] of Object.entries(data.unlocks)) data.unlocks[player] = ids.filter(id => id !== card.id);
  await writeData(data); await removeImages([card]); res.json({ ok: true });
});

// Enemy cards live in a *different* library from player cards.
// Only the GM can view the enemy card catalog; everyone can see deployed arena cards.
app.get('/api/gm/enemies', adminOnly, async (_req, res) => {
  const data = await readData();
  res.json({ enemies: data.enemies, activeEnemyId: data.arena.enemyId, visibleCardIds: [...new Set(data.arena.instances.map(x => x.cardId))] });
});
app.post('/api/gm/verify', adminOnly, async (_req, res) => res.json({ ok: true }));
app.post('/api/gm/enemies', adminOnly, async (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim().slice(0, 48) : '';
  if (!name) return res.status(400).json({ error: 'Enter a name for this enemy type.' });
  const data = await readData();
  const enemy = { id: crypto.randomUUID(), name, cards: [] };
  data.enemies.push(enemy); await writeData(data); res.json({ ok: true, enemy });
});
app.delete('/api/gm/enemies/:id', adminOnly, async (req, res) => {
  const data = await readData(); const enemy = data.enemies.find(e => e.id === req.params.id);
  if (!enemy) return res.status(404).json({ error: 'Enemy type not found.' });
  data.enemies = data.enemies.filter(e => e.id !== enemy.id);
  if (data.arena.enemyId === enemy.id) data.arena = { enemyId: null, cardIds: [], instances: [], updatedAt: Date.now() };
  await writeData(data); await removeImages(enemy.cards); res.json({ ok: true });
});
app.post('/api/gm/enemies/:id/cards', adminOnly,
  imageUpload.fields([{ name: 'fronts', maxCount: 100 }, { name: 'backs', maxCount: 100 }]), async (req, res) => {
    const fronts = req.files?.fronts || []; const backs = req.files?.backs || [];
    const data = await readData(); const enemy = data.enemies.find(e => e.id === req.params.id);
    if (!enemy || !fronts.length || fronts.length !== backs.length) {
  
      return res.status(400).json({ error: !enemy ? 'Enemy type not found.' : 'Each enemy card needs a front and back image.' });
    }
    const added = await storePairs(fronts, backs);
    enemy.cards.push(...added);
    try { await writeData(data); } catch (e) { await removeImages(added); throw e; }
    res.json({ ok: true, added: added.length });
  });
app.delete('/api/gm/enemies/:enemyId/cards/:cardId', adminOnly, async (req, res) => {
  const data = await readData(); const enemy = data.enemies.find(e => e.id === req.params.enemyId);
  const card = enemy?.cards.find(c => c.id === req.params.cardId);
  if (!card) return res.status(404).json({ error: 'Enemy card not found.' });
  enemy.cards = enemy.cards.filter(c => c.id !== card.id);
  if (data.arena.enemyId === enemy.id) { data.arena.instances = data.arena.instances.filter(x => x.cardId !== card.id); data.arena.cardIds = [...new Set(data.arena.instances.map(x => x.cardId))]; }
  data.arena.updatedAt = Date.now(); await writeData(data); await removeImages([card]); res.json({ ok: true });
});
// The old GM REVEAL/HIDE controls manage one or more copies per card type.
// Keep existing instances (including manually drawn duplicates) where possible.
app.post('/api/gm/arena', adminOnly, async (req, res) => {
  const data = await readData(); const enemyId = req.body.enemyId;
  if (enemyId === null) {
    data.arena = { enemyId: null, cardIds: [], instances: [], updatedAt: Date.now() };
    await writeData(data); return res.json({ ok: true, arena: publicArena(data) });
  }
  const enemy = data.enemies.find(e => e.id === enemyId);
  if (!enemy) return res.status(400).json({ error: 'Select a valid enemy type.' });
  if (!Array.isArray(req.body.cardIds)) return res.status(400).json({ error: 'Invalid enemy card selection.' });
  const cardIds = [...new Set(req.body.cardIds)];
  const known = new Set(enemy.cards.map(c => c.id));
  if (cardIds.some(id => !known.has(id))) return res.status(400).json({ error: 'This enemy does not have one of those cards.' });
  let instances = data.arena.enemyId === enemy.id ? data.arena.instances.filter(x => cardIds.includes(x.cardId)) : [];
  for (const cardId of cardIds) if (!instances.some(x => x.cardId === cardId)) instances.push({ instanceId: crypto.randomUUID(), cardId, used: false, targeted: false });
  data.arena = { enemyId: enemy.id, cardIds, instances, updatedAt: Date.now() };
  await writeData(data); res.json({ ok: true, arena: publicArena(data) });
});


// V8 — server-owned battle state. A player receives an independent starting hand
// of four shuffled copies; 10 copies of each equipped card form their draw pile.
// No player receives any other player's hand or the GM's unrevealed enemy cards.
function publicPlayerBattle(data, player) {
  const battle = data.combat.players[player];
  if (!battle) return null;
  const byId = new Map(data.cards.map(c => [c.id, c]));
  return { selection: battle.selection, total: battle.selection.length * 10,
    remaining: battle.drawPile.length, discarded: battle.discarded.length,
    hand: battle.hand.map(h => {
      const card = byId.get(h.cardId);
      return card && { instanceId: h.instanceId, cardId: card.id, image: card.image,
        backImage: card.backImage || null, speed: data.combat.showSpeeds ? h.speed ?? null : null, pending: !!h.pending };
    }).filter(Boolean) };
}
function visibleActions(data, player) {
  return data.combat.actions.filter(a => a.kind === 'round' || (a.kind === 'gm' ? a.targetPlayer === player : a.player === player)).slice(-25)
    .map(a => ({ ...a, speed: data.combat.showSpeeds ? a.speed : null }));
}
function recordAction(data, action) {
  const recorded = { id: crypto.randomUUID(), at: Date.now(), ...action };
  data.combat.actions.push(recorded);
  if (data.combat.actions.length > 100) data.combat.actions = data.combat.actions.slice(-100);
  return recorded.id;
}
function randomShuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}
app.post('/api/battle/start', async (req, res) => {
  const player = cleanPlayerName(req.body.player);
  const data = await readData(); const selected = (data.decks[player] || []).filter(id => unlockedIds(data, player).has(id));
  if (!player || !selected.length) return res.status(400).json({ error: 'Equip at least one unlocked card first.' });
  if (!data.combat.players[player]) {
    const drawPile = randomShuffle(selected.flatMap(id => Array(10).fill(id)));
    data.combat.players[player] = { selection: selected, hand: drawPile.splice(0, 4).map(cardId => ({cardId, instanceId: crypto.randomUUID(), speed: null})), drawPile, discarded: [], startedAt: Date.now() };
    await writeData(data);
  }
  res.json({ ok: true, battle: publicPlayerBattle(data, player) });
});
// An attack QUEUES a card for the end-of-round discard. The cards stay visible
// until the GM advances the round; they cannot be played a second time.
app.post('/api/battle/attack', async (req, res) => {
  const player = cleanPlayerName(req.body.player);
  const { instanceId, enemyInstanceId } = req.body;
  const data = await readData(); const battle = data.combat.players[player];
  const played = battle?.hand.find(c => c.instanceId === instanceId);
  if (!played) return res.status(409).json({ error: 'That card is no longer in your hand.' });
  if (played.pending) return res.status(409).json({ error: 'That card was already used this round.' });
  const enemy = currentEnemy(data);
  const enemySlot = battlefieldSlot(data, enemyInstanceId);
  const target = enemy?.cards.find(c => c.id === enemySlot?.cardId);
  if (!target) return res.status(409).json({ error: 'That enemy card is no longer on the field.' });
  const attackingCard = data.cards.find(c => c.id === played.cardId);
  if (!attackingCard || !unlockedIds(data, player).has(played.cardId)) return res.status(403).json({ error: 'This card is no longer available to you.' });
  played.pending = true;
  // Record the *instance*, not only the card type: duplicated images must be
  // independently undoable, and two players can target the same enemy copy.
  const actionId = recordAction(data, { kind: 'player', round: data.combat.round, player,
    attackerInstanceId: played.instanceId, enemyInstanceId: enemySlot.instanceId,
    actorImage: attackingCard.image, targetImage: target.image,
    enemyName: enemy.name, speed: played.speed ?? null });
  played.queuedActionId = actionId;
  played.targetEnemyInstanceId = enemySlot.instanceId;
  enemySlot.targeted = true;
  data.arena.updatedAt = Date.now();
  await writeData(data);
  res.json({ ok: true, battle: publicPlayerBattle(data, player), arena: publicArena(data) });
});
// Players may take back an attack *before* the GM ends the current round.
// Undo is bound to the player's specific card instance, never the card image.
app.post('/api/battle/undo-attack', async (req, res) => {
  const player = cleanPlayerName(req.body.player);
  const instanceId = req.body.instanceId;
  const data = await readData();
  const battle = data.combat.players[player];
  const played = battle?.hand.find(c => c.instanceId === instanceId);
  if (!played || !played.pending) return res.status(409).json({ error: 'That card is not awaiting discard.' });
  const action = data.combat.actions.find(a => a.id === played.queuedActionId &&
    a.kind === 'player' && a.player === player && a.attackerInstanceId === instanceId &&
    a.round === data.combat.round);
  if (!action) return res.status(409).json({ error: 'This attack cannot be undone (it may be from an older version). Start a new attack after the next round.' });
  played.pending = false;
  delete played.queuedActionId;
  delete played.targetEnemyInstanceId;
  data.combat.actions = data.combat.actions.filter(a => a.id !== action.id);
  const slot = battlefieldSlot(data, action.enemyInstanceId);
  if (slot) {
    // Never clear the enemy's target flag if another player still targets it.
    slot.targeted = Object.values(data.combat.players).some(b =>
      b.hand.some(c => c.pending && c.targetEnemyInstanceId === slot.instanceId));
  }
  data.arena.updatedAt = Date.now();
  await writeData(data);
  res.json({ ok: true, battle: publicPlayerBattle(data, player), arena: publicArena(data) });
});

app.get('/api/gm/combat', adminOnly, async (_req, res) => {
  const data = await readData();
  const players = Object.entries(data.combat.players).map(([name, battle]) => ({ name,
    total: battle.selection.length * 10, remaining: battle.drawPile.length,
    discarded: battle.discarded.length, hand: battle.hand.map(h => {
      const card = data.cards.find(c => c.id === h.cardId);
      return card && { instanceId: h.instanceId, cardId: card.id,
        image: card.image, backImage: card.backImage || null, speed: h.speed ?? null, pending: !!h.pending };
    }).filter(Boolean) }));
  res.json({ players, actions: data.combat.actions.slice(-50),
    showSpeeds: data.combat.showSpeeds, enemySpeeds: data.combat.enemySpeeds,
    round: data.combat.round, emotionLevel: data.combat.emotionLevel,
    lastRoundSummary: data.combat.lastRoundSummary || null, enemyDiscarded: data.combat.enemyDiscarded });
});
app.post('/api/gm/combat/attack', adminOnly, async (req, res) => {
  const { enemyInstanceId, targetInstanceId } = req.body;
  const player = cleanPlayerName(req.body.targetPlayer);
  const data = await readData();
  const enemy = currentEnemy(data);
  const slot = battlefieldSlot(data, enemyInstanceId);
  const attackingCard = enemy?.cards.find(c => c.id === slot?.cardId);
  const battle = data.combat.players[player];
  const target = battle?.hand.find(c => c.instanceId === targetInstanceId);
  if (!attackingCard) return res.status(409).json({ error: 'Enemy attacking card is not on the field.' });
  if (slot.used) return res.status(409).json({ error: 'That enemy card was already used this round.' });
  if (!target) return res.status(409).json({ error: 'Target card is no longer in that player’s hand.' });
  const targetCard = data.cards.find(c => c.id === target.cardId);
  if (!targetCard) return res.status(409).json({ error: 'Target combat card not found.' });
  slot.used = true;
  data.arena.updatedAt = Date.now();
  recordAction(data, { kind: 'gm', round: data.combat.round, player: 'GM', enemyName: enemy.name,
    targetPlayer: player, actorImage: attackingCard.image,
    targetImage: targetCard.image, speed: data.combat.enemySpeeds[enemyInstanceId] ?? data.combat.enemySpeeds[slot.cardId] ?? null });
  await writeData(data);
  res.json({ ok: true, arena: publicArena(data) });
});
// One GM-controlled emotion level for all players. The current level governs
// the automatic draw when the next round begins.
app.post('/api/gm/combat/emotion', adminOnly, async (req, res) => {
  const level = req.body.level;
  if (!Number.isInteger(level) || level < 1 || level > 5)
    return res.status(400).json({ error: 'Emotion level must be 1 through 5.' });
  const data = await readData(); data.combat.emotionLevel = level;
  await writeData(data); res.json({ ok: true, emotionLevel: level, drawCount: drawCountForEmotion(level) });
});
// End-of-round processing: discard played player instances AND enemy instances
// either played by the GM or targeted by a player. All other cards remain.
app.post('/api/gm/combat/end-round', adminOnly, async (req, res) => {
  const data = await readData(); const finishedRound = data.combat.round;
  // An old or delayed click must not advance an already completed round.
  if (Number.isInteger(req.body?.expectedRound) && req.body.expectedRound !== finishedRound)
    return res.status(409).json({ error: `Round ${req.body.expectedRound} already ended; now on round ${finishedRound}. Reloaded battle state before retrying.` });
  const requested = drawCountForEmotion(data.combat.emotionLevel);
  const playerResults = [];
  for (const [player, battle] of Object.entries(data.combat.players)) {
    const used = battle.hand.filter(c => c.pending);
    battle.discarded.push(...used.map(c => c.cardId));
    battle.hand = battle.hand.filter(c => !c.pending);
    const cards = battle.drawPile.splice(0, requested);
    battle.hand.push(...cards.map(cardId => ({ cardId, instanceId: crypto.randomUUID(), speed: null, pending: false })));
    playerResults.push({ player, discarded: used.length, drawn: cards.length, handCount: battle.hand.length, remaining: battle.drawPile.length });
  }
  const usedEnemySlots = data.arena.instances.filter(x => x.used || x.targeted);
  data.arena.instances = data.arena.instances.filter(x => !x.used && !x.targeted);
  data.arena.cardIds = [...new Set(data.arena.instances.map(x => x.cardId))];
  for (const used of usedEnemySlots) delete data.combat.enemySpeeds[used.instanceId];
  data.combat.enemyDiscarded += usedEnemySlots.length;
  data.arena.updatedAt = Date.now();
  data.combat.round++;
  const summary = { finishedRound, round: data.combat.round, emotionLevel: data.combat.emotionLevel,
    requestedDraw: requested, enemyDiscarded: usedEnemySlots.length, players: playerResults, at: Date.now() };
  data.combat.lastRoundSummary = summary;
  recordAction(data, { kind: 'round', round: data.combat.round, summary });
  await writeData(data);
  res.json({ ok: true, summary, arena: publicArena(data) });
});
// Enemy supply is unlimited: the GM can draw a random enemy card or select a
// specific card. Each is a distinct, separately playable field instance.
app.post('/api/gm/combat/enemy-draw', adminOnly, async (req, res) => {
  const data = await readData();
  const requestedEnemyId = req.body.enemyId;
  const enemy = data.enemies.find(e => e.id === (requestedEnemyId || data.arena.enemyId));
  if (!enemy || !enemy.cards.length) return res.status(409).json({ error: 'Select an enemy type with at least one card first.' });
  // Selecting a different enemy type starts its own fresh field.
  if (data.arena.enemyId !== enemy.id) {
    data.arena = { enemyId: enemy.id, cardIds: [], instances: [], updatedAt: Date.now() };
  }
  const count = req.body.count === undefined ? 1 : req.body.count;
  if (!Number.isInteger(count) || count < 1 || count > 20) return res.status(400).json({ error: 'Draw 1–20 enemy cards per click. You can repeat without a total limit.' });
  const specific = req.body.cardId;
  if (specific && !enemy.cards.some(c => c.id === specific)) return res.status(400).json({ error: 'This card is not in the selected enemy type.' });
  for (let i = 0; i < count; i++) {
    const cardId = specific || enemy.cards[crypto.randomInt(enemy.cards.length)].id;
    data.arena.instances.push({ instanceId: crypto.randomUUID(), cardId, used: false, targeted: false });
  }
  data.arena.cardIds = [...new Set(data.arena.instances.map(x => x.cardId))];
  data.arena.updatedAt = Date.now(); await writeData(data);
  res.json({ ok: true, drawn: count, arena: publicArena(data) });
});
app.post('/api/gm/combat/show-speeds', adminOnly, async (req, res) => {
  if (typeof req.body.show !== 'boolean') return res.status(400).json({ error: 'Provide show: true or false.' });
  const data = await readData(); data.combat.showSpeeds = req.body.show;
  await writeData(data); res.json({ ok: true, showSpeeds: data.combat.showSpeeds });
});
app.post('/api/gm/combat/speed', adminOnly, async (req, res) => {
  const { scope, cardId, instanceId, speed } = req.body;
  if (!(speed === null || (Number.isInteger(speed) && speed >= 0 && speed <= 99)))
    return res.status(400).json({ error: 'Speed must be a whole number from 0 to 99, or left empty.' });
  const data = await readData();
  if (scope === 'enemy') {
    const slot = battlefieldSlot(data, instanceId);
    if (!slot || (cardId && slot.cardId !== cardId)) return res.status(409).json({ error: 'This enemy card is not revealed.' });
    if (speed === null) delete data.combat.enemySpeeds[instanceId];
    else data.combat.enemySpeeds[instanceId] = speed;
  } else if (scope === 'player') {
    const player = cleanPlayerName(req.body.player);
    const handCard = data.combat.players[player]?.hand.find(h => h.instanceId === instanceId);
    if (!handCard) return res.status(409).json({ error: 'Player hand card is no longer present.' });
    handCard.speed = speed;
  } else return res.status(400).json({ error: 'Unknown speed scope.' });
  await writeData(data); res.json({ ok: true });
});
app.post('/api/gm/combat/reset', adminOnly, async (_req, res) => {
  const data = await readData();
  data.combat.players = {};
  data.combat.actions = [];
  data.combat.enemySpeeds = {};
  data.combat.round = 1;
  data.combat.enemyDiscarded = 0;
  data.combat.lastRoundSummary = null;
  // Reset just the current battle cards, preserving the saved enemy catalogs.
  data.arena.instances = data.arena.instances.map(x => ({ ...x, used: false, targeted: false }));
  await writeData(data); res.json({ ok: true });
});
app.post('/api/gm/combat/clear-feed', adminOnly, async (_req, res) => {
  const data = await readData(); data.combat.actions = [];
  await writeData(data); res.json({ ok: true });
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (images: 12 MB each; music: 40 MB).' : err.message });
  console.error('Request failed:', err.message);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Server storage or database request failed. Please retry.' });
});
app.get('/health', (_req, res) => res.json({ ok: true, storage: mediaStore.isCloud ? 'supabase' : 'local' }));
async function start() {
  // Fail startup rather than silently serving an empty game on DB outage.
  await mediaStore.checkConnection();
  app.listen(PORT, '0.0.0.0', () => console.log(`Project Moon Card Hub running at http://localhost:${PORT} [${mediaStore.isCloud ? 'Supabase' : 'local'}]`));
}
if (require.main === module) start().catch(error => { console.error('Startup failed:', error.message); process.exitCode = 1; });
module.exports = { app, start };

const $ = (s) => document.querySelector(s);
const state = { cards: [], deck: [], player: localStorage.getItem('pm-card-player') || '', activeTab: 'library', adminPassword: sessionStorage.getItem('pm-card-admin') || '', flipped: new Set(), pairCount: 1, zoomedCard: null, battle: null, arena: {enemyId:null,enemyName:null,cards:[]}, enemies: [], gmUnlocked: false, gmEnemyId: '', editEnemyId: '', enemyPairCount: 1, music: null, gmCards: [], gmPlayers: [], gmUnlocks: {}, gmSelectedPlayer: '', selectedHandInstance: null, gmSelectedEnemyCard: null, combatActions: [], gmCombat: { players: [], actions: [], showSpeeds: false, enemySpeeds: {} }, showSpeeds: false, actionPending: false, round: 1, emotionLevel: 1, lastRoundSummary: null };
let toastTimer;
function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2600); }
function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
async function request(url, options = {}) { const res = await fetch(url, options); const data = await res.json().catch(() => ({})); if (!res.ok) throw new Error(data.error || 'Request failed.'); return data; }
function setStatus(text, ok = false) { $('#playerStatus').textContent = text; $('#playerStatus').classList.toggle('ok', ok); }
function chosen(id) { return state.deck.includes(id); }
function updateCounts() { $('#deckCount').textContent = state.deck.length; $('#deckTabCount').textContent = `${state.deck.length}/5`; $('#counterFill').style.width = `${state.deck.length * 20}%`; $('#libraryCount').textContent = state.cards.length; }
function cardMarkup(card, inDeck = false) {
  const selected = chosen(card.id);
  const flipped = state.flipped.has(card.id);
  const hasBack = !!card.backImage;
  const face = flipped && hasBack ? card.backImage : card.image;
  return `<article class="combat-card ${selected ? 'selected' : ''}" data-card="${esc(card.id)}" tabindex="0" role="button" aria-label="${selected ? 'Remove' : 'Add'} card">
    ${selected ? '<span class="card-check">✓</span>' : ''}
    <div class="card-face ${flipped && hasBack ? 'is-flipped' : ''}"><img loading="lazy" src="${esc(face)}" alt="Combat card ${flipped ? 'back' : 'front'}"></div>
    <button class="zoom-button" type="button" data-zoom="${esc(card.id)}" aria-label="Zoom in on card" title="Zoom in">⛶</button>
    ${hasBack ? `<button class="flip-button" type="button" data-flip="${esc(card.id)}" aria-label="Flip card" title="Flip card">↻</button>` : ''}
    <div class="card-meta"><span>${selected ? 'IN YOUR DECK' : 'COMBAT CARD'}</span><span>${inDeck || selected ? 'REMOVE −' : 'ADD +'}</span></div>
  </article>`;
}
function findAnyCard(id) { return state.gmCards.find(c => c.id === id) || state.cards.find(c => c.id === id) || state.arena.cards.find(c => c.id === id) || state.enemies.flatMap(e => e.cards).find(c => c.id === id); }
function renderZoom() {
  const modal = $('#zoomModal');
  const card = findAnyCard(state.zoomedCard);
  if (!card) { modal.classList.add('hidden'); document.body.classList.remove('zoom-open'); return; }
  const flipped = state.flipped.has(card.id) && !!card.backImage;
  $('#zoomImage').src = flipped ? card.backImage : card.image;
  $('#zoomImage').alt = `Combat card ${flipped ? 'back' : 'front'}, enlarged`;
  $('#zoomFlip').classList.toggle('hidden', !card.backImage);
  modal.classList.remove('hidden');
  document.body.classList.add('zoom-open');
}
function openZoom(id) { state.zoomedCard = id; renderZoom(); $('#zoomOut').focus(); }
function closeZoom() { state.zoomedCard = null; renderZoom(); }
function toggleFlip(id) {
  if (state.flipped.has(id)) state.flipped.delete(id); else state.flipped.add(id);
  render();
  if (state.zoomedCard) {
    const img = $('#zoomImage');
    img.classList.remove('zoom-flipping');
    void img.offsetWidth;
    img.classList.add('zoom-flipping');
    renderZoom();
  }
}

// V8: hand instances are controlled by the server, so the GM can receive
// authentic card-use messages and the same card cannot be used twice.
function battleStorageKey() { return `pm-card-battle-v1:${state.player}`; }
function restoreBattle() { /* Legacy V4 session hands are replaced with server-owned hands. */ }
async function enterBattle() {
  if (!state.player) { toast('Load your player deck before entering battle.'); $('#playerName').focus(); return; }
  if (!state.deck.length) { toast('Equip at least one card in MY DECK first.'); return; }
  if (!state.battle) {
    try {
      const data = await request('/api/battle/start', {method:'POST', headers:{'Content-Type':'application/json'},body:JSON.stringify({player:state.player})});
      state.battle = data.battle;
      state.selectedHandInstance = null;
      render(); toast('Battle started. Select a hand card, then an enemy card.');
    } catch(err) { toast(err.message); }
  } else render();
}
function speedBadge(value) {
  return state.showSpeeds && value !== null && value !== undefined
    ? `<div class="speed-badge" aria-label="Speed ${value}">SPD <strong>${Number(value)}</strong></div>` : '';
}
function battleCardMarkup(card, copyIndex) {
  const flipped = state.flipped.has(card.cardId) && !!card.backImage;
  const selected = state.selectedHandInstance === card.instanceId;
  const pending = !!card.pending;
  return `<article class="combat-card battle-card playable-card ${selected ? 'combat-picked' : ''} ${pending ? 'round-pending' : ''}" ${pending ? '' : `data-hand-instance="${esc(card.instanceId)}"`} tabindex="${pending ? -1 : 0}" role="button" aria-pressed="${selected}" aria-label="${pending ? 'Already used; awaiting end of round' : selected ? 'Cancel selected card' : 'Select this card to attack'}: hand card ${copyIndex + 1}">
    ${speedBadge(card.speed)}
    <div class="card-face ${flipped ? 'is-flipped' : ''}"><img loading="lazy" src="${esc(flipped ? card.backImage : card.image)}" alt="Your combat card ${flipped ? 'back' : 'front'}"></div>
    ${pending ? `<div class="pending-ribbon">USED · DISCARD AT ROUND END</div><button class="undo-attack-button" type="button" data-undo-attack="${esc(card.instanceId)}" aria-label="Undo this card attack" title="Cancel the queued attack and keep this card">↶ UNDO ATTACK</button>` : ''}
    <button class="zoom-button" type="button" data-zoom="${esc(card.cardId)}" aria-label="Zoom card" title="Zoom card">⛶</button>
    ${card.backImage ? `<button class="flip-button" type="button" data-flip="${esc(card.cardId)}" aria-label="Flip card" title="Flip card">↻</button>` : ''}
    <div class="card-meta"><span>HAND CARD ${copyIndex + 1}</span><span>${pending ? 'QUEUED' : selected ? 'SELECTED ✓' : 'SELECT TO USE'}</span></div>
  </article>`;
}
function renderBattle() {
  const battle = state.battle;
  $('#battleWaiting').classList.toggle('hidden', !!battle);
  $('#battleActive').classList.toggle('hidden', !battle);
  $('#startBattle').textContent = battle ? 'BATTLE STARTED' : 'ENTER BATTLE';
  $('#startBattle').disabled = !!battle;
  if (!battle) return;
  $('#battleRound').textContent = state.round;
  $('#battleEmotion').textContent = state.emotionLevel;
  $('#battleNextDraw').textContent = emotionDrawCount(state.emotionLevel);
  $('#battleTotal').textContent = battle.total;
  $('#battleHandCount').textContent = battle.hand.length;
  $('#battleRemaining').textContent = battle.remaining;
  $('#battleDiscarded').textContent = `${battle.discarded} discarded`;
  $('#battleHand').innerHTML = battle.hand.map(battleCardMarkup).join('');
  const queued = battle.hand.filter(c => c.pending).length;
  $('#playerAttackInstruction').textContent = state.selectedHandInstance
    ? 'CARD READY — now click an enemy card to attack. Click your selected card to cancel.'
    : queued ? `${queued} CARD${queued === 1 ? '' : 'S'} QUEUED. Tap UNDO ATTACK on any used card to cancel it before the GM ends the round.`
    : 'CLICK ONE OF YOUR CARDS TO SELECT IT, THEN CLICK AN ENEMY CARD TO ATTACK.';
  const summary = state.lastRoundSummary;
  const own = summary?.players?.find(p => p.player === state.player);
  $('#battleRoundResult').textContent = own && summary.round === state.round
    ? `Last round: ${own.discarded} card${own.discarded === 1 ? '' : 's'} discarded, ${own.drawn} drawn.`
    : '';
}
function renderCombatFeed() {
  const own = $('#playerCombatFeed');
  const gm = $('#gmCombatFeed');
  if (own) own.innerHTML = actionFeedHtml(state.combatActions, false);
  if (gm && state.gmUnlocked) gm.innerHTML = actionFeedHtml(state.gmCombat.actions, true);
}
function actionFeedHtml(events, gmView) {
  const visible = (events || []).slice(-18).reverse();
  return visible.length ? visible.map(a => {
    if (a.kind === 'round') {
      const summary = a.summary || {};
      return `<div class="combat-event round-event"><div class="combat-event-text"><strong>ROUND ${Number(summary.finishedRound || 0)} ENDED · ROUND ${Number(summary.round || 0)} STARTED</strong><small>Emotion ${Number(summary.emotionLevel || 1)} · ${Number(summary.requestedDraw || 1)} draw${summary.requestedDraw === 1 ? '' : 's'} per player · ${Number(summary.enemyDiscarded || 0)} enemy cards discarded</small></div></div>`;
    }
    const label = a.kind === 'player'
      ? `${esc(a.player)} used this card to attack ${esc(a.enemyName || 'the enemy')}`
      : `${esc(a.enemyName || 'Enemy')} used this card to attack ${esc(a.targetPlayer)}'s card`;
    return `<div class="combat-event"><div class="combat-event-text"><strong>${label}</strong><small>${new Date(a.at).toLocaleTimeString()}${a.speed === null || a.speed === undefined ? '' : ` · speed ${a.speed}`}</small></div><div class="combat-event-images"><img src="${esc(a.actorImage)}" alt="Attacking combat card"><span class="combat-arrow">→</span><img src="${esc(a.targetImage)}" alt="Target combat card"></div></div>`;
  }).join('') : `<p class="muted small">No combat actions yet${gmView ? '. Player card attacks will appear here automatically.' : '.'}</p>`;
}
async function playerAttack(enemyCardId) {
  if (!state.selectedHandInstance || state.actionPending) return;
  state.actionPending = true;
  const selectedId = state.selectedHandInstance;
  try {
    const data = await request('/api/battle/attack', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({player:state.player, instanceId:selectedId,enemyInstanceId:enemyCardId})});
    state.battle = data.battle;
    state.selectedHandInstance = null;
    await refresh();
    toast('Attack queued! Your card and its enemy target discard when the GM ends the round.');
  } catch(err) { toast(err.message); await refresh(); }
  finally { state.actionPending = false; }
}
async function undoPlayerAttack(instanceId) {
  if (state.actionPending || !state.player) return;
  state.actionPending = true;
  try {
    const data = await request('/api/battle/undo-attack', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({player: state.player, instanceId})
    });
    state.battle = data.battle;
    state.selectedHandInstance = null;
    await refresh();
    toast('Attack canceled. Your card is available to use again.');
  } catch (err) { toast(err.message); await refresh().catch(() => {}); }
  finally { state.actionPending = false; }
}
async function gmAttack(targetPlayer, targetInstanceId) {
  if (!state.gmSelectedEnemyCard || state.actionPending) return;
  state.actionPending = true;
  try {
    const data = await request('/api/gm/combat/attack',gmJson({enemyInstanceId:state.gmSelectedEnemyCard,targetPlayer,targetInstanceId}));
    state.arena = data.arena;
    state.gmSelectedEnemyCard = null;
    await Promise.all([refresh(), refreshGmCombat()]);
    toast('Enemy attack queued for discard at round end. Player target remains.');
  } catch(err) { toast(err.message); await Promise.all([refresh(),refreshGmCombat()]); }
  finally { state.actionPending = false; }
}
function chooseHandCard(instanceId) {
  if (!state.battle?.hand.some(c => c.instanceId === instanceId && !c.pending)) return;
  state.selectedHandInstance = state.selectedHandInstance === instanceId ? null : instanceId;
  state.gmSelectedEnemyCard = null;
  render();
}

function render() {
  updateCounts();
  const query = $('#search').value.trim().toLowerCase();
  const filtered = state.cards.filter(c => (c.originalName || '').toLowerCase().includes(query));
  $('#library').innerHTML = filtered.map(c => cardMarkup(c)).join('');
  $('#emptyLibrary').classList.toggle('hidden', state.cards.length > 0);
  $('#deckGrid').innerHTML = state.cards.filter(c => chosen(c.id)).map(c => cardMarkup(c, true)).join('');
  $('#emptyDeck').classList.toggle('hidden', state.deck.length > 0);
  $('#libraryView').classList.toggle('hidden', state.activeTab !== 'library');
  $('#deckView').classList.toggle('hidden', state.activeTab !== 'deck');
  $('#battleView').classList.toggle('hidden', state.activeTab !== 'battle');
  renderBattle();
  renderEnemyArena();
  renderGmBattle();
  renderGmHands();
  renderGmSpeeds();
  renderCombatFeed();
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === state.activeTab));
  renderManageCards();
  if (state.zoomedCard) renderZoom();
}
function renderManageCards() { $('#manageCards').innerHTML = state.gmCards.map(c => `<div class="manage-card"><div class="manage-pair"><img src="${esc(c.image)}" alt="Card front"><img src="${esc(c.backImage || c.image)}" alt="Card back"></div><button title="Remove card" data-delete="${esc(c.id)}">×</button></div>`).join('') || '<p class="muted small">No cards uploaded to your vault yet.</p>'; }
async function refresh() {
  const data = await request(`/api/state?player=${encodeURIComponent(state.player)}`);
  state.cards = data.cards || [];
  state.arena = data.arena || { enemyId: null, enemyName: null, cards: [] };
  syncMusic(data.music || null);
  if (state.zoomedCard && !findAnyCard(state.zoomedCard)) closeZoom();
  state.deck = (data.deck || []).filter(id => state.cards.some(c => c.id === id)).slice(0, 5);
  state.battle = data.battle || null;
  state.combatActions = data.combatActions || [];
  state.showSpeeds = !!data.showSpeeds;
  state.round = data.round || 1;
  state.emotionLevel = data.emotionLevel || 1;
  state.lastRoundSummary = data.lastRoundSummary || null;
  if (state.selectedHandInstance && !state.battle?.hand.some(c => c.instanceId === state.selectedHandInstance && !c.pending)) state.selectedHandInstance = null;
  if (state.gmSelectedEnemyCard && !state.arena.cards.some(c => c.instanceId === state.gmSelectedEnemyCard && !c.used)) state.gmSelectedEnemyCard = null;
  render();
}
async function saveDeck() {
  if (!state.player) { toast('Enter your player name first.'); return false; }
  try { await request('/api/deck', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({player:state.player, cardIds:state.deck}) }); setStatus(`Deck saved for ${state.player}.`, true); return true; }
  catch(e) { toast(e.message); return false; }
}
async function toggleCard(id) {
  if (!state.player) { toast('Enter your player name and click LOAD DECK first.'); $('#playerName').focus(); return; }
  if (chosen(id)) state.deck = state.deck.filter(x => x !== id);
  else { if (state.deck.length >= 5) { toast('Deck limit reached — remove a card before adding another.'); return; } state.deck.push(id); }
  if (state.battle) { state.battle = null; state.selectedHandInstance = null; }
  render(); await saveDeck();
}
$('#loadPlayer').addEventListener('click', async () => {
  const name = $('#playerName').value.trim().replace(/[<>\u0000-\u001f]/g, '').slice(0,24);
  if (!name) { setStatus('Please enter a player name.'); return; }
  await request('/api/player/register', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({player:name}) }).catch(e => { toast(e.message); });
  state.player = name; localStorage.setItem('pm-card-player', name);
  state.battle = null; state.selectedHandInstance = null;
  try { await refresh(); render(); setStatus(`Loaded deck for ${name}.`, true); toast(`Welcome, ${name}.`); }
  catch(e) { setStatus(e.message); }
});
$('#playerName').value = state.player;
$('#playerName').addEventListener('keydown', e => { if (e.key === 'Enter') $('#loadPlayer').click(); });
$('#search').addEventListener('input', render);
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => { state.activeTab = t.dataset.tab; render(); if (state.activeTab === 'battle' && state.player) enterBattle(); }));
$('#startBattle').addEventListener('click', enterBattle);
document.addEventListener('click', async e => {
  const zoom = e.target.closest('[data-zoom]');
  if (zoom) { e.preventDefault(); e.stopPropagation(); openZoom(zoom.dataset.zoom); return; }
  if (e.target.closest('#zoomOut, [data-zoom-close]')) { e.preventDefault(); closeZoom(); return; }
  if (e.target.closest('#zoomFlip')) { e.preventDefault(); if (state.zoomedCard) toggleFlip(state.zoomedCard); return; }
  const flip = e.target.closest('[data-flip]');
  if (flip) { e.preventDefault(); e.stopPropagation(); toggleFlip(flip.dataset.flip); return; }
  const undoAttack = e.target.closest('[data-undo-attack]');
  if (undoAttack) { e.preventDefault(); e.stopPropagation(); await undoPlayerAttack(undoAttack.dataset.undoAttack); return; }
  const useEnemy = e.target.closest('[data-gm-attack]');
  if (useEnemy) { e.preventDefault(); e.stopPropagation(); if (!state.gmUnlocked) return;
    const id = useEnemy.dataset.gmAttack;
    state.gmSelectedEnemyCard = state.gmSelectedEnemyCard === id ? null : id;
    state.selectedHandInstance = null; render();
    toast(state.gmSelectedEnemyCard ? 'Enemy selected. Click a player hand card below to attack.' : 'Enemy card selection canceled.');
    return;
  }
  const targetEnemy = e.target.closest('[data-enemy-target]');
  if (targetEnemy) { e.preventDefault(); if (state.selectedHandInstance) await playerAttack(targetEnemy.dataset.enemyTarget);
    else toast('First select one card from your hand.'); return; }
  const hand = e.target.closest('[data-hand-instance]');
  if (hand) { e.preventDefault(); chooseHandCard(hand.dataset.handInstance); return; }
  const gmTarget = e.target.closest('[data-gm-target]');
  if (gmTarget) { e.preventDefault(); if (!state.gmSelectedEnemyCard) return toast('First select an enemy card using ATTACK WITH THIS.');
    await gmAttack(gmTarget.dataset.player, gmTarget.dataset.gmTarget); return; }
  const card = e.target.closest('[data-card]');
  if (card) { await toggleCard(card.dataset.card); return; }
  const del = e.target.closest('[data-delete]');
  if (del) {
    if (!confirm('Permanently delete this card from the GM vault AND all player collections/decks?')) return;
    try { await request(`/api/cards/${encodeURIComponent(del.dataset.delete)}`, {method:'DELETE', headers:{'x-admin-password':state.adminPassword}}); await loadGmCards(); await refresh(); toast('Card permanently deleted from the vault.'); }
    catch(err) { toast(err.message); }
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && state.zoomedCard) { closeZoom(); } });
document.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-hand-instance], [data-enemy-target]')) { e.preventDefault(); e.target.click(); } });
document.addEventListener('keydown', async e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-card]')) { e.preventDefault(); await toggleCard(e.target.dataset.card); } });
$('#clearDeck').addEventListener('click', async () => { if (!state.deck.length) return; if (!confirm('Remove all cards from your deck?')) return; state.deck = []; state.battle = null; state.selectedHandInstance = null; render(); await saveDeck(); });
$('#gmOpen').addEventListener('click', () => openGmModal());
document.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', () => $('#gmModal').classList.add('hidden')));
function addUploadPair() {
  const index = state.pairCount++;
  const row = document.createElement('div');
  row.className = 'upload-pair';
  row.dataset.pair = String(index);
  row.innerHTML = `<div class="pair-heading"><b>CARD PAIR ${index}</b>${index > 1 ? '<button type="button" class="remove-pair" data-remove-pair>REMOVE</button>' : ''}</div><div class="pair-inputs"><label class="mini-upload"><span>FRONT IMAGE</span><input type="file" accept="image/*" data-front required><small data-front-name>No front selected</small></label><label class="mini-upload"><span>BACK IMAGE</span><input type="file" accept="image/*" data-back required><small data-back-name>No back selected</small></label></div>`;
  $('#uploadPairs').appendChild(row);
}
addUploadPair();
$('#addPair').addEventListener('click', addUploadPair);
$('#uploadPairs').addEventListener('change', () => {
  const rows = [...document.querySelectorAll('.upload-pair')];
  let complete = 0;
  rows.forEach(row => {
    const front = row.querySelector('[data-front]').files[0];
    const back = row.querySelector('[data-back]').files[0];
    row.querySelector('[data-front-name]').textContent = front ? front.name : 'No front selected';
    row.querySelector('[data-back-name]').textContent = back ? back.name : 'No back selected';
    if (front && back) complete++;
  });
  $('#fileList').textContent = `${complete} of ${rows.length} card pair${rows.length === 1 ? '' : 's'} ready.`;
});
$('#uploadPairs').addEventListener('click', e => {
  const remove = e.target.closest('[data-remove-pair]');
  if (remove) { remove.closest('.upload-pair').remove(); $('#uploadPairs').dispatchEvent(new Event('change')); }
});
$('#uploadButton').addEventListener('click', async () => {
  const password = $('#adminPassword').value;
  const rows = [...document.querySelectorAll('.upload-pair')];
  if (!password) { toast('Enter the GM password.'); return; }
  if (!rows.length) { toast('Add at least one card pair.'); return; }
  const form = new FormData();
  for (const row of rows) {
    const front = row.querySelector('[data-front]').files[0];
    const back = row.querySelector('[data-back]').files[0];
    if (!front || !back) { toast('Every card needs both a front and a back image.'); return; }
    form.append('fronts', front); form.append('backs', back);
  }
  const button = $('#uploadButton'); button.disabled = true; button.textContent = 'UPLOADING…';
  try {
    const result = await request('/api/upload', {method:'POST', headers:{'x-admin-password':password}, body:form});
    state.adminPassword = password; sessionStorage.setItem('pm-card-admin', password);
    state.gmUnlocked = true; $('#enemySetup').classList.remove('hidden'); $('#gmVaultSetup').classList.remove('hidden'); $('#gmBattleTools').classList.remove('hidden'); $('#gmMusicSetup').classList.remove('hidden');
    await Promise.all([loadGmEnemies(), loadGmCards()]);
    $('#uploadPairs').innerHTML = ''; state.pairCount = 1; addUploadPair(); $('#fileList').textContent = 'Add a front and back image for each card.';
    await loadGmCards(); await refresh(); toast(`${result.added} card pair${result.added === 1 ? '' : 's'} added privately to your GM vault.`);
  } catch(e) { toast(e.message); }
  finally { button.disabled = false; button.textContent = 'UPLOAD CARD PAIRS'; }
});
refresh().then(() => { if (state.player) { render(); setStatus(`Loaded deck for ${state.player}.`, true); } }).catch(e => toast(e.message));
// Refresh periodically so newly uploaded cards show up for everyone without a manual reload.
setInterval(() => { refresh().catch(() => {}); if (state.gmUnlocked) { loadGmCards().catch(() => {}); refreshGmCombat().catch(() => {}); } }, 2500);


// V5: enemy-only card collections and a GM-controlled shared arena.
// The public /api/state includes *only revealed* enemy cards.
function gmHeaders() { return { 'x-admin-password': state.adminPassword }; }
function gmJson(body) { return { method:'POST', headers:{...gmHeaders(), 'Content-Type':'application/json'}, body:JSON.stringify(body) }; }
function emotionDrawCount(level) { return level === 1 ? 1 : level === 2 ? 2 : 3; }
function arenaCardMarkup(card, index) {
  const flipped = state.flipped.has(card.id) && !!card.backImage;
  const selected = state.gmSelectedEnemyCard === card.instanceId;
  const pending = !!card.pending;
  return `<article class="combat-card battle-card enemy-field-card ${selected ? 'combat-picked gm-picked' : ''} ${pending ? 'enemy-round-pending' : ''} ${state.selectedHandInstance ? 'attack-target' : ''}" data-enemy-target="${esc(card.instanceId)}" role="button" tabindex="0" aria-label="Enemy card ${index + 1}. ${state.selectedHandInstance ? 'Click to attack' : 'Target for player attack'}">
    ${speedBadge(card.speed)}
    <div class="card-face ${flipped ? 'is-flipped' : ''}"><img loading="lazy" src="${esc(flipped ? card.backImage : card.image)}" alt="Enemy combat card ${flipped ? 'back' : 'front'}"></div>
    ${pending ? '<div class="pending-ribbon">DISCARD AT ROUND END</div>' : ''}
    <button class="zoom-button" type="button" data-zoom="${esc(card.id)}" title="Zoom in" aria-label="Zoom in on enemy card">⛶</button>
    ${card.backImage ? `<button class="flip-button" type="button" data-flip="${esc(card.id)}" title="Flip" aria-label="Flip enemy card">↻</button>` : ''}
    ${state.gmUnlocked ? `<button class="gm-use-card" type="button" ${card.used ? 'disabled' : `data-gm-attack="${esc(card.instanceId)}"`}>${card.used ? 'ATTACK QUEUED' : selected ? 'CANCEL ATTACK' : 'ATTACK WITH THIS'}</button>` : ''}
    <div class="card-meta"><span>ENEMY CARD ${index + 1}</span><span>${pending ? 'QUEUED' : selected ? 'GM SELECTED' : state.selectedHandInstance ? 'CLICK TO TARGET' : 'REVEALED'}</span></div>
  </article>`;
}

function renderEnemyArena() {
  const field = state.arena;
  const hasCards = field && field.cards && field.cards.length;
  $('#enemyArenaEmpty').classList.toggle('hidden', !!hasCards);
  $('#enemyArenaPresent').classList.toggle('hidden', !hasCards);
  $('#enemyLiveStatus').textContent = hasCards ? `${field.cards.length} VISIBLE • SYNCED FOR ALL PLAYERS` : 'SHARED WITH EVERY PLAYER';
  if (!hasCards) return;
  $('#enemyActiveName').textContent = field.enemyName || 'Unknown enemy';
  $('#enemyVisibleCount').textContent = `${field.cards.length} cards in play · ${field.cards.filter(c => c.pending).length} queued for discard`;
  $('#enemyArenaCards').innerHTML = field.cards.map(arenaCardMarkup).join('');
}
function renderGmBattle() {
  if (document.activeElement?.closest?.('[data-speed-editor]')) return;
  $('#gmBattleTools').classList.toggle('hidden', !state.gmUnlocked);
  if (!state.gmUnlocked) return;
  const sel = $('#gmEnemySelect');
  const wanted = state.gmEnemyId || state.arena.enemyId || '';
  const options = `<option value="">Choose an enemy…</option>` + state.enemies.map(e => `<option value="${esc(e.id)}">${esc(e.name)} (${e.cards.length})</option>`).join('');
  if (sel.innerHTML !== options) sel.innerHTML = options;
  if (state.enemies.some(e => e.id === wanted)) { state.gmEnemyId = wanted; sel.value = wanted; }
  else { state.gmEnemyId = ''; sel.value = ''; }
  const enemy = state.enemies.find(e => e.id === state.gmEnemyId);
  if (!enemy) {
    $('#gmEnemyRoster').innerHTML = '<p class="muted">Select an enemy type to see its cards, or create one in GM / UPLOAD CARDS.</p>';
    return;
  }
  const visible = new Set(state.arena.enemyId === enemy.id ? state.arena.cards.map(c => c.id) : []);
  $('#gmEnemyRoster').innerHTML = enemy.cards.length ? enemy.cards.map(c => `<div class="gm-roster-card ${visible.has(c.id) ? 'deployed' : ''}"><img src="${esc(c.image)}" alt="Enemy card preview"><div class="gm-roster-actions"><button type="button" data-zoom="${esc(c.id)}" class="outline-button">ZOOM</button><button type="button" data-gm-toggle="${esc(c.id)}" class="${visible.has(c.id) ? 'outline-button' : 'primary-button'}">${visible.has(c.id) ? 'HIDE' : 'REVEAL'}</button></div><button type="button" class="draw-specific-button" data-gm-draw-specific="${esc(c.id)}">＋ DRAW THIS CARD</button></div>`).join('') : '<p class="muted">This enemy has no cards yet. Upload some in GM / UPLOAD CARDS.</p>';
}
function openGmModal() {
  $('#adminPassword').value = state.adminPassword;
  $('#gmModal').classList.remove('hidden');
  renderManageCards();
  $('#enemySetup').classList.toggle('hidden', !state.gmUnlocked);
  $('#gmMusicSetup').classList.toggle('hidden', !state.gmUnlocked);
  $('#gmVaultSetup').classList.toggle('hidden', !state.gmUnlocked);
  if (state.gmUnlocked) { renderEnemyEditor(); loadGmEnemies().catch(err => toast(err.message)); loadGmCards().catch(err => toast(err.message)); refreshGmCombat().catch(err => toast(err.message)); }
}
async function unlockGm() {
  const password = $('#adminPassword').value;
  try {
    await request('/api/gm/verify', {method:'POST', headers:{'x-admin-password':password}});
    state.adminPassword = password;
    sessionStorage.setItem('pm-card-admin', password);
    state.gmUnlocked = true;
    $('#enemySetup').classList.remove('hidden');
    $('#gmMusicSetup').classList.remove('hidden');
    $('#gmVaultSetup').classList.remove('hidden');
    await Promise.all([loadGmEnemies(), loadGmCards(), refreshGmCombat()]);
    render();
    toast('GM controls unlocked.');
  } catch(err) { toast(err.message); }
}
async function loadGmEnemies() {
  if (!state.gmUnlocked) return;
  const data = await request('/api/gm/enemies', {headers:gmHeaders()});
  state.enemies = data.enemies || [];
  renderGmBattle();
  renderGmSpeeds();
  renderEnemyEditor();
}
// V7: the GM owns the full player-card vault. Individual grants determine each
// player's personal library; uploads are not made public automatically.
async function loadGmCards() {
  if (!state.gmUnlocked) return;
  const data = await request('/api/gm/cards', {headers:gmHeaders()});
  state.gmCards = data.cards || [];
  state.gmPlayers = data.players || [];
  state.gmUnlocks = data.unlocks || {};
  renderGmVault();
  renderManageCards();
}
function renderGmVault() {
  if (!state.gmUnlocked) return;
  const select = $('#gmPlayerSelect');
  const options = '<option value="">Choose a player…</option>' + state.gmPlayers.map(name => `<option value="${esc(name)}">${esc(name)}</option>`).join('');
  if (select.innerHTML !== options) select.innerHTML = options;
  if (!state.gmPlayers.includes(state.gmSelectedPlayer)) state.gmSelectedPlayer = '';
  select.value = state.gmSelectedPlayer;
  const player = state.gmSelectedPlayer;
  const allowed = new Set(state.gmUnlocks[player] || []);
  $('#gmVaultCount').textContent = player ? `${allowed.size} of ${state.gmCards.length} cards unlocked for ${player}. Changes sync to their client automatically.` : 'Choose a player, or add their name, to manage their cards.';
  $('#gmVaultCards').innerHTML = state.gmCards.length ? state.gmCards.map(card => `<div class="gm-vault-card ${allowed.has(card.id) ? 'granted' : ''}"><div class="manage-pair"><img src="${esc(card.image)}" alt="Card front"><img src="${esc(card.backImage || card.image)}" alt="Card back"></div><div class="gm-vault-actions"><button type="button" class="outline-button" data-zoom="${esc(card.id)}">ZOOM</button>${player ? `<button type="button" class="${allowed.has(card.id) ? 'outline-button' : 'primary-button'}" data-grant-card="${esc(card.id)}">${allowed.has(card.id) ? 'REVOKE' : 'UNLOCK'}</button>` : '<span class="muted small">Choose a player</span>'}</div></div>`).join('') : '<p class="muted small">Your vault is empty. Upload a front and back image pair above to begin.</p>';
}
$('#gmPlayerSelect').addEventListener('change', e => { state.gmSelectedPlayer = e.target.value; renderGmVault(); });
$('#gmAddPlayer').addEventListener('click', async () => {
  const player = $('#newPlayerName').value.trim();
  if (!player) return toast('Enter the player name used on their device.');
  try {
    await request('/api/gm/players', gmJson({player}));
    $('#newPlayerName').value = '';
    state.gmSelectedPlayer = player.replace(/[<>\u0000-\u001f]/g, '').slice(0,24);
    await loadGmCards();
    toast(`Player ${state.gmSelectedPlayer} is ready for card unlocks.`);
  } catch(e) { toast(e.message); }
});
$('#gmVaultCards').addEventListener('click', async e => {
  const button = e.target.closest('[data-grant-card]');
  if (!button) return;
  const player = state.gmSelectedPlayer;
  const id = button.dataset.grantCard;
  if (!player || !state.gmPlayers.includes(player)) return toast('Select a player first.');
  const grant = !(state.gmUnlocks[player] || []).includes(id);
  button.disabled = true;
  try {
    await request('/api/gm/grants', gmJson({player,cardId:id,grant}));
    await loadGmCards();
    if (player === state.player) await refresh();
    toast(grant ? `Card unlocked for ${player}.` : `Card revoked from ${player}.`);
  } catch(err) { toast(err.message); button.disabled = false; }
});
function enemyPairMarkup(index) {
  return `<div class="upload-pair" data-enemy-pair="${index}"><div class="pair-heading"><b>ENEMY CARD PAIR ${index}</b>${index > 1 ? '<button type="button" class="remove-pair" data-remove-enemy-pair>REMOVE</button>' : ''}</div><div class="pair-inputs"><label class="mini-upload"><span>FRONT IMAGE</span><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-enemy-front></label><label class="mini-upload"><span>BACK IMAGE</span><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-enemy-back></label></div></div>`;
}
function resetEnemyPairs() {
  state.enemyPairCount = 1;
  $('#enemyUploadPairs').innerHTML = enemyPairMarkup(1);
}
function renderEnemyEditor() {
  if (!state.gmUnlocked) return;
  const sel = $('#editEnemySelect');
  const options = `<option value="">Select an enemy…</option>` + state.enemies.map(e => `<option value="${esc(e.id)}">${esc(e.name)} (${e.cards.length})</option>`).join('');
  if (sel.innerHTML !== options) sel.innerHTML = options;
  if (!state.enemies.some(e => e.id === state.editEnemyId)) state.editEnemyId = '';
  sel.value = state.editEnemyId;
  const enemy = state.enemies.find(e => e.id === state.editEnemyId);
  $('#enemyEditor').classList.toggle('hidden', !enemy);
  if (!enemy) return;
  $('#editEnemyTitle').textContent = enemy.name;
  // Never recreate the file input nodes while the GM is choosing images.
  if (!$('#enemyUploadPairs').children.length) resetEnemyPairs();
  $('#enemyManageCards').innerHTML = enemy.cards.length ? enemy.cards.map(c => `<div class="enemy-manage-card"><div class="manage-pair"><img src="${esc(c.image)}" alt="Enemy card front"><img src="${esc(c.backImage)}" alt="Enemy card back"></div><button type="button" data-remove-enemy-card="${esc(c.id)}">REMOVE</button></div>`).join('') : '<p class="muted small">No cards saved for this enemy yet.</p>';
}
async function setArena(enemyId, cardIds) {
  try {
    const result = await request('/api/gm/arena', gmJson({enemyId, cardIds}));
    state.arena = result.arena;
    render();
    renderGmSpeeds();
    toast('Enemy field updated for everyone.');
  } catch(err) { toast(err.message); }
}
$('#gmUnlock').addEventListener('click', unlockGm);
$('#adminPassword').addEventListener('keydown', e => { if (e.key === 'Enter') unlockGm(); });
$('#createEnemy').addEventListener('click', async () => {
  const name = $('#newEnemyName').value.trim();
  if (!name) return toast('Enter an enemy type name.');
  try {
    const result = await request('/api/gm/enemies', gmJson({name}));
    $('#newEnemyName').value = '';
    state.editEnemyId = result.enemy.id;
    state.gmEnemyId = result.enemy.id;
    resetEnemyPairs();
    await loadGmEnemies(); render(); toast(`Enemy type "${name}" created.`);
  } catch(err) { toast(err.message); }
});
$('#editEnemySelect').addEventListener('change', e => {
  state.editEnemyId = e.target.value;
  resetEnemyPairs(); renderEnemyEditor();
});
$('#gmEnemySelect').addEventListener('change', e => { state.gmEnemyId = e.target.value; renderGmBattle(); });
$('#addEnemyPair').addEventListener('click', () => {
  $('#enemyUploadPairs').insertAdjacentHTML('beforeend', enemyPairMarkup(++state.enemyPairCount));
});
$('#enemyUploadPairs').addEventListener('click', e => {
  const del = e.target.closest('[data-remove-enemy-pair]');
  if (del) del.closest('[data-enemy-pair]').remove();
});
$('#uploadEnemyButton').addEventListener('click', async () => {
  if (!state.editEnemyId) return toast('Select an enemy first.');
  const rows = [...document.querySelectorAll('[data-enemy-pair]')];
  const form = new FormData();
  if (!rows.length) return toast('Add an enemy card pair.');
  for (const row of rows) {
    const front = row.querySelector('[data-enemy-front]').files[0];
    const back = row.querySelector('[data-enemy-back]').files[0];
    if (!front || !back) return toast('Each enemy card needs a front and a back image.');
    form.append('fronts', front); form.append('backs', back);
  }
  const btn = $('#uploadEnemyButton'); btn.disabled = true; btn.textContent = 'UPLOADING…';
  try {
    const result = await request(`/api/gm/enemies/${encodeURIComponent(state.editEnemyId)}/cards`, {method:'POST',headers:gmHeaders(),body:form});
    resetEnemyPairs(); await loadGmEnemies(); render(); toast(`${result.added} enemy card${result.added === 1 ? '' : 's'} uploaded.`);
  } catch(err) { toast(err.message); }
  finally { btn.disabled = false; btn.textContent = 'UPLOAD ENEMY CARD PAIRS'; }
});
$('#deleteEnemy').addEventListener('click', async () => {
  const enemy = state.enemies.find(e => e.id === state.editEnemyId);
  if (!enemy || !confirm(`Delete "${enemy.name}" and all its enemy cards?`)) return;
  try {
    await request(`/api/gm/enemies/${encodeURIComponent(enemy.id)}`, {method:'DELETE',headers:gmHeaders()});
    if (state.gmEnemyId === enemy.id) state.gmEnemyId = '';
    state.editEnemyId = ''; resetEnemyPairs();
    await loadGmEnemies(); await refresh(); toast('Enemy type deleted.');
  } catch(err) { toast(err.message); }
});
$('#enemyManageCards').addEventListener('click', async e => {
  const btn = e.target.closest('[data-remove-enemy-card]'); if (!btn) return;
  if (!confirm('Delete this enemy card?')) return;
  try {
    await request(`/api/gm/enemies/${encodeURIComponent(state.editEnemyId)}/cards/${encodeURIComponent(btn.dataset.removeEnemyCard)}`,{method:'DELETE',headers:gmHeaders()});
    await loadGmEnemies(); await refresh(); toast('Enemy card removed.');
  } catch(err) { toast(err.message); }
});
$('#gmManageEnemies').addEventListener('click', () => openGmModal());
$('#gmRevealAll').addEventListener('click', () => {
  const enemy = state.enemies.find(e => e.id === state.gmEnemyId);
  if (!enemy) return toast('Select an enemy type first.');
  setArena(enemy.id, enemy.cards.map(c => c.id));
});
$('#gmHideAll').addEventListener('click', () => {
  const enemy = state.enemies.find(e => e.id === state.gmEnemyId);
  if (!enemy) return toast('Select an enemy type first.');
  setArena(enemy.id, []);
});
$('#gmClearEnemy').addEventListener('click', () => setArena(null, []));
$('#gmEnemyRoster').addEventListener('click', e => {
  const btn = e.target.closest('[data-gm-toggle]'); if (!btn) return;
  const enemy = state.enemies.find(e => e.id === state.gmEnemyId);
  if (!enemy) return;
  const id = btn.dataset.gmToggle;
  const visible = new Set(state.arena.enemyId === enemy.id ? state.arena.cards.map(c => c.id) : []);
  if (visible.has(id)) visible.delete(id); else visible.add(id);
  setArena(enemy.id, [...visible]);
});

// V8 — GM can see both players' active hands and select which card an enemy targets.
async function refreshGmCombat() {
  if (!state.gmUnlocked) return;
  state.gmCombat = await request('/api/gm/combat', {headers:gmHeaders()});
  renderGmHands(); renderCombatFeed(); renderGmSpeeds(); renderGmRoundControls();
}
function renderGmHands() {
  const el = $('#gmPlayerHands');
  if (!el || !state.gmUnlocked || document.activeElement?.closest?.('[data-speed-editor]')) return;
  const battles = state.gmCombat.players || [];
  el.innerHTML = battles.length ? battles.map(p => `<div class="gm-player-line"><div class="gm-player-heading"><strong>${esc(p.name)}</strong><span>${p.hand.length} in hand · ${p.discarded} discarded · ${p.remaining} in pile</span></div><div class="gm-hand-grid">${p.hand.map(card => `<article class="gm-hand-card ${state.gmSelectedEnemyCard ? 'attack-target' : ''} ${card.pending ? 'round-pending' : ''}">
    ${state.gmCombat.showSpeeds && card.speed !== null && card.speed !== undefined ? `<div class="speed-badge">SPD <strong>${Number(card.speed)}</strong></div>` : ''}
    <img src="${esc(card.image)}" alt="${esc(p.name)}'s hand card">
    ${card.pending ? '<div class="pending-ribbon">QUEUED FOR DISCARD</div>' : ''}
    <button type="button" class="outline-button gm-target-button" data-gm-target="${esc(card.instanceId)}" data-player="${esc(p.name)}">${state.gmSelectedEnemyCard ? 'ATTACK THIS CARD' : 'TARGET'}</button>
    <div class="gm-speed-editor" data-speed-editor><label>SPEED <input type="number" min="0" max="99" step="1" placeholder="—" aria-label="Speed for ${esc(p.name)}'s card" value="${card.speed ?? ''}" data-speed-player="${esc(p.name)}" data-speed-instance="${esc(card.instanceId)}"></label><button type="button" class="outline-button" data-save-player-speed="${esc(card.instanceId)}" data-player="${esc(p.name)}">SET</button></div>
  </article>`).join('')}</div></div>`).join('') : '<p class="muted small">No players have entered battle yet. Their hands will appear here when they do.</p>';
}
function renderGmSpeeds() {
  if (!state.gmUnlocked) return;
  const toggle = $('#gmShowSpeeds');
  if (toggle) toggle.checked = !!state.gmCombat.showSpeeds;
  const el = $('#gmEnemySpeeds');
  if (!el || document.activeElement?.closest?.('[data-speed-editor]')) return;
  el.innerHTML = state.arena.cards.length ? state.arena.cards.map(c => `<div class="gm-speed-line"><img src="${esc(c.image)}" alt="Enemy card"><div class="gm-speed-editor" data-speed-editor><label>SPEED <input type="number" min="0" max="99" step="1" placeholder="—" aria-label="Speed for enemy card" value="${state.gmCombat.enemySpeeds?.[c.instanceId] ?? state.gmCombat.enemySpeeds?.[c.id] ?? ''}" data-speed-enemy="${esc(c.instanceId)}"></label><button type="button" class="outline-button" data-save-enemy-speed="${esc(c.instanceId)}">SET</button></div></div>`).join('') : '<p class="muted small">Reveal enemy cards first to assign their speeds.</p>';
}
async function setSpeed(body) {
  try { await request('/api/gm/combat/speed',gmJson(body)); await Promise.all([refresh(),refreshGmCombat()]); toast('Card speed updated.'); }
  catch(err) { toast(err.message); }
}
function readSpeed(input) {
  if (!input) return undefined;
  const value = input.value.trim();
  if (!value) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 99) { toast('Enter a speed between 0 and 99, or leave blank.'); return undefined; }
  return n;
}
$('#gmShowSpeeds').addEventListener('change', async e => {
  try { await request('/api/gm/combat/show-speeds',gmJson({show:e.target.checked})); await Promise.all([refresh(),refreshGmCombat()]); toast(e.target.checked ? 'Card speeds are visible to players.' : 'Card speeds are hidden.'); }
  catch(err) { toast(err.message); e.target.checked = !e.target.checked; }
});
$('#gmEnemySpeeds').addEventListener('click', async e => {
  const btn = e.target.closest('[data-save-enemy-speed]'); if (!btn) return;
  const speed = readSpeed(btn.closest('[data-speed-editor]').querySelector('input'));
  if (speed === undefined) return;
  await setSpeed({scope:'enemy', instanceId:btn.dataset.saveEnemySpeed, speed});
});
$('#gmPlayerHands').addEventListener('click', async e => {
  const btn = e.target.closest('[data-save-player-speed]'); if (!btn) return;
  const speed = readSpeed(btn.closest('[data-speed-editor]').querySelector('input'));
  if (speed === undefined) return;
  await setSpeed({scope:'player', player:btn.dataset.player, instanceId:btn.dataset.savePlayerSpeed, speed});
});
function renderGmRoundControls() {
  if (!state.gmUnlocked) return;
  const combat = state.gmCombat;
  $('#gmRoundNumber').textContent = combat.round || state.round;
  const emotion = $('#gmEmotionLevel');
  if (document.activeElement !== emotion) emotion.value = String(combat.emotionLevel || 1);
  $('#gmDrawRate').textContent = emotionDrawCount(combat.emotionLevel || 1);
  const result = combat.lastRoundSummary;
  $('#gmRoundResult').innerHTML = result ? `<strong>Round ${result.finishedRound} resolved:</strong> ${result.enemyDiscarded} enemy card${result.enemyDiscarded === 1 ? '' : 's'} discarded. ${result.players.map(p => `${esc(p.player)}: ${p.discarded} discarded, ${p.drawn} drawn`).join(' · ') || 'No players in battle yet.'}` : 'No rounds have ended yet.';
}
$('#gmEmotionLevel').addEventListener('change', async e => {
  try {
    const level = Number(e.target.value);
    await request('/api/gm/combat/emotion',gmJson({level}));
    await Promise.all([refresh(),refreshGmCombat()]);
    toast(`Emotion level ${level}: ${emotionDrawCount(level)} card${emotionDrawCount(level) === 1 ? '' : 's'} drawn per player after a round.`);
  } catch(err) { toast(err.message); await refreshGmCombat(); }
});
$('#gmEndRound').addEventListener('click', async event => {
  if (state.actionPending) return;
  // Capture the button before any await. event.currentTarget is reset after
  // event dispatch and caused V9 to leave the button disabled indefinitely.
  const button = event.currentTarget;
  const round = state.gmCombat.round || state.round;
  if (!confirm(`End round ${round}? Used cards and their enemy targets will be discarded, and each player will draw ${emotionDrawCount(state.gmCombat.emotionLevel || 1)} card(s).`)) return;
  state.actionPending = true;
  button.disabled = true;
  button.textContent = 'ENDING ROUND…';
  try {
    const result = await request('/api/gm/combat/end-round',gmJson({expectedRound: round}));
    state.gmSelectedEnemyCard = null;
    state.selectedHandInstance = null;
    toast(`Round ${result.summary.finishedRound} complete! Now on round ${result.summary.round}.`);
  } catch (err) {
    toast(err.message);
  } finally {
    // Do not leave the control disabled even if a response or refresh fails.
    state.actionPending = false;
    button.disabled = false;
    button.textContent = 'END ROUND →';
    await Promise.allSettled([refresh(), refreshGmCombat()]);
  }
});
async function drawEnemyCard(cardId) {
  if (state.actionPending) return;
  state.actionPending = true;
  try {
    const value = Number($('#gmEnemyDrawCount').value || 1);
    const count = Number.isInteger(value) && value >= 1 && value <= 20 ? value : 0;
    if (!count) return toast('Draw between 1 and 20 cards per click.');
    const result = await request('/api/gm/combat/enemy-draw',gmJson({count, enemyId:state.gmEnemyId || state.arena.enemyId, ...(cardId ? {cardId} : {})}));
    state.arena = result.arena;
    await Promise.all([refresh(),refreshGmCombat()]);
    toast(`${result.drawn} enemy card${result.drawn === 1 ? '' : 's'} added to the field.`);
  } catch(err) { toast(err.message); }
  finally { state.actionPending = false; }
}
$('#gmDrawEnemy').addEventListener('click', () => drawEnemyCard(null));
$('#gmEnemyRoster').addEventListener('click', e => {
  const btn = e.target.closest('[data-gm-draw-specific]');
  if (!btn) return;
  e.preventDefault(); e.stopPropagation(); drawEnemyCard(btn.dataset.gmDrawSpecific);
});
$('#gmResetBattle').addEventListener('click', async () => {
  if (!confirm('Start a new battle for all players? This clears both players’ hands and the combat feed, but keeps their saved decks and cards.')) return;
  try {
    await request('/api/gm/combat/reset',gmJson({}));
    state.selectedHandInstance = null; state.gmSelectedEnemyCard = null;
    await Promise.all([refresh(),refreshGmCombat()]);
    toast('Battle hands reset. Players can enter Battle again.');
  } catch(err) { toast(err.message); }
});
$('#gmClearFeed').addEventListener('click', async () => {
  try { await request('/api/gm/combat/clear-feed',gmJson({})); await Promise.all([refresh(),refreshGmCombat()]); toast('Combat feed cleared.'); }
  catch(err) { toast(err.message); }
});

// A saved GM password is only trusted after server-side verification.
if (state.adminPassword) {
  request('/api/gm/verify',{method:'POST',headers:gmHeaders()}).then(async () => {
    state.gmUnlocked = true; await Promise.all([loadGmEnemies(), loadGmCards(), refreshGmCombat()]); render();
  }).catch(() => { state.adminPassword = ''; sessionStorage.removeItem('pm-card-admin'); });
}


// V6 — GM-uploaded looping lobby track. Track changes sync for all clients,
// while mute preference is personal to each browser.
const lobbyAudio = $('#lobbyAudio');
lobbyAudio.volume = 0.35;
lobbyAudio.muted = localStorage.getItem('pm-card-music-muted') === 'true';
let activeMusicUrl = null;
function musicButtonState() {
  const button = $('#musicToggle');
  const hasMusic = !!activeMusicUrl;
  button.disabled = !hasMusic;
  const label = !hasMusic ? 'NO MUSIC' : lobbyAudio.muted ? 'UNMUTE MUSIC' : lobbyAudio.paused ? 'PLAY MUSIC' : 'MUTE MUSIC';
  $('#musicLabel').textContent = label;
  $('#musicIcon').textContent = !hasMusic ? '♪' : lobbyAudio.muted ? '♩' : lobbyAudio.paused ? '▶' : '♫';
  button.setAttribute('aria-label', label);
  button.title = label;
}
function renderCurrentMusic() {
  const element = $('#currentMusic');
  if (element) element.textContent = state.music ? `Current track: ${state.music.originalName}` : 'No music uploaded.';
  const remove = $('#removeMusicButton');
  if (remove) remove.disabled = !state.music;
}
function syncMusic(music) {
  state.music = music;
  const nextUrl = music?.url || null;
  if (nextUrl !== activeMusicUrl) {
    activeMusicUrl = nextUrl;
    lobbyAudio.pause();
    if (nextUrl) {
      lobbyAudio.src = nextUrl;
      lobbyAudio.load();
      if (!lobbyAudio.muted) lobbyAudio.play().catch(() => { musicButtonState(); });
    } else {
      lobbyAudio.removeAttribute('src');
      lobbyAudio.load();
    }
  }
  musicButtonState();
  renderCurrentMusic();
}
$('#musicToggle').addEventListener('click', async () => {
  if (!activeMusicUrl) return;
  if (lobbyAudio.muted) {
    lobbyAudio.muted = false;
    localStorage.setItem('pm-card-music-muted', 'false');
    try { await lobbyAudio.play(); } catch (_) { toast('Your browser requires a click to start playback.'); }
  } else if (lobbyAudio.paused) {
    try { await lobbyAudio.play(); } catch (_) { toast('Could not play this audio file in your browser.'); }
  } else {
    lobbyAudio.muted = true;
    localStorage.setItem('pm-card-music-muted', 'true');
  }
  musicButtonState();
});
['play', 'pause', 'volumechange', 'ended'].forEach(name => lobbyAudio.addEventListener(name, musicButtonState));
$('#uploadMusicButton').addEventListener('click', async () => {
  if (!state.gmUnlocked) return toast('Unlock GM controls first.');
  const file = $('#musicFile').files[0];
  if (!file) return toast('Choose an MP3, OGG, WAV, or M4A file.');
  if (file.size > 40 * 1024 * 1024) return toast('Music files must be 40 MB or smaller.');
  const form = new FormData(); form.append('music', file);
  const button = $('#uploadMusicButton');
  button.disabled = true; button.textContent = 'UPLOADING MUSIC…';
  try {
    const data = await request('/api/gm/music', { method:'POST', headers: gmHeaders(), body:form });
    $('#musicFile').value = '';
    syncMusic(data.music);
    toast('Lobby music uploaded for everyone.');
  } catch(err) { toast(err.message); }
  finally { button.disabled = false; button.textContent = 'UPLOAD / REPLACE MUSIC'; }
});
$('#removeMusicButton').addEventListener('click', async () => {
  if (!state.gmUnlocked || !state.music) return;
  if (!confirm('Remove the lobby music for everyone?')) return;
  try {
    await request('/api/gm/music', { method:'DELETE', headers:gmHeaders() });
    syncMusic(null); toast('Lobby music removed.');
  } catch(err) { toast(err.message); }
});
musicButtonState();

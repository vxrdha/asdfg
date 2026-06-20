const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const {
  PLAYERS_BY_ID,
  freshTeams,
  createRoomState,
  nextBidAmount,
  canTeamBid,
  checkAuctionEnd,
  computeTeamScore,
  TIMER_SECONDS,
} = require('./gameLogic');
const { TEAMS, PLAYERS } = require('../shared/gameData');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// In-memory room store. roomCode -> state object (see createRoomState)
const rooms = new Map();
// socket.id -> { roomCode, name }
const socketMeta = new Map();
// roomCode -> interval handle (the host-driven auction timer)
const roomTimers = new Map();

function generateRoomCode(){
  let code;
  do {
    code = 'AUCT-' + Math.floor(1000 + Math.random()*9000);
  } while (rooms.has(code));
  return code;
}

function publicState(state){
  // Strip server-only fields before sending to clients
  const { ...rest } = state;
  return rest;
}

function broadcastState(roomCode){
  const state = rooms.get(roomCode);
  if (!state) return;
  io.to(roomCode).emit('state', publicState(state));
}

function setAnnouncement(state, text){
  state.announcement = text;
}

/* ---------------------------------------------------------
   AUCTION ENGINE (server-authoritative)
   --------------------------------------------------------- */
function startRoomTimer(roomCode){
  stopRoomTimer(roomCode);
  const state = rooms.get(roomCode);
  if (!state) return;
  const intervalMs = state.mode === 'fast' ? 500 : 1000;
  const handle = setInterval(()=> tick(roomCode), intervalMs);
  roomTimers.set(roomCode, handle);
}

function stopRoomTimer(roomCode){
  const handle = roomTimers.get(roomCode);
  if (handle) clearInterval(handle);
  roomTimers.delete(roomCode);
}

function tick(roomCode){
  const state = rooms.get(roomCode);
  if (!state || state.auctionEnded){ stopRoomTimer(roomCode); return; }
  state.timer -= 1;
  if (state.timer <= 0){
    resolveSale(roomCode);
    return;
  }
  broadcastState(roomCode);
}

function nextPlayer(roomCode){
  const state = rooms.get(roomCode);
  if (!state) return;
  if (state.queue.length === 0){
    endAuction(roomCode);
    return;
  }
  state.current = state.queue.shift();
  const player = PLAYERS_BY_ID[state.current];
  state.currentBid = { amount: player.basePrice, teamCode: null };
  state.bidHistory = [];
  state.timer = TIMER_SECONDS;
  setAnnouncement(state, `Next up: ${player.name} (${player.role}) — base price ${formatMoney(player.basePrice)}`);
  broadcastState(roomCode);
  startRoomTimer(roomCode);
}

function resolveSale(roomCode, forced){
  const state = rooms.get(roomCode);
  if (!state) return;
  stopRoomTimer(roomCode);
  const player = PLAYERS_BY_ID[state.current];
  if (!player) return;

  if (state.currentBid.teamCode){
    const team = state.teams[state.currentBid.teamCode];
    const price = state.currentBid.amount;
    team.purse -= price;
    team.spent += price;
    team.squad.push({ id: player.id, name: player.name, role: player.role, country: player.country,
      type: player.type, rating: player.rating, basePrice: player.basePrice, price });
    if (player.type === 'Overseas') team.overseasCount++; else team.indianCount++;
    state.soldLog.push({ playerId: player.id, teamCode: team.code, price });
    setAnnouncement(state, `SOLD! ${player.name} goes to ${team.name} for ${formatMoney(price)}.`);
    state.lastSale = { kind: 'sold', playerId: player.id, teamCode: team.code, price };
  } else {
    state.unsoldIds.push(player.id);
    setAnnouncement(state, `${player.name} went UNSOLD.`);
    state.lastSale = { kind: 'unsold', playerId: player.id, forced: !!forced };
  }
  broadcastState(roomCode);

  const delay = state.mode === 'fast' ? 700 : 1500;
  setTimeout(()=>{
    const s = rooms.get(roomCode);
    if (!s) return;
    if (checkAuctionEnd(s)){ endAuction(roomCode); }
    else { nextPlayer(roomCode); }
  }, delay);
}

function endAuction(roomCode){
  const state = rooms.get(roomCode);
  if (!state) return;
  stopRoomTimer(roomCode);
  state.auctionEnded = true;
  state.auctionActive = false;
  setAnnouncement(state, 'Auction complete! Compiling results...');

  // Build final rankings server-side so everyone gets identical results
  state.rankings = TEAMS.map(t=>{
    const team = state.teams[t.code];
    return { code: t.code, score: computeTeamScore(team) };
  }).sort((a,b)=> b.score.overall - a.score.overall);

  broadcastState(roomCode);
}

function formatMoney(lakhs){
  if (lakhs >= 100) return '₹' + (lakhs/100).toFixed(2) + ' Cr';
  return '₹' + lakhs + ' L';
}

/* ---------------------------------------------------------
   SOCKET HANDLERS
   --------------------------------------------------------- */
io.on('connection', (socket)=>{

  socket.on('createRoom', ({ name }, cb)=>{
    name = (name||'').trim().slice(0,20);
    if (!name) return cb && cb({ error: 'Enter your name.' });

    const roomCode = generateRoomCode();
    const state = createRoomState(roomCode, socket.id, name);
    state.players.push({ name, socketId: socket.id, teamCode: null, connected: true });
    rooms.set(roomCode, state);

    socket.join(roomCode);
    socketMeta.set(socket.id, { roomCode, name });

    cb && cb({ ok: true, roomCode, isHost: true, state: publicState(state) });
    broadcastState(roomCode);
  });

  socket.on('joinRoom', ({ name, roomCode }, cb)=>{
    name = (name||'').trim().slice(0,20);
    roomCode = (roomCode||'').trim().toUpperCase();
    if (!name) return cb && cb({ error: 'Enter your name.' });
    if (!roomCode) return cb && cb({ error: 'Enter a room code.' });

    const state = rooms.get(roomCode);
    if (!state) return cb && cb({ error: "Room not found. Double-check the code with the host." });

    // Reuse an existing player entry with the same name (re-join after disconnect)
    let player = state.players.find(p=>p.name.toLowerCase() === name.toLowerCase());
    const wasHost = player && state.hostName.toLowerCase() === name.toLowerCase();
    if (player){
      player.socketId = socket.id;
      player.connected = true;
      // If they previously owned a team, restore the live socket link
      if (player.teamCode){
        state.teams[player.teamCode].ownerSocketId = socket.id;
      }
      // If the host reconnected (e.g. page refresh), restore host privileges
      if (wasHost){
        state.hostSocketId = socket.id;
      }
    } else {
      player = { name, socketId: socket.id, teamCode: null, connected: true };
      state.players.push(player);
    }

    socket.join(roomCode);
    socketMeta.set(socket.id, { roomCode, name });

    cb && cb({ ok: true, roomCode, isHost: state.hostSocketId === socket.id, state: publicState(state) });
    broadcastState(roomCode);
  });

  socket.on('claimTeam', ({ teamCode }, cb)=>{
    const meta = socketMeta.get(socket.id);
    if (!meta) return cb && cb({ error: "You're not in a room." });
    const state = rooms.get(meta.roomCode);
    if (!state) return cb && cb({ error: 'Room not found.' });
    if (state.auctionEnded){
      return cb && cb({ error: 'The auction has already finished.' });
    }

    const team = state.teams[teamCode];
    if (!team) return cb && cb({ error: 'Unknown team.' });
    // Server is authoritative: re-check ownership here even if the client's
    // local view of the grid looked unclaimed (two friends can tap at once).
    if (team.owner){
      return cb && cb({ error: `Too slow! ${team.owner} just grabbed ${team.name}.` });
    }

    const player = state.players.find(p=>p.socketId === socket.id && !p.teamCode);
    if (!player) return cb && cb({ error: 'Join the room (or add a local player) before picking a team.' });

    team.owner = player.name;
    team.ownerSocketId = socket.id;
    player.teamCode = teamCode;
    // Joining mid-auction (after the queue has already moved on) is allowed —
    // the late joiner simply starts bidding from whatever player comes up next.
    broadcastState(meta.roomCode);
    cb && cb({ ok: true });
  });

  socket.on('releaseTeam', ({ teamCode }, cb)=>{
    const meta = socketMeta.get(socket.id);
    if (!meta) return cb && cb({ error: "You're not in a room." });
    const state = rooms.get(meta.roomCode);
    if (!state) return cb && cb({ error: 'Room not found.' });
    if (state.auctionActive || state.auctionEnded){
      return cb && cb({ error: 'The auction has already started — teams are locked in.' });
    }

    const team = state.teams[teamCode];
    if (!team) return cb && cb({ error: 'Unknown team.' });
    // Only the socket currently controlling this franchise may release it
    if (team.ownerSocketId !== socket.id){
      return cb && cb({ error: `You don't control ${team.name}.` });
    }

    const player = state.players.find(p=> p.teamCode === teamCode && p.socketId === socket.id);
    if (player) player.teamCode = null;
    team.owner = null;
    team.ownerSocketId = null;

    broadcastState(meta.roomCode);
    cb && cb({ ok: true });
  });

  socket.on('addLocalPlayer', ({ name })=>{
    // Host adding an extra friend on the same device (pass-and-play)
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const state = rooms.get(meta.roomCode);
    if (!state || state.auctionActive) return;
    name = (name||'').trim().slice(0,20);
    if (!name) return;
    if (state.players.some(p=>p.name.toLowerCase()===name.toLowerCase())) return;
    state.players.push({ name, socketId: socket.id, teamCode: null });
    broadcastState(meta.roomCode);
  });

  socket.on('beginAuction', ()=>{
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const state = rooms.get(meta.roomCode);
    if (!state) return;
    if (state.hostSocketId !== socket.id) return; // only host can start
    if (state.auctionActive || state.auctionEnded) return;

    const activeTeams = TEAMS.filter(t => state.teams[t.code].owner);
    if (activeTeams.length === 0) return;

    state.auctionActive = true;
    broadcastState(meta.roomCode);
    nextPlayer(meta.roomCode);
  });

  socket.on('placeBid', ({ teamCode })=>{
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const state = rooms.get(meta.roomCode);
    if (!state || !state.auctionActive || state.auctionEnded) return;

    const player = PLAYERS_BY_ID[state.current];
    if (!player) return;
    const team = state.teams[teamCode];
    if (!team) return;

    // Only the socket controlling this franchise may bid for it
    if (team.ownerSocketId !== socket.id) return;

    const amount = nextBidAmount(state);
    if (state.currentBid.teamCode === teamCode) return; // already highest
    if (!canTeamBid(team, player, amount)) return;

    state.currentBid = { amount, teamCode };
    state.bidHistory.push({ teamCode, amount });
    state.timer = state.mode === 'fast' ? Math.min(state.timer + 4, TIMER_SECONDS) : TIMER_SECONDS;
    setAnnouncement(state, `${team.name} (${team.owner}) bids ${formatMoney(amount)} for ${player.name}!`);
    broadcastState(meta.roomCode);
  });

  socket.on('setMode', ({ mode })=>{
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const state = rooms.get(meta.roomCode);
    if (!state) return;
    if (state.hostSocketId !== socket.id) return; // only host controls pace
    if (mode !== 'manual' && mode !== 'fast') return;
    state.mode = mode;
    if (state.current && !state.auctionEnded && state.auctionActive){
      startRoomTimer(meta.roomCode);
    }
    broadcastState(meta.roomCode);
  });

  socket.on('leaveRoom', ()=>{
    handleDisconnect(socket);
  });

  socket.on('disconnect', ()=>{
    handleDisconnect(socket);
  });

  function handleDisconnect(socket){
    const meta = socketMeta.get(socket.id);
    socketMeta.delete(socket.id);
    if (!meta) return;
    const state = rooms.get(meta.roomCode);
    if (!state) return;

    // Mark this player's socket as disconnected but keep their seat/team
    // (room codes are short-lived; friends can rejoin with the same name).
    state.players.forEach(p=>{ if (p.socketId === socket.id) p.connected = false; });

    socket.leave(meta.roomCode);
    broadcastState(meta.roomCode);

    // Clean up empty/abandoned rooms after a while
    setTimeout(()=>{
      const s = rooms.get(meta.roomCode);
      if (!s) return;
      const stillConnected = s.players.some(p=> io.sockets.sockets.get(p.socketId));
      if (!stillConnected){
        stopRoomTimer(meta.roomCode);
        rooms.delete(meta.roomCode);
      }
    }, 10 * 60 * 1000); // 10 minutes
  }
});

server.listen(PORT, ()=>{
  console.log(`IPL Auction server running on port ${PORT}`);
});

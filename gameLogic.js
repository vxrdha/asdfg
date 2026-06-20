// Pure game-logic helpers used by the server to validate actions and
// compute results. Mirrors the rules from the original single-player
// simulator, but the SERVER is now the single source of truth.

const { TEAMS, PLAYERS, STARTING_PURSE, MAX_SQUAD, MAX_OVERSEAS, BID_INCREMENT, TIMER_SECONDS } = require('../shared/gameData');

const PLAYERS_BY_ID = {};
PLAYERS.forEach(p => PLAYERS_BY_ID[p.id] = p);

function hashCode(str){
  let h = 0;
  for (let i=0;i<str.length;i++){ h = (h<<5) - h + str.charCodeAt(i); h |= 0; }
  return Math.abs(h);
}

/* Seeded shuffle so a given room code always produces the same player order */
function seededShuffle(arr, seedStr){
  let seed = hashCode(String(seedStr)) || 1;
  function rand(){
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  }
  const a = arr.slice();
  for (let i=a.length-1;i>0;i--){
    const j = Math.floor(rand()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}

function freshTeams(){
  const teams = {};
  TEAMS.forEach(t => {
    teams[t.code] = {
      code: t.code, name: t.name, primary: t.primary, secondary: t.secondary, text: t.text,
      purse: STARTING_PURSE, spent: 0, squad: [], overseasCount: 0, indianCount: 0,
      owner: null,      // display name of the friend controlling this franchise
      ownerSocketId: null, // which connected socket currently controls this team
    };
  });
  return teams;
}

function createRoomState(roomCode, hostSocketId, hostName){
  return {
    roomCode,
    hostSocketId,
    hostName,
    players: [], // [{ name, socketId, teamCode }]
    teams: freshTeams(),
    queue: seededShuffle(PLAYERS.map(p=>p.id), roomCode),
    soldLog: [],
    unsoldIds: [],
    current: null,
    currentBid: { amount: 0, teamCode: null },
    bidHistory: [],
    timer: TIMER_SECONDS,
    mode: 'manual',
    auctionActive: false,
    auctionEnded: false,
    createdAt: Date.now(),
  };
}

function nextBidAmount(state){
  const player = PLAYERS_BY_ID[state.current];
  if (!player) return 0;
  if (!state.currentBid.teamCode) return player.basePrice;
  return state.currentBid.amount + BID_INCREMENT;
}

function canTeamBid(team, player, amount){
  if (!team || !player) return false;
  if (!team.owner) return false;
  if (team.squad.length >= MAX_SQUAD) return false;
  if (player.type === 'Overseas' && team.overseasCount >= MAX_OVERSEAS) return false;
  if (team.purse < amount) return false;
  return true;
}

function checkAuctionEnd(state){
  if (state.queue.length === 0) return true;
  const ownedTeams = TEAMS.filter(t => state.teams[t.code].owner);
  if (ownedTeams.length === 0) return false;
  return ownedTeams.every(t => state.teams[t.code].squad.length >= MAX_SQUAD);
}

function computeTeamScore(team){
  const squad = team.squad;
  const n = squad.length || 1;
  const avgRating = squad.reduce((s,p)=>s+p.rating,0) / n;
  const starPlayers = squad.filter(p=>p.rating>=90).length;
  const overseas = squad.filter(p=>p.type==='Overseas');
  const overseasQuality = overseas.length ? overseas.reduce((s,p)=>s+p.rating,0)/overseas.length : 0;

  const targets = { Batsman:6, Bowler:6, 'All-Rounder':4, Wicketkeeper:2 };
  let balanceSum = 0, balanceN = 0;
  Object.keys(targets).forEach(role=>{
    const count = squad.filter(p=>p.role===role).length;
    balanceSum += Math.min(count, targets[role]) / targets[role];
    balanceN++;
  });
  const balanceScore = (balanceSum/balanceN) * 100;
  const benchDepth = squad.length;
  const overall = avgRating + starPlayers*1.5 + balanceScore*0.15 + benchDepth*0.8 + overseasQuality*0.1;
  return {
    avgRating: Math.round(avgRating*10)/10,
    starPlayers, overseasQuality: Math.round(overseasQuality*10)/10,
    balanceScore: Math.round(balanceScore),
    benchDepth, overall: Math.round(overall*10)/10
  };
}

module.exports = {
  PLAYERS_BY_ID,
  seededShuffle,
  freshTeams,
  createRoomState,
  nextBidAmount,
  canTeamBid,
  checkAuctionEnd,
  computeTeamScore,
  TIMER_SECONDS,
  BID_INCREMENT,
  MAX_SQUAD,
};

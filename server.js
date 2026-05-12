const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory state ──────────────────────────────────────────────────────────

/** @type {Map<string, Room>} */
const rooms = new Map();

/**
 * @typedef {Object} Player
 * @property {string} id        - socket.id
 * @property {string} nickname
 * @property {string|null} role  - 'thief' | 'sleeper' | null
 * @property {string|null} vote  - voted playerId or null
 * @property {boolean} connected
 */

/**
 * @typedef {Object} Room
 * @property {string}   id
 * @property {string}   hostId     - socket.id of the host
 * @property {Player[]} players
 * @property {string}   phase      - waiting|dealing|night|day|voting|result
 * @property {number|null} diceValue
 * @property {number|null} nightTimer  - countdown in seconds
 * @property {string|null} thiefId    - socket.id of thief
 * @property {Object|null} result
 */

function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function createRoom(hostId) {
  let roomId;
  do {
    roomId = generateRoomId();
  } while (rooms.has(roomId));

  const room = {
    id: roomId,
    hostId,
    players: [],
    phase: 'waiting',
    diceValue: null,
    nightTimer: null,
    thiefId: null,
    result: null
  };
  rooms.set(roomId, room);
  return room;
}

function getRoomBySocket(socketId) {
  for (const room of rooms.values()) {
    if (room.players.some(p => p.id === socketId)) {
      return room;
    }
  }
  return null;
}

function getPublicPlayers(room, viewerId = null) {
  return room.players.map(p => ({
    id: p.id,
    nickname: p.nickname,
    isHost: p.id === room.hostId,
    connected: p.connected,
    voted: p.vote !== null
  }));
}

function broadcastRoom(room, event, data) {
  io.to(room.id).emit(event, data);
}

function sendPlayerList(room) {
  broadcastRoom(room, 'player_list', {
    players: getPublicPlayers(room),
    hostId: room.hostId,
    phase: room.phase
  });
}

function cleanupRoom(room) {
  // Remove disconnected players when room is in waiting phase
  if (room.phase === 'waiting') {
    room.players = room.players.filter(p => p.connected);
  }
}

// ── Socket.io event handlers ─────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  // ── create_room ─────────────────────────────────────────────────────────────
  socket.on('create_room', ({ nickname }, callback) => {
    if (!nickname || !nickname.trim()) {
      return callback({ error: '请输入昵称' });
    }

    const room = createRoom(socket.id);
    const player = {
      id: socket.id,
      nickname: nickname.trim().slice(0, 16),
      role: null,
      vote: null,
      connected: true
    };
    room.players.push(player);
    socket.join(room.id);

    console.log(`[create_room] ${room.id} by ${nickname}`);
    callback({ roomId: room.id });
    sendPlayerList(room);
  });

  // ── join_room ────────────────────────────────────────────────────────────────
  socket.on('join_room', ({ roomId, nickname }, callback) => {
    if (!nickname || !nickname.trim()) {
      return callback({ error: '请输入昵称' });
    }

    const room = rooms.get(roomId?.toUpperCase());
    if (!room) {
      return callback({ error: '房间不存在，请检查房间号' });
    }
    if (room.phase !== 'waiting') {
      return callback({ error: '游戏已经开始，无法加入' });
    }

    const activePlayers = room.players.filter(p => p.connected);
    if (activePlayers.length >= 8) {
      return callback({ error: '房间已满（最多8人）' });
    }

    // Deduplicate nickname
    const nick = nickname.trim().slice(0, 16);
    const dup = room.players.find(p => p.nickname === nick && p.connected);
    if (dup) {
      return callback({ error: '昵称已被使用，请换一个' });
    }

    const player = {
      id: socket.id,
      nickname: nick,
      role: null,
      vote: null,
      connected: true
    };
    room.players.push(player);
    socket.join(roomId);

    console.log(`[join_room] ${nick} joined ${roomId}`);
    callback({ ok: true, hostId: room.hostId });
    sendPlayerList(room);
  });

  // ── start_game ───────────────────────────────────────────────────────────────
  socket.on('start_game', (_, callback) => {
    const room = getRoomBySocket(socket.id);
    if (!room) return callback?.({ error: '不在任何房间' });
    if (room.hostId !== socket.id) return callback?.({ error: '只有房主才能开始游戏' });

    const activePlayers = room.players.filter(p => p.connected);
    if (activePlayers.length < 4) {
      return callback?.({ error: '至少需要4名玩家才能开始' });
    }
    if (activePlayers.length > 8) {
      return callback?.({ error: '最多支持8名玩家' });
    }

    // Assign roles: 1 thief, rest sleepers
    const shuffled = [...activePlayers].sort(() => Math.random() - 0.5);
    shuffled[0].role = 'thief';
    for (let i = 1; i < shuffled.length; i++) {
      shuffled[i].role = 'sleeper';
    }
    room.thiefId = shuffled[0].id;
    room.phase = 'dealing';

    console.log(`[start_game] room ${room.id}, thief: ${shuffled[0].nickname}`);

    // Tell each player their own role privately
    activePlayers.forEach(p => {
      io.to(p.id).emit('your_role', {
        role: p.role,
        phase: 'dealing'
      });
    });

    // Broadcast phase change (no roles leaked)
    broadcastRoom(room, 'phase_change', { phase: 'dealing' });
    sendPlayerList(room);
    callback?.({ ok: true });
  });

  // ── dealing_done (client confirms they saw their card) ────────────────────
  // All clients auto-advance after 5 s; host can also call night_start
  socket.on('night_start', (_, callback) => {
    const room = getRoomBySocket(socket.id);
    if (!room) return callback?.({ error: '不在任何房间' });
    if (room.hostId !== socket.id) return callback?.({ error: '只有房主才能推进' });
    if (room.phase !== 'dealing') return callback?.({ error: '当前阶段无法操作' });

    room.phase = 'night';
    broadcastRoom(room, 'phase_change', { phase: 'night' });
    console.log(`[night_start] room ${room.id}`);
    callback?.({ ok: true });
  });

  // ── roll_dice ────────────────────────────────────────────────────────────────
  socket.on('roll_dice', (_, callback) => {
    const room = getRoomBySocket(socket.id);
    if (!room) return callback?.({ error: '不在任何房间' });
    if (room.hostId !== socket.id) return callback?.({ error: '只有房主才能掷骰子' });
    if (room.phase !== 'night') return callback?.({ error: '只能在天黑时掷骰子' });

    const value = Math.floor(Math.random() * 6) + 1;
    room.diceValue = value;
    const seconds = value * 10; // 10-60 seconds sleep

    broadcastRoom(room, 'dice_rolled', { value, seconds });
    console.log(`[roll_dice] room ${room.id}, value=${value}, seconds=${seconds}`);
    callback?.({ ok: true, value, seconds });
  });

  // ── night_end ────────────────────────────────────────────────────────────────
  socket.on('night_end', (_, callback) => {
    const room = getRoomBySocket(socket.id);
    if (!room) return callback?.({ error: '不在任何房间' });
    if (room.hostId !== socket.id) return callback?.({ error: '只有房主才能推进' });
    if (room.phase !== 'night') return callback?.({ error: '当前阶段无法操作' });

    room.phase = 'day';
    broadcastRoom(room, 'phase_change', { phase: 'day' });
    console.log(`[night_end] room ${room.id}`);
    callback?.({ ok: true });
  });

  // ── start_vote ───────────────────────────────────────────────────────────────
  socket.on('start_vote', (_, callback) => {
    const room = getRoomBySocket(socket.id);
    if (!room) return callback?.({ error: '不在任何房间' });
    if (room.hostId !== socket.id) return callback?.({ error: '只有房主才能推进' });
    if (room.phase !== 'day') return callback?.({ error: '当前阶段无法操作' });

    room.phase = 'voting';
    // Reset votes
    room.players.forEach(p => { p.vote = null; });
    broadcastRoom(room, 'phase_change', { phase: 'voting' });
    sendPlayerList(room);
    console.log(`[start_vote] room ${room.id}`);
    callback?.({ ok: true });
  });

  // ── vote ─────────────────────────────────────────────────────────────────────
  socket.on('vote', ({ targetId }, callback) => {
    const room = getRoomBySocket(socket.id);
    if (!room) return callback?.({ error: '不在任何房间' });
    if (room.phase !== 'voting') return callback?.({ error: '当前不是投票阶段' });

    const voter = room.players.find(p => p.id === socket.id);
    if (!voter) return callback?.({ error: '找不到你的信息' });
    if (voter.vote !== null) return callback?.({ error: '你已经投过票了' });
    if (targetId === socket.id) return callback?.({ error: '不能投自己' });

    const target = room.players.find(p => p.id === targetId && p.connected);
    if (!target) return callback?.({ error: '目标玩家不存在' });

    voter.vote = targetId;
    console.log(`[vote] ${voter.nickname} → ${target.nickname} in room ${room.id}`);

    // Broadcast vote update (anonymized)
    sendPlayerList(room);
    callback?.({ ok: true });

    // Check if everyone has voted
    const activePlayers = room.players.filter(p => p.connected);
    const allVoted = activePlayers.every(p => p.vote !== null);
    if (allVoted) {
      resolveVotes(room);
    }
  });

  // ── restart ──────────────────────────────────────────────────────────────────
  socket.on('restart', (_, callback) => {
    const room = getRoomBySocket(socket.id);
    if (!room) return callback?.({ error: '不在任何房间' });
    if (room.hostId !== socket.id) return callback?.({ error: '只有房主才能重置' });

    // Reset game state
    room.phase = 'waiting';
    room.diceValue = null;
    room.nightTimer = null;
    room.thiefId = null;
    room.result = null;
    room.players.forEach(p => {
      p.role = null;
      p.vote = null;
    });
    // Remove disconnected players
    room.players = room.players.filter(p => p.connected);

    broadcastRoom(room, 'phase_change', { phase: 'waiting' });
    sendPlayerList(room);
    console.log(`[restart] room ${room.id}`);
    callback?.({ ok: true });
  });

  // ── disconnect ───────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[disconnect] ${socket.id}`);
    const room = getRoomBySocket(socket.id);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.connected = false;
    }

    // If host left, transfer host to next connected player
    if (room.hostId === socket.id) {
      const nextHost = room.players.find(p => p.connected && p.id !== socket.id);
      if (nextHost) {
        room.hostId = nextHost.id;
        broadcastRoom(room, 'host_changed', { newHostId: nextHost.id, nickname: nextHost.nickname });
        console.log(`[host_transfer] room ${room.id} → ${nextHost.nickname}`);
      }
    }

    // Broadcast updated player list
    sendPlayerList(room);

    // If room empty and in waiting, clean up
    if (room.players.every(p => !p.connected)) {
      console.log(`[cleanup] room ${room.id} is empty, removing`);
      rooms.delete(room.id);
    }

    // If in voting and someone disconnected, re-check if all remaining voted
    if (room.phase === 'voting') {
      const activePlayers = room.players.filter(p => p.connected);
      const allVoted = activePlayers.every(p => p.vote !== null);
      if (allVoted && activePlayers.length > 0) {
        resolveVotes(room);
      }
    }
  });
});

// ── Vote resolution ──────────────────────────────────────────────────────────

function resolveVotes(room) {
  const activePlayers = room.players.filter(p => p.connected);

  // Count votes per player
  const tally = {};
  activePlayers.forEach(p => {
    if (p.vote) {
      tally[p.vote] = (tally[p.vote] || 0) + 1;
    }
  });

  // Find max votes
  const maxVotes = Math.max(...Object.values(tally));
  const topCandidates = Object.keys(tally).filter(id => tally[id] === maxVotes);

  // Tie-break: random
  const eliminatedId = topCandidates[Math.floor(Math.random() * topCandidates.length)];
  const eliminated = room.players.find(p => p.id === eliminatedId);

  const thief = room.players.find(p => p.id === room.thiefId);
  const thiefEliminated = eliminatedId === room.thiefId;

  room.result = {
    eliminatedId,
    eliminatedNickname: eliminated?.nickname || '未知',
    thiefId: room.thiefId,
    thiefNickname: thief?.nickname || '未知',
    thiefEliminated,
    winner: thiefEliminated ? 'sleepers' : 'thief',
    tally,
    wasTie: topCandidates.length > 1
  };
  room.phase = 'result';

  broadcastRoom(room, 'game_result', room.result);
  broadcastRoom(room, 'phase_change', { phase: 'result' });
  console.log(`[result] room ${room.id}, eliminated=${eliminated?.nickname}, thief=${thief?.nickname}, winner=${room.result.winner}`);
}

// ── Start server ─────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`🧀 奶酪大盗服务器运行在 http://localhost:${PORT}`);
});

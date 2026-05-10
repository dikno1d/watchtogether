/**
 * WatchTogether — Socket.IO server
 * Matches every event used by the Flutter client exactly.
 *
 * Install:  npm install express socket.io
 * Run:      node server.js
 * Deploy:   works as-is on Render / Railway / Fly.io (set PORT env var)
 */

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_CHARS  = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusable chars

// ─── App setup ───────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: {
    origin: '*',          // tighten this in production
    methods: ['GET', 'POST'],
  },
  // Allow both transports the Flutter client requests
  transports: ['websocket', 'polling'],
});

app.get('/', (_req, res) => res.send('WatchTogether server running ✓'));

// ─── In-memory store ─────────────────────────────────────────────────────────
/**
 * rooms: Map<roomId, Room>
 *
 * Room {
 *   id:       string
 *   hostId:   string          — socket.id of current host
 *   members:  Map<socketId, Member>
 *   playback: Playback
 * }
 *
 * Member { id, name, isHost }
 *
 * Playback {
 *   mode:        'youtube' | 'idle'
 *   src:         string | null   — YouTube video ID
 *   playing:     boolean
 *   currentTime: number          — seconds
 *   updatedAt:   number          — Date.now() when last updated
 * }
 */
const rooms = new Map();

// ─── Helpers ─────────────────────────────────────────────────────────────────
function generateRoomId() {
  let id;
  do {
    id = Array.from({ length: ROOM_CODE_LENGTH }, () =>
      ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)]
    ).join('');
  } while (rooms.has(id));
  return id;
}

/** Returns the current estimated playback time accounting for elapsed wall-clock. */
function livePlayback(playback) {
  if (!playback || playback.mode === 'idle') return playback;
  let currentTime = playback.currentTime;
  if (playback.playing) {
    const elapsed = (Date.now() - playback.updatedAt) / 1000;
    currentTime = Math.max(0, currentTime + elapsed);
  }
  return { ...playback, currentTime };
}

/** Broadcast the member list for a room to every socket in that room. */
function broadcastMembers(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const memberList = [...room.members.values()].map(m => ({
    id:     m.id,
    name:   m.name,
    isHost: m.id === room.hostId,
  }));
  io.to(roomId).emit('room:members', memberList);
}

/** Find which room a socket belongs to (if any). */
function roomOfSocket(socketId) {
  for (const [roomId, room] of rooms) {
    if (room.members.has(socketId)) return { roomId, room };
  }
  return null;
}

/** Promote the next member to host after the current host leaves. */
function promoteNextHost(room) {
  const remaining = [...room.members.values()].filter(m => m.id !== room.hostId);
  if (remaining.length === 0) return false;
  const next = remaining[0];
  room.hostId = next.id;
  io.to(next.id).emit('room:promoted-host');
  return true;
}

// ─── Connection handler ───────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[connect]    ${socket.id}`);

  // ── room:create ─────────────────────────────────────────────────────────
  // Client sends: { name: string }
  // Server emits back to this socket: room:created | room:error
  socket.on('room:create', (data) => {
    try {
      const name = (data?.name || '').trim();
      if (!name) {
        return socket.emit('room:error', { error: 'Name is required' });
      }

      const roomId = generateRoomId();
      const room = {
        id:      roomId,
        hostId:  socket.id,
        members: new Map(),
        playback: {
          mode:        'idle',
          src:         null,
          playing:     false,
          currentTime: 0,
          updatedAt:   Date.now(),
        },
      };
      room.members.set(socket.id, { id: socket.id, name, isHost: true });
      rooms.set(roomId, room);

      socket.join(roomId);

      console.log(`[room:create] ${socket.id} (${name}) → room ${roomId}`);

      // Reply only to the creator
      socket.emit('room:created', {
        success: true,
        roomId,
      });

      broadcastMembers(roomId);
    } catch (err) {
      console.error('[room:create] error', err);
      socket.emit('room:error', { error: 'Server error creating room' });
    }
  });

  // ── room:join ────────────────────────────────────────────────────────────
  // Client sends: { name: string, roomId: string }
  // Server emits back to this socket: room:joined | room:error
  socket.on('room:join', (data) => {
    try {
      const name   = (data?.name   || '').trim();
      const roomId = (data?.roomId || '').trim().toUpperCase();

      if (!name) {
        return socket.emit('room:error', { error: 'Name is required' });
      }
      if (!roomId || roomId.length !== ROOM_CODE_LENGTH) {
        return socket.emit('room:error', { error: 'Invalid room code' });
      }

      const room = rooms.get(roomId);
      if (!room) {
        return socket.emit('room:error', { error: 'Room not found' });
      }

      room.members.set(socket.id, { id: socket.id, name, isHost: false });
      socket.join(roomId);

      console.log(`[room:join]   ${socket.id} (${name}) → room ${roomId}`);

      // Reply only to the joiner — include current playback state so the
      // client can seek to the right position immediately.
      socket.emit('room:joined', {
        success: true,
        roomId,
        playback: livePlayback(room.playback),
      });

      broadcastMembers(roomId);
    } catch (err) {
      console.error('[room:join] error', err);
      socket.emit('room:error', { error: 'Server error joining room' });
    }
  });

  // ── playback:update ──────────────────────────────────────────────────────
  // Host sends: { playing: bool, currentTime: number }
  // Server broadcasts playback:sync to the entire room (host included so
  // late-joiners who become host get the echo too).
  socket.on('playback:update', (data) => {
    const found = roomOfSocket(socket.id);
    if (!found) return;
    const { roomId, room } = found;

    // Only the current host may update playback
    if (socket.id !== room.hostId) return;

    room.playback = {
      ...room.playback,
      mode:        room.playback.mode === 'idle' ? 'idle' : room.playback.mode,
      playing:     !!data?.playing,
      currentTime: Number(data?.currentTime) || 0,
      updatedAt:   Date.now(),
    };

    // Broadcast to everyone in the room except the host (host already knows)
    socket.to(roomId).emit('playback:sync', {
      playing:     room.playback.playing,
      currentTime: room.playback.currentTime,
    });
  });

  // ── playback:time ────────────────────────────────────────────────────────
  // Host sends periodic heartbeat: { playing: bool, currentTime: number }
  // Server relays to viewers so they can stay in sync.
  socket.on('playback:time', (data) => {
    const found = roomOfSocket(socket.id);
    if (!found) return;
    const { roomId, room } = found;

    if (socket.id !== room.hostId) return;

    room.playback = {
      ...room.playback,
      playing:     !!data?.playing,
      currentTime: Number(data?.currentTime) || 0,
      updatedAt:   Date.now(),
    };

    socket.to(roomId).emit('playback:time', {
      playing:     room.playback.playing,
      currentTime: room.playback.currentTime,
    });
  });

  // ── youtube:load ─────────────────────────────────────────────────────────
  // Host sends: { videoId: string }
  // Server broadcasts to all viewers in the room.
  socket.on('youtube:load', (data) => {
    const found = roomOfSocket(socket.id);
    if (!found) return;
    const { roomId, room } = found;

    if (socket.id !== room.hostId) return;

    const videoId = (data?.videoId || '').trim();
    if (!videoId) return;

    room.playback = {
      mode:        'youtube',
      src:         videoId,
      playing:     true,
      currentTime: 0,
      updatedAt:   Date.now(),
    };

    console.log(`[youtube:load] room ${roomId} → ${videoId}`);

    // Send to everyone except the host (host already loaded it locally)
    socket.to(roomId).emit('youtube:load', { videoId });
  });

  // ── chat:send ────────────────────────────────────────────────────────────
  // Any member sends: { message: string }
  // Server broadcasts chat:message to the entire room.
  socket.on('chat:send', (data) => {
    const found = roomOfSocket(socket.id);
    if (!found) return;
    const { roomId, room } = found;

    const message = (data?.message || '').trim();
    if (!message) return;

    const member = room.members.get(socket.id);
    if (!member) return;

    const payload = {
      senderId:   socket.id,
      senderName: member.name,
      message,
      ts:         Date.now(),
    };

    // Broadcast to everyone in the room INCLUDING the sender so they see
    // their own message in the chat list (the app filters overlay by senderId).
    io.to(roomId).emit('chat:message', payload);
  });

  // ── disconnect ───────────────────────────────────────────────────────────
  socket.on('disconnect', (reason) => {
    console.log(`[disconnect] ${socket.id} (${reason})`);

    const found = roomOfSocket(socket.id);
    if (!found) return;
    const { roomId, room } = found;

    const wasHost = socket.id === room.hostId;
    room.members.delete(socket.id);

    if (room.members.size === 0) {
      // Last person left — clean up the room
      rooms.delete(roomId);
      console.log(`[room:closed] ${roomId} (empty)`);
      return;
    }

    if (wasHost) {
      // Assign a new host and notify them
      promoteNextHost(room);
    }

    broadcastMembers(roomId);
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`WatchTogether server listening on port ${PORT}`);
});

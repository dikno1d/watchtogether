// ============================================================
//  WatchTogether — Server for Vercel
//  Serverless Socket.io implementation
// ============================================================

const express = require("express");
const { Server } = require("socket.io");

// In-memory room state (note: resets on Vercel serverless function cold starts)
const rooms = {};

const COLORS = [
  "#FF6B6B", "#FFD93D", "#6BCB77", "#4D96FF",
  "#C77DFF", "#FF9A3C", "#00C9A7", "#F72585",
  "#48CAE4", "#E9C46A",
];

function getRoom(roomId) {
  return rooms[roomId];
}

function serverTime(room) {
  if (!room.video.playing) return room.video.currentTime;
  const elapsed = (Date.now() - room.video.updatedAt) / 1000;
  return room.video.currentTime + elapsed;
}

function roomInfo(roomId) {
  const room = rooms[roomId];
  if (!room) return null;
  return {
    roomId,
    host: room.host,
    members: Array.from(room.members.entries()).map(([id, d]) => ({
      id, name: d.name, color: d.color,
    })),
    video: {
      url: room.video.url,
      playing: room.video.playing,
      currentTime: serverTime(room),
    },
  };
}

const app = express();

// Create HTTP server and Socket.io
const server = require("http").createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingInterval: 10000,
  pingTimeout: 5000,
  path: '/api/socket',
  transports: ['websocket', 'polling']
});

// Socket.io connection handling
io.on("connection", (socket) => {
  console.log("connect", socket.id);

  // ─ Create room ─────────────────────────────────────────
  socket.on("create_room", ({ name }, cb) => {
    const roomId = Math.random().toString(36).slice(2, 8).toUpperCase();
    const color = COLORS[0];
    rooms[roomId] = {
      host: socket.id,
      members: new Map([[socket.id, { name, color }]]),
      video: { url: "", playing: false, currentTime: 0, updatedAt: Date.now() },
    };
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.name = name;
    console.log(`Room ${roomId} created by ${name}`);
    cb({ ok: true, roomId, info: roomInfo(roomId) });
    io.to(roomId).emit("room_update", roomInfo(roomId));
  });

  // ─ Join room ────────────────────────────────────────────
  socket.on("join_room", ({ roomId, name }, cb) => {
    const room = getRoom(roomId);
    if (!room) return cb({ ok: false, error: "Room not found" });
    if (room.members.size >= 10) return cb({ ok: false, error: "Room is full (10/10)" });

    const usedColors = new Set([...room.members.values()].map((m) => m.color));
    const color = COLORS.find((c) => !usedColors.has(c)) || COLORS[room.members.size % COLORS.length];
    room.members.set(socket.id, { name, color });
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.name = name;

    console.log(`${name} joined ${roomId}`);
    cb({ ok: true, roomId, info: roomInfo(roomId) });
    io.to(roomId).emit("room_update", roomInfo(roomId));
    io.to(roomId).emit("chat_message", {
      system: true,
      text: `${name} joined the room`,
      ts: Date.now(),
    });
  });

  // ─ Video control (host only) ────────────────────────────
  socket.on("video_load", ({ url }) => {
    const room = getRoom(socket.data.roomId);
    if (!room || room.host !== socket.id) return;
    room.video = { url, playing: false, currentTime: 0, updatedAt: Date.now() };
    io.to(socket.data.roomId).emit("video_state", {
      url, playing: false, currentTime: 0,
    });
  });

  socket.on("video_play", () => {
    const room = getRoom(socket.data.roomId);
    if (!room || room.host !== socket.id) return;
    const ct = serverTime(room);
    room.video.playing = true;
    room.video.currentTime = ct;
    room.video.updatedAt = Date.now();
    io.to(socket.data.roomId).emit("video_state", {
      url: room.video.url, playing: true, currentTime: ct,
    });
  });

  socket.on("video_pause", ({ currentTime }) => {
    const room = getRoom(socket.data.roomId);
    if (!room || room.host !== socket.id) return;
    room.video.playing = false;
    room.video.currentTime = currentTime;
    room.video.updatedAt = Date.now();
    io.to(socket.data.roomId).emit("video_state", {
      url: room.video.url, playing: false, currentTime,
    });
  });

  socket.on("video_seek", ({ currentTime }) => {
    const room = getRoom(socket.data.roomId);
    if (!room || room.host !== socket.id) return;
    room.video.currentTime = currentTime;
    room.video.updatedAt = Date.now();
    io.to(socket.data.roomId).emit("video_state", {
      url: room.video.url, playing: room.video.playing, currentTime,
    });
  });

  // ─ Chat ─────────────────────────────────────────────────
  socket.on("chat_send", ({ text }) => {
    const room = getRoom(socket.data.roomId);
    if (!room || !text.trim()) return;
    const member = room.members.get(socket.id);
    io.to(socket.data.roomId).emit("chat_message", {
      system: false,
      senderId: socket.id,
      name: member?.name || "Unknown",
      color: member?.color || "#fff",
      text: text.trim().slice(0, 300),
      ts: Date.now(),
    });
  });

  // ─ Heartbeat sync ───────────────────────────────────────
  socket.on("heartbeat", ({ currentTime }) => {
    const room = getRoom(socket.data.roomId);
    if (!room || room.host !== socket.id) return;
    room.video.currentTime = currentTime;
    room.video.updatedAt = Date.now();
    socket.to(socket.data.roomId).emit("sync_time", { currentTime });
  });

  // ─ Disconnect ───────────────────────────────────────────
  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    const room = getRoom(roomId);
    if (!room) return;

    const member = room.members.get(socket.id);
    room.members.delete(socket.id);

    if (room.members.size === 0) {
      delete rooms[roomId];
      console.log(`Room ${roomId} deleted (empty)`);
      return;
    }

    // Transfer host if needed
    if (room.host === socket.id) {
      room.host = [...room.members.keys()][0];
      io.to(room.host).emit("you_are_host");
      console.log(`Host transferred in ${roomId}`);
    }

    io.to(roomId).emit("room_update", roomInfo(roomId));
    if (member) {
      io.to(roomId).emit("chat_message", {
        system: true,
        text: `${member.name} left the room`,
        ts: Date.now(),
      });
    }
  });
});

// Export the server for Vercel
module.exports = (req, res) => {
  if (req.url === '/api/socket') {
    // Handle Socket.io connections
    server.emit('request', req, res);
  } else {
    // Serve static files or 404
    res.status(404).send('Not found');
  }
};

// Start server locally if not in Vercel
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`\n🎬 WatchTogether server running on http://localhost:${PORT}\n`);
  });
}

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  transports: ["websocket", "polling"],
});

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ─── Room state ───────────────────────────────────────────────────────────────
const rooms = new Map();
// rooms[roomId] = {
//   host: socketId,
//   members: Map<socketId, { name, isHost }>,
//   playback: { mode, src, playing, currentTime, lastSyncAt },
//   chat: []
// }

function getRoomData(roomId) {
  return rooms.get(roomId);
}

function broadcastMembers(roomId) {
  const room = getRoomData(roomId);
  if (!room) return;
  const members = Array.from(room.members.entries()).map(([id, data]) => ({
    id,
    name: data.name,
    isHost: data.isHost,
  }));
  io.to(roomId).emit("room:members", members);
}

// ─── TURN/STUN ICE config ─────────────────────────────────────────────────────
// Uses free public STUN servers + Metered/Open Relay TURN (free tier, no key needed)
// For production, replace with your own Twilio/Metered TURN credentials.
const ICE_SERVERS = [
  // STUN servers
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun3.l.google.com:19302" },
  { urls: "stun:stun4.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.relay.metered.ca:80" },
  // TURN servers (Open Relay - free, no key required)
  {
    urls: "turn:a.relay.metered.ca:80",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:a.relay.metered.ca:80?transport=tcp",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:a.relay.metered.ca:443",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:a.relay.metered.ca:443?transport=tcp",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turns:a.relay.metered.ca:443?transport=tcp",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
];

// Serve ICE config to clients
app.get("/api/ice-servers", (req, res) => {
  res.json({ iceServers: ICE_SERVERS });
});

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // ── Create Room ──
  socket.on("room:create", ({ name }, cb) => {
    const roomId = uuidv4().slice(0, 6).toUpperCase();
    const room = {
      host: socket.id,
      members: new Map(),
      playback: {
        mode: null, // 'youtube' | 'screenshare'
        src: null,
        playing: false,
        currentTime: 0,
        lastSyncAt: Date.now(),
      },
      chat: [],
    };
    room.members.set(socket.id, { name, isHost: true });
    rooms.set(roomId, room);

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.name = name;

    console.log(`[Room] Created ${roomId} by ${name}`);
    cb({ success: true, roomId, isHost: true, iceServers: ICE_SERVERS });
    broadcastMembers(roomId);
  });

  // ── Join Room ──
  socket.on("room:join", ({ name, roomId }, cb) => {
    const room = getRoomData(roomId);
    if (!room) {
      return cb({ success: false, error: "Room not found" });
    }

    room.members.set(socket.id, { name, isHost: false });
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.name = name;

    // Sync current playback state to new joiner
    const elapsed = (Date.now() - room.playback.lastSyncAt) / 1000;
    const syncedTime = room.playback.playing
      ? room.playback.currentTime + elapsed
      : room.playback.currentTime;

    console.log(`[Room] ${name} joined ${roomId}`);
    cb({
      success: true,
      roomId,
      isHost: false,
      iceServers: ICE_SERVERS,
      playback: { ...room.playback, currentTime: syncedTime },
      hostId: room.host,
    });

    // Notify others
    socket.to(roomId).emit("room:user-joined", {
      id: socket.id,
      name,
    });

    broadcastMembers(roomId);

    // Tell new joiner who the screen sharer is (if any)
    if (room.playback.mode === "screenshare" && room.playback.sharerId) {
      socket.emit("screenshare:active", { sharerId: room.playback.sharerId });
    }
  });

  // ── Chat ──
  socket.on("chat:send", ({ message }) => {
    const roomId = socket.data.roomId;
    const room = getRoomData(roomId);
    if (!room) return;

    const member = room.members.get(socket.id);
    const msg = {
      id: uuidv4(),
      senderId: socket.id,
      senderName: member?.name || "Unknown",
      message,
      ts: Date.now(),
    };
    room.chat.push(msg);
    io.to(roomId).emit("chat:message", msg);
  });

  // ── Playback: Host controls ──
  socket.on("playback:update", (data) => {
    const roomId = socket.data.roomId;
    const room = getRoomData(roomId);
    if (!room || room.host !== socket.id) return;

    Object.assign(room.playback, {
      ...data,
      lastSyncAt: Date.now(),
    });

    socket.to(roomId).emit("playback:sync", {
      ...room.playback,
    });
  });

  // ── Playback: Time sync (periodic) ──
  socket.on("playback:time", ({ currentTime, playing }) => {
    const roomId = socket.data.roomId;
    const room = getRoomData(roomId);
    if (!room || room.host !== socket.id) return;

    room.playback.currentTime = currentTime;
    room.playback.playing = playing;
    room.playback.lastSyncAt = Date.now();

    // Broadcast to viewers
    socket.to(roomId).emit("playback:time", { currentTime, playing });
  });

  // ── WebRTC Signaling for Screen Share ──
  socket.on("webrtc:offer", ({ to, offer }) => {
    io.to(to).emit("webrtc:offer", { from: socket.id, offer });
  });

  socket.on("webrtc:answer", ({ to, answer }) => {
    io.to(to).emit("webrtc:answer", { from: socket.id, answer });
  });

  socket.on("webrtc:ice-candidate", ({ to, candidate }) => {
    io.to(to).emit("webrtc:ice-candidate", { from: socket.id, candidate });
  });

  // ── Screen Share: Start ──
  socket.on("screenshare:start", () => {
    const roomId = socket.data.roomId;
    const room = getRoomData(roomId);
    if (!room) return;

    room.playback.mode = "screenshare";
    room.playback.sharerId = socket.id;

    // Tell all others to expect a WebRTC stream from this sharer
    socket.to(roomId).emit("screenshare:active", { sharerId: socket.id });
    console.log(
      `[Screen] ${socket.data.name} started sharing in room ${roomId}`
    );
  });

  // ── Screen Share: Stop ──
  socket.on("screenshare:stop", () => {
    const roomId = socket.data.roomId;
    const room = getRoomData(roomId);
    if (!room) return;

    room.playback.mode = null;
    room.playback.sharerId = null;

    io.to(roomId).emit("screenshare:stopped");
    console.log(
      `[Screen] ${socket.data.name} stopped sharing in room ${roomId}`
    );
  });

  // ── YouTube mode: load video ──
  socket.on("youtube:load", ({ videoId }) => {
    const roomId = socket.data.roomId;
    const room = getRoomData(roomId);
    if (!room || room.host !== socket.id) return;

    room.playback.mode = "youtube";
    room.playback.src = videoId;
    room.playback.playing = false;
    room.playback.currentTime = 0;
    room.playback.lastSyncAt = Date.now();

    io.to(roomId).emit("youtube:load", { videoId });
  });

  // ── Disconnect ──
  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    const room = getRoomData(roomId);
    if (!room) return;

    room.members.delete(socket.id);
    console.log(`[-] ${socket.data.name} left room ${roomId}`);

    // If host left, assign new host
    if (room.host === socket.id && room.members.size > 0) {
      const newHostId = room.members.keys().next().value;
      room.host = newHostId;
      room.members.get(newHostId).isHost = true;
      io.to(newHostId).emit("room:promoted-host");
      io.to(roomId).emit("room:new-host", { id: newHostId });
    }

    // If room empty, delete it
    if (room.members.size === 0) {
      rooms.delete(roomId);
      console.log(`[Room] ${roomId} deleted (empty)`);
    } else {
      socket.to(roomId).emit("room:user-left", { id: socket.id });
      broadcastMembers(roomId);

      // If screen sharer left, notify
      if (room.playback.sharerId === socket.id) {
        room.playback.mode = null;
        room.playback.sharerId = null;
        io.to(roomId).emit("screenshare:stopped");
      }
    }
  });
});

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ WatchTogether server running on http://localhost:${PORT}`);
});

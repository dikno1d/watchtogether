const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingInterval: 1000,
  pingTimeout: 5000,
  transports: ['websocket', 'polling']
});

app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const rooms = {};
const COLORS = [
  "#FF6B6B", "#FFD93D", "#6BCB77", "#4D96FF",
  "#C77DFF", "#FF9A3C", "#00C9A7", "#F72585",
  "#48CAE4", "#E9C46A"
];

function getRoom(roomId) {
  return rooms[roomId];
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
    isSharing: room.isSharing,
    screenShareAvailable: room.screenShareAvailable
  };
}

io.on("connection", (socket) => {
  console.log("✅ Connected:", socket.id);

  socket.on("create_room", ({ name }, cb) => {
    const roomId = Math.random().toString(36).slice(2, 8).toUpperCase();
    const color = COLORS[0];
    
    rooms[roomId] = {
      host: socket.id,
      members: new Map([[socket.id, { name, color, socketId: socket.id }]]),
      isSharing: false,
      screenShareAvailable: false,
      peerConnections: new Map(),
      lastUpdate: Date.now()
    };
    
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.name = name;
    
    console.log(`🏠 Room ${roomId} created by ${name}`);
    cb({ ok: true, roomId, info: roomInfo(roomId) });
    io.to(roomId).emit("room_update", roomInfo(roomId));
  });

  socket.on("join_room", ({ roomId, name }, cb) => {
    const room = getRoom(roomId);
    
    if (!room) {
      return cb({ ok: false, error: "❌ Room not found" });
    }
    
    if (room.members.size >= 20) {
      return cb({ ok: false, error: "❌ Room is full (max 20 members)" });
    }

    const usedColors = new Set([...room.members.values()].map((m) => m.color));
    const color = COLORS.find((c) => !usedColors.has(c)) || COLORS[room.members.size % COLORS.length];
    
    room.members.set(socket.id, { name, color, socketId: socket.id });
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.name = name;

    console.log(`👤 ${name} joined ${roomId}`);
    cb({ ok: true, roomId, info: roomInfo(roomId) });
    
    io.to(roomId).emit("room_update", roomInfo(roomId));
    io.to(roomId).emit("chat_message", {
      system: true,
      text: `✨ ${name} joined the room`,
      ts: Date.now()
    });
  });

  // WebRTC Signaling
  socket.on("start_screen_share", async () => {
    const room = getRoom(socket.data.roomId);
    if (!room || room.host !== socket.id) return;
    
    room.isSharing = true;
    room.screenShareAvailable = true;
    io.to(socket.data.roomId).emit("screen_share_started");
    console.log(`📺 Screen sharing started in ${socket.data.roomId}`);
  });

  socket.on("stop_screen_share", () => {
    const room = getRoom(socket.data.roomId);
    if (!room || room.host !== socket.id) return;
    
    room.isSharing = false;
    room.screenShareAvailable = false;
    io.to(socket.data.roomId).emit("screen_share_stopped");
    console.log(`🛑 Screen sharing stopped in ${socket.data.roomId}`);
  });

  // WebRTC signaling for viewers
  socket.on("viewer_ready", ({ viewerId }) => {
    const room = getRoom(socket.data.roomId);
    if (!room) return;
    
    socket.to(room.host).emit("viewer_ready", { viewerId: socket.id });
  });

  socket.on("offer", ({ offer, viewerId }) => {
    const room = getRoom(socket.data.roomId);
    if (!room || room.host !== socket.id) return;
    
    io.to(viewerId).emit("offer", { offer, hostId: socket.id });
  });

  socket.on("answer", ({ answer, hostId }) => {
    const room = getRoom(socket.data.roomId);
    if (!room) return;
    
    io.to(hostId).emit("answer", { answer, viewerId: socket.id });
  });

  socket.on("ice_candidate", ({ candidate, targetId }) => {
    const room = getRoom(socket.data.roomId);
    if (!room) return;
    
    io.to(targetId).emit("ice_candidate", { candidate, senderId: socket.id });
  });

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
      ts: Date.now()
    });
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    const room = getRoom(roomId);
    if (!room) return;

    const member = room.members.get(socket.id);
    const wasHost = room.host === socket.id;
    room.members.delete(socket.id);

    if (room.members.size === 0) {
      delete rooms[roomId];
      console.log(`🗑️ Room ${roomId} deleted`);
      return;
    }

    if (wasHost) {
      // Stop screen sharing if host disconnects
      room.isSharing = false;
      room.screenShareAvailable = false;
      
      const newHostId = [...room.members.keys()][0];
      room.host = newHostId;
      io.to(newHostId).emit("you_are_host");
      io.to(roomId).emit("host_changed", { newHost: newHostId });
      io.to(roomId).emit("screen_share_stopped");
      console.log(`👑 Host transferred to ${newHostId}`);
    }

    io.to(roomId).emit("room_update", roomInfo(roomId));
    if (member) {
      io.to(roomId).emit("chat_message", {
        system: true,
        text: `👋 ${member.name} left the room`,
        ts: Date.now()
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎬 Screen Share Watch Party Server running!`);
  console.log(`📍 http://localhost:${PORT}`);
});

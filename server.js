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

// Endpoint to get TURN credentials
app.get("/api/turn-credentials", async (req, res) => {
  try {
    const response = await fetch("https://watchfuno.metered.live/api/v1/turn/credentials?apiKey=75db913ed299374807cf58b316566026cf87");
    const iceServers = await response.json();
    res.json(iceServers);
  } catch (error) {
    console.error("Error fetching TURN credentials:", error);
    // Fallback to STUN only
    res.json([{ urls: "stun:stun.l.google.com:19302" }]);
  }
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
    mode: room.mode,
    videoId: room.videoId,
    isPlaying: room.isPlaying,
    currentTime: room.currentTime,
    isSharing: room.isSharing
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
      mode: null,
      videoId: null,
      isPlaying: false,
      currentTime: 0,
      isSharing: false,
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
    
    // Send current state to new joiner
    if (room.mode === 'youtube' && room.videoId) {
      socket.emit("youtube_loaded", {
        videoId: room.videoId,
        currentTime: room.currentTime,
        isPlaying: room.isPlaying
      });
    } else if (room.mode === 'screenshare' && room.isSharing) {
      socket.emit("screen_share_started");
      // Notify host to send offer to new viewer
      if (room.host) {
        io.to(room.host).emit("new_viewer_joined", { viewerId: socket.id });
      }
    }
    
    io.to(roomId).emit("room_update", roomInfo(roomId));
    io.to(roomId).emit("chat_message", {
      system: true,
      text: `✨ ${name} joined the room`,
      ts: Date.now()
    });
  });

  // YouTube Sync Events with improved sync
  socket.on("load_youtube", ({ videoId }, cb) => {
    const room = getRoom(socket.data.roomId);
    if (!room || room.host !== socket.id) return;
    
    room.mode = "youtube";
    room.videoId = videoId;
    room.isPlaying = false;
    room.currentTime = 0;
    room.isSharing = false;
    room.lastUpdate = Date.now();
    
    io.to(socket.data.roomId).emit("youtube_loaded", {
      videoId: videoId,
      currentTime: 0,
      isPlaying: false
    });
    
    cb({ success: true });
    console.log(`🎬 YouTube loaded in ${socket.data.roomId}: ${videoId}`);
  });

  socket.on("youtube_play", ({ currentTime }) => {
    const room = getRoom(socket.data.roomId);
    if (!room || room.host !== socket.id) return;
    
    room.isPlaying = true;
    room.currentTime = currentTime;
    room.lastUpdate = Date.now();
    
    io.to(socket.data.roomId).emit("youtube_play", { currentTime });
  });

  socket.on("youtube_pause", ({ currentTime }) => {
    const room = getRoom(socket.data.roomId);
    if (!room || room.host !== socket.id) return;
    
    room.isPlaying = false;
    room.currentTime = currentTime;
    room.lastUpdate = Date.now();
    
    io.to(socket.data.roomId).emit("youtube_pause", { currentTime });
  });

  socket.on("youtube_seek", ({ currentTime }) => {
    const room = getRoom(socket.data.roomId);
    if (!room || room.host !== socket.id) return;
    
    room.currentTime = currentTime;
    room.lastUpdate = Date.now();
    
    io.to(socket.data.roomId).emit("youtube_seek", { currentTime });
  });

  socket.on("youtube_sync_request", ({ currentTime, isPlaying }) => {
    const room = getRoom(socket.data.roomId);
    if (!room) return;
    
    socket.to(room.host).emit("youtube_sync_response", { currentTime, isPlaying });
  });

  // Screen Share Events
  socket.on("start_screen_share", () => {
    const room = getRoom(socket.data.roomId);
    if (!room || room.host !== socket.id) return;
    
    room.mode = "screenshare";
    room.isSharing = true;
    room.videoId = null;
    room.currentTime = 0;
    
    io.to(socket.data.roomId).emit("screen_share_started");
    console.log(`📺 Screen sharing started in ${socket.data.roomId}`);
  });

  socket.on("stop_screen_share", () => {
    const room = getRoom(socket.data.roomId);
    if (!room || room.host !== socket.id) return;
    
    room.isSharing = false;
    room.mode = null;
    
    // Close all peer connections
    for (const [viewerId, pc] of room.peerConnections) {
      try { pc.close(); } catch(e) {}
    }
    room.peerConnections.clear();
    
    io.to(socket.data.roomId).emit("screen_share_stopped");
    console.log(`🛑 Screen sharing stopped in ${socket.data.roomId}`);
  });

  // WebRTC Signaling
  socket.on("viewer_ready", () => {
    const room = getRoom(socket.data.roomId);
    if (!room) return;
    
    if (room.isSharing && room.host) {
      io.to(room.host).emit("offer_request", { viewerId: socket.id });
    }
  });
  
  socket.on("new_viewer_joined", ({ viewerId }) => {
    const room = getRoom(socket.data.roomId);
    if (!room || room.host !== socket.id) return;
    
    if (room.isSharing) {
      io.to(room.host).emit("offer_request", { viewerId });
    }
  });

  socket.on("offer_request", ({ viewerId }) => {
    const room = getRoom(socket.data.roomId);
    if (!room || room.host !== socket.id) return;
    
    socket.emit("create_offer_for_viewer", { viewerId });
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
      for (const [viewerId, pc] of room.peerConnections) {
        try { pc.close(); } catch(e) {}
      }
      delete rooms[roomId];
      console.log(`🗑️ Room ${roomId} deleted`);
      return;
    }

    if (wasHost) {
      room.isSharing = false;
      room.mode = null;
      
      for (const [viewerId, pc] of room.peerConnections) {
        try { pc.close(); } catch(e) {}
      }
      room.peerConnections.clear();
      
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
  console.log(`\n🎬 Ultimate Watch Party Server running!`);
  console.log(`📍 http://localhost:${PORT}`);
  console.log(`\n✨ Features:`);
  console.log(`  • TURN Server enabled for cross-region connectivity`);
  console.log(`  • YouTube Sync - Perfect synchronization`);
  console.log(`  • Screen Share - Watch ANY content together`);
  console.log(`  • Auto-sync for new joiners`);
});

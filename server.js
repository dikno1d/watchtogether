const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const axios = require("axios");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingInterval: 3000,
  pingTimeout: 8000,
  transports: ['websocket', 'polling']
});

app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Video info proxy - get video metadata from any URL
app.get("/api/video-info", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "No URL provided" });
  
  try {
    // Detect video type
    const videoInfo = await detectVideoSource(url);
    res.json(videoInfo);
  } catch (error) {
    console.error("Video detection error:", error);
    res.status(500).json({ error: "Could not fetch video info" });
  }
});

async function detectVideoSource(url) {
  // YouTube
  if (url.includes('youtube.com') || url.includes('youtu.be')) {
    const videoId = extractYouTubeId(url);
    return {
      type: 'youtube',
      embedUrl: `https://www.youtube.com/embed/${videoId}`,
      videoId: videoId,
      title: 'YouTube Video',
      platform: 'youtube'
    };
  }
  
  // Vimeo
  if (url.includes('vimeo.com')) {
    const videoId = url.match(/vimeo\.com\/(\d+)/)?.[1];
    return {
      type: 'vimeo',
      embedUrl: `https://player.vimeo.com/video/${videoId}`,
      videoId: videoId,
      title: 'Vimeo Video',
      platform: 'vimeo'
    };
  }
  
  // Dailymotion
  if (url.includes('dailymotion.com')) {
    const videoId = url.match(/dailymotion\.com\/video\/([a-zA-Z0-9]+)/)?.[1];
    return {
      type: 'dailymotion',
      embedUrl: `https://www.dailymotion.com/embed/video/${videoId}`,
      videoId: videoId,
      title: 'Dailymotion Video',
      platform: 'dailymotion'
    };
  }
  
  // Twitch
  if (url.includes('twitch.tv')) {
    const channel = url.match(/twitch\.tv\/([^\/?]+)/)?.[1];
    return {
      type: 'twitch',
      embedUrl: `https://player.twitch.tv/?channel=${channel}&parent=${process.env.DOMAIN || 'localhost'}`,
      videoId: channel,
      title: `Twitch: ${channel}`,
      platform: 'twitch'
    };
  }
  
  // Direct MP4/WebM video URL
  if (url.match(/\.(mp4|webm|ogg|mov|mkv)(\?|$)/i)) {
    return {
      type: 'direct',
      directUrl: url,
      title: 'Video File',
      platform: 'direct'
    };
  }
  
  // Generic embed - try to detect
  return {
    type: 'generic',
    url: url,
    title: 'Video',
    platform: 'generic'
  };
}

function extractYouTubeId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&?#]+)/,
    /youtube\.com\/embed\/([^?]+)/
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// Room management
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
    video: room.video,
    isPlaying: room.isPlaying,
    currentTime: room.currentTime
  };
}

io.on("connection", (socket) => {
  console.log("✅ Connected:", socket.id);

  socket.on("create_room", ({ name }, cb) => {
    const roomId = Math.random().toString(36).slice(2, 8).toUpperCase();
    const color = COLORS[0];
    
    rooms[roomId] = {
      host: socket.id,
      members: new Map([[socket.id, { name, color }]]),
      video: null,
      isPlaying: false,
      currentTime: 0,
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
    
    room.members.set(socket.id, { name, color });
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

  socket.on("load_video", ({ videoInfo }, cb) => {
    const room = getRoom(socket.data.roomId);
    if (!room || room.host !== socket.id) return;
    
    room.video = videoInfo;
    room.isPlaying = false;
    room.currentTime = 0;
    room.lastUpdate = Date.now();
    
    io.to(socket.data.roomId).emit("video_loaded", {
      video: videoInfo,
      currentTime: 0,
      isPlaying: false
    });
    
    cb({ success: true });
    console.log(`🎬 Video loaded in ${socket.data.roomId}: ${videoInfo.platform}`);
  });

  socket.on("play_video", ({ currentTime }) => {
    const room = getRoom(socket.data.roomId);
    if (!room || room.host !== socket.id) return;
    
    room.isPlaying = true;
    room.currentTime = currentTime;
    room.lastUpdate = Date.now();
    
    io.to(socket.data.roomId).emit("video_play", { currentTime });
  });

  socket.on("pause_video", ({ currentTime }) => {
    const room = getRoom(socket.data.roomId);
    if (!room || room.host !== socket.id) return;
    
    room.isPlaying = false;
    room.currentTime = currentTime;
    room.lastUpdate = Date.now();
    
    io.to(socket.data.roomId).emit("video_pause", { currentTime });
  });

  socket.on("seek_video", ({ currentTime }) => {
    const room = getRoom(socket.data.roomId);
    if (!room || room.host !== socket.id) return;
    
    room.currentTime = currentTime;
    room.lastUpdate = Date.now();
    
    io.to(socket.data.roomId).emit("video_seek", { currentTime });
  });

  socket.on("sync_request", () => {
    const room = getRoom(socket.data.roomId);
    if (!room) return;
    
    socket.emit("sync_response", {
      isPlaying: room.isPlaying,
      currentTime: room.currentTime
    });
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
      const newHostId = [...room.members.keys()][0];
      room.host = newHostId;
      io.to(newHostId).emit("you_are_host");
      io.to(roomId).emit("host_changed", { newHost: newHostId });
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
  console.log(`\n🎬 Universal Watch Party Server running!`);
  console.log(`📍 http://localhost:${PORT}`);
  console.log(`🌍 Ready for any video platform!\n`);
});

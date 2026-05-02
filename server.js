const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const ytdl = require("ytdl-core");
const cors = require("cors");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingInterval: 5000,
  pingTimeout: 10000,
  transports: ['websocket', 'polling']
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Video streaming endpoint - server streams YouTube directly
app.get("/stream/:videoId", async (req, res) => {
  const videoId = req.params.videoId;
  const range = req.headers.range;
  
  if (!videoId) {
    return res.status(400).send("Video ID required");
  }
  
  try {
    const info = await ytdl.getInfo(videoId);
    const format = ytdl.chooseFormat(info.formats, { 
      quality: 'lowest', // Use lowest for smooth streaming
      filter: 'audioandvideo' 
    });
    
    const videoUrl = format.url;
    
    // Proxy the video stream
    const https = require('https');
    const request = https.get(videoUrl, (response) => {
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': response.headers['content-length'],
        'Accept-Ranges': 'bytes',
      });
      response.pipe(res);
    });
    
    request.on('error', (err) => {
      console.error('Stream error:', err);
      res.status(500).send('Stream error');
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send('Error fetching video');
  }
});

// Room storage
const rooms = {};
const COLORS = [
  "#FF6B6B", "#FFD93D", "#6BCB77", "#4D96FF",
  "#C77DFF", "#FF9A3C", "#00C9A7", "#F72585",
  "#48CAE4", "#E9C46A",
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
      id,
      name: d.name,
      color: d.color,
    })),
    video: room.video,
    isPlaying: room.isPlaying,
    currentTime: room.currentTime,
  };
}

io.on("connection", (socket) => {
  console.log("✅ User connected:", socket.id);

  socket.on("create_room", ({ name }, cb) => {
    const roomId = Math.random().toString(36).slice(2, 8).toUpperCase();
    const color = COLORS[0];
    
    rooms[roomId] = {
      host: socket.id,
      members: new Map([[socket.id, { name, color }]]),
      video: null,
      videoId: null,
      isPlaying: false,
      currentTime: 0,
      lastUpdate: Date.now(),
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
    
    if (room.members.size >= 10) {
      return cb({ ok: false, error: "❌ Room is full (max 10 members)" });
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
      ts: Date.now(),
    });
  });

  socket.on("load_video", async ({ url }, cb) => {
    const room = getRoom(socket.data.roomId);
    if (!room || room.host !== socket.id) return;
    
    try {
      // Extract video ID
      let videoId = null;
      let match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&?#]+)/);
      if (match) videoId = match[1];
      
      if (!videoId) {
        cb({ error: "Invalid YouTube URL" });
        return;
      }
      
      const videoInfo = await ytdl.getInfo(videoId);
      
      room.video = {
        id: videoId,
        title: videoInfo.videoDetails.title,
        duration: parseInt(videoInfo.videoDetails.lengthSeconds),
        thumbnail: videoInfo.videoDetails.thumbnails[0].url,
      };
      room.videoId = videoId;
      room.currentTime = 0;
      room.isPlaying = false;
      
      io.to(socket.data.roomId).emit("video_loaded", {
        video: room.video,
        streamUrl: `/stream/${videoId}`,
      });
      
      cb({ success: true, video: room.video });
      console.log(`🎬 Video loaded in ${socket.data.roomId}: ${room.video.title}`);
    } catch (error) {
      console.error("Load video error:", error);
      cb({ error: "Failed to load video" });
    }
  });

  socket.on("play_video", () => {
    const room = getRoom(socket.data.roomId);
    if (!room || room.host !== socket.id) return;
    
    room.isPlaying = true;
    room.lastUpdate = Date.now();
    io.to(socket.data.roomId).emit("video_play", { currentTime: room.currentTime });
  });

  socket.on("pause_video", () => {
    const room = getRoom(socket.data.roomId);
    if (!room || room.host !== socket.id) return;
    
    room.isPlaying = false;
    io.to(socket.data.roomId).emit("video_pause", { currentTime: room.currentTime });
  });

  socket.on("seek_video", ({ currentTime }) => {
    const room = getRoom(socket.data.roomId);
    if (!room || room.host !== socket.id) return;
    
    room.currentTime = currentTime;
    io.to(socket.data.roomId).emit("video_seek", { currentTime });
  });

  socket.on("sync_time", ({ currentTime }) => {
    const room = getRoom(socket.data.roomId);
    if (!room || room.host !== socket.id) return;
    
    room.currentTime = currentTime;
    socket.to(socket.data.roomId).emit("time_sync", { currentTime });
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
      ts: Date.now(),
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

    // Transfer host if needed
    if (wasHost) {
      const newHost = [...room.members.keys()][0];
      room.host = newHost;
      io.to(newHost).emit("you_are_host");
      io.to(roomId).emit("host_changed", { newHostId: newHost });
      console.log(`👑 Host transferred to ${newHost} in ${roomId}`);
    }

    io.to(roomId).emit("room_update", roomInfo(roomId));
    if (member) {
      io.to(roomId).emit("chat_message", {
        system: true,
        text: `👋 ${member.name} left the room`,
        ts: Date.now(),
      });
    }
    console.log(`❌ User disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎬 WatchTogether Streaming Server running!`);
  console.log(`📍 Local: http://localhost:${PORT}`);
  console.log(`🌍 Ready for deployment\n`);
});

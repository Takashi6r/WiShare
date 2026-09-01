const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
const uploadDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 1024 }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(uploadDir));

const devices = new Map();

function broadcastDevices() {
  io.emit("devices:update", Array.from(devices.values()));
}

io.on("connection", socket => {
  console.log("Connected:", socket.id);

  socket.on("device:join", name => {
    const deviceName = String(name || "Unknown Device").trim().slice(0, 40) || "Unknown Device";

    devices.set(socket.id, {
      id: socket.id,
      name: deviceName
    });

    socket.emit("device:ready", {
      id: socket.id,
      name: deviceName
    });

    broadcastDevices();
    console.log(`${deviceName} joined`);
  });

  socket.on("message:send", data => {
    if (!data?.text || !devices.has(socket.id)) return;

    const sender = devices.get(socket.id);
    const message = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      senderId: socket.id,
      senderName: sender.name,
      text: String(data.text).slice(0, 5000),
      time: new Date().toISOString()
    };

    socket.broadcast.emit("message:receive", message);
    socket.emit("message:sent", message);
  });

  socket.on("file:send", data => {
    if (!data?.fileUrl || !devices.has(socket.id)) return;

    const sender = devices.get(socket.id);
    const fileMessage = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      senderId: socket.id,
      senderName: sender.name,
      fileName: data.fileName,
      fileSize: data.fileSize,
      fileType: data.fileType,
      fileUrl: data.fileUrl,
      time: new Date().toISOString()
    };

    socket.broadcast.emit("file:receive", fileMessage);
    socket.emit("file:sent", fileMessage);
  });

  socket.on("disconnect", () => {
    const device = devices.get(socket.id);
    if (device) console.log(`${device.name} disconnected`);
    devices.delete(socket.id);
    broadcastDevices();
  });
});

app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  res.json({
    success: true,
    file: {
      originalName: req.file.originalname,
      fileName: req.file.filename,
      size: req.file.size,
      mimeType: req.file.mimetype,
      url: `/uploads/${encodeURIComponent(req.file.filename)}`
    }
  });
});

app.delete("/upload/:filename", (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(uploadDir, filename);

  fs.unlink(filePath, error => {
    if (error) return res.status(404).json({ error: "File not found" });
    res.json({ success: true });
  });
});

app.get("*splat", (_, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

server.listen(PORT, HOST, () => {
  console.log("\n====================================");
  console.log("          WiShare is running");
  console.log("====================================");
  console.log(`\nLocal: http://localhost:${PORT}`);
  console.log(`Network: http://YOUR-PC-IP:${PORT}\n`);
});
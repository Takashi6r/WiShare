const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");
const dns = require("dns");
const { execFile } = require("child_process");
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

function normalizeIp(address = "") {
  if (address.startsWith("::ffff:")) return address.slice(7);
  if (address === "::1") return "127.0.0.1";
  return address;
}

function getLocalIPv4() {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const entries of Object.values(interfaces)) {
    for (const item of entries || []) {
      if (item.family === "IPv4" && !item.internal) candidates.push(item.address);
    }
  }

  return candidates.find(ip => /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(ip)) || candidates[0] || null;
}

function subnetFor(ip) {
  const parts = ip.split(".");
  return parts.length === 4 ? parts.slice(0, 3).join(".") : null;
}

function runCommand(command, args, timeout = 5000) {
  return new Promise(resolve => {
    execFile(command, args, { timeout, windowsHide: true }, (error, stdout = "") => {
      resolve(error && !stdout ? "" : stdout);
    });
  });
}

function parseArp(output) {
  const found = new Map();
  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-f]{2}(?:[-:][0-9a-f]{2}){5})\s+(dynamic|static)?/i);
    if (!match) continue;
    const ip = match[1];
    const mac = match[2].toUpperCase().replace(/-/g, ":");
    if (mac === "FF:FF:FF:FF:FF:FF") continue;
    found.set(ip, { ip, mac });
  }
  return [...found.values()];
}

async function lookupDeviceName(ip) {
  // Windows devices commonly publish their real computer name through NetBIOS.
  if (process.platform === "win32") {
    const output = await runCommand("nbtstat", ["-A", ip], 2500);
    const lines = output.split(/\r?\n/);
    for (const line of lines) {
      // Example: COMPUTER-NAME <00> UNIQUE Registered
      const match = line.match(/^\s*([^\s<]{1,40})\s+<00>\s+UNIQUE/i);
      if (match && !/workgroup|internet|__msbrowser/i.test(match[1])) {
        return { name: match[1], source: "NetBIOS" };
      }
    }
  }

  // Reverse DNS works when the router/local DNS server advertises hostnames.
  try {
    const names = await new Promise((resolve, reject) => {
      dns.reverse(ip, (error, addresses) => error ? reject(error) : resolve(addresses));
    });
    if (names?.[0]) {
      const name = names[0].replace(/\.$/, "").split(".")[0];
      if (name && !/^\d+(?:\.\d+){3}$/.test(name)) {
        return { name, source: "DNS" };
      }
    }
  } catch (_) {}

  // Linux systems may have avahi-resolve available for mDNS names.
  if (process.platform !== "win32") {
    const avahi = await runCommand("avahi-resolve", ["-a", ip], 2000);
    const match = avahi.match(/\s+([^\s]+)\s*$/m);
    if (match?.[1]) return { name: match[1].replace(/\.local\.?$/, ""), source: "mDNS" };
  }

  return { name: null, source: null };
}

async function getNetworkDevices() {
  const localIp = getLocalIPv4();
  const subnet = localIp && subnetFor(localIp);
  if (!subnet) return [];

  // Ping first so the OS learns IP/MAC neighbors. Some devices intentionally
  // ignore ICMP, so we also read the existing ARP/neighbor table below.
  const pingArgs = ip => process.platform === "win32"
    ? ["-n", "1", "-w", "180", ip]
    : ["-c", "1", "-W", "1", ip];

  await Promise.all(
    Array.from({ length: 254 }, (_, index) =>
      runCommand("ping", pingArgs(`${subnet}.${index + 1}`), 1200)
    )
  );

  const arpOutput = await runCommand("arp", ["-a"], 5000);
  const entries = parseArp(arpOutput).filter(item => item.ip.startsWith(`${subnet}.`));

  // Also read Windows' neighbor cache. It can contain devices which don't
  // answer ping but have recently communicated on the LAN.
  if (process.platform === "win32") {
    const neighborOutput = await runCommand("powershell", [
      "-NoProfile", "-Command",
      "Get-NetNeighbor -AddressFamily IPv4 | Where-Object {$_.IPAddress -like '" + subnet + ".*' -and $_.State -notin @('Unreachable','Invalid')} | ForEach-Object { $_.IPAddress + ' ' + $_.LinkLayerAddress }"
    ], 5000);
    for (const line of neighborOutput.split(/\r?\n/)) {
      const match = line.trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-f]{2}(?:[-:][0-9a-f]{2}){5})$/i);
      if (!match) continue;
      const ip = match[1];
      const mac = match[2].toUpperCase().replace(/-/g, ":");
      if (!entries.some(item => item.ip === ip) && mac !== "00:00:00:00:00:00") entries.push({ ip, mac });
    }
  }

  const withNames = await Promise.all(entries.map(async item => {
    if (item.ip === localIp) {
      return { ip: item.ip, mac: item.mac, name: os.hostname(), nameSource: "This PC", isServer: true };
    }

    const identity = await lookupDeviceName(item.ip);
    return {
      ip: item.ip,
      mac: item.mac,
      name: identity.name || "Unknown device",
      nameSource: identity.source || "Not advertised",
      isServer: false
    };
  }));

  if (!withNames.some(item => item.ip === localIp)) {
    withNames.unshift({ ip: localIp, mac: "", name: os.hostname(), nameSource: "This PC", isServer: true });
  }

  return withNames.sort((a, b) =>
    Number(b.isServer) - Number(a.isServer) ||
    a.ip.localeCompare(b.ip, undefined, { numeric: true })
  );
}

function broadcastDevices() {
  io.emit("devices:update", Array.from(devices.values()));
}

io.on("connection", socket => {
  console.log("Connected:", socket.id);

  socket.on("device:join", name => {
    const deviceName = String(name || "Unknown Device").trim().slice(0, 40) || "Unknown Device";

    devices.set(socket.id, {
      id: socket.id,
      name: deviceName,
      ip: normalizeIp(socket.handshake.address),
      joinedAt: new Date().toISOString()
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


app.get("/api/network-info", async (_, res) => {
  try {
    const localIp = getLocalIPv4();
    const subnet = localIp ? subnetFor(localIp) : null;
    const devicesFound = await getNetworkDevices();
    res.json({ success: true, localIp, subnet: subnet ? `${subnet}.0/24` : null, devices: devicesFound });
  } catch (error) {
    console.error("Network scan failed:", error);
    res.status(500).json({ success: false, error: "Unable to scan the local network" });
  }
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
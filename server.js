const crypto = require("crypto");
const os = require("os");
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const multer = require("multer");
const QRCode = require("qrcode");
const { WebSocket, WebSocketServer } = require("ws");

const app = express();
const port = Number(process.env.PORT || 3000);
const roomAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const fileAlphabet = "0123456789abcdefghijklmnopqrstuvwxyz";

const ROOM_TTL_MS = 20 * 60 * 1000;
const FILE_TTL_MS = 15 * 60 * 1000;
const MAX_FILE_BYTES = 150 * 1024 * 1024;

const rooms = new Map();

function randomId(alphabet, length) {
  let value = "";
  const bytes = crypto.randomBytes(length);
  for (const byte of bytes) value += alphabet[byte % alphabet.length];
  return value;
}

function localLanAddress() {
  const candidates = [];
  const ignoredAdapters = /(virtual|vmware|virtualbox|loopback|hyper-v|vethernet|wsl|docker)/i;

  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    if (ignoredAdapters.test(name)) continue;

    for (const address of addresses || []) {
      if (address.family !== "IPv4" || address.internal) continue;
      candidates.push({ name, address: address.address });
    }
  }

  const preferred = candidates.find((candidate) => /(wi-fi|wifi|wlan|wireless)/i.test(candidate.name));
  if (preferred) return preferred.address;

  const usable = candidates.filter((candidate) => candidate.address !== "192.168.56.1");

  return (
    usable.find((candidate) => /^192\.168\./.test(candidate.address))?.address ||
    usable.find((candidate) => /^10\./.test(candidate.address))?.address ||
    usable.find((candidate) => /^172\.(1[6-9]|2\d|3[01])\./.test(candidate.address))?.address ||
    usable[0]?.address ||
    candidates[0]?.address ||
    null
  );
}

function publicBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, "");

  const proto = req.get("x-forwarded-proto") || req.protocol;
  const host = req.get("host");
  const hostName = host.split(":")[0];
  const lanAddress = localLanAddress();

  if ((hostName === "localhost" || hostName === "127.0.0.1") && lanAddress) {
    return `${proto}://${lanAddress}:${port}`;
  }

  return `${proto}://${host}`;
}

function ensureRoom(id) {
  const room = rooms.get(id);
  if (!room || room.expiresAt < Date.now()) {
    rooms.delete(id);
    return null;
  }
  return room;
}

function fileInfo(room, file) {
  return {
    id: file.id,
    name: file.name,
    type: file.type,
    size: file.size,
    createdAt: file.createdAt,
    expiresAt: file.expiresAt,
    downloadUrl: `/api/rooms/${room.id}/files/${file.id}`,
    mode: "relay",
  };
}

function roomSummary(room) {
  return {
    id: room.id,
    joinUrl: room.joinUrl,
    expiresAt: room.expiresAt,
    peers: [...room.peers.values()].map((peer) => ({
      id: peer.id,
      role: peer.role,
      joinedAt: peer.joinedAt,
    })),
    files: [...room.files.values()].map((file) => fileInfo(room, file)),
  };
}

function send(socket, event) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
}

function broadcast(room, event, exceptId) {
  for (const peer of room.peers.values()) {
    if (peer.id !== exceptId) send(peer.socket, event);
  }
}

function sweepExpired() {
  const now = Date.now();
  for (const [id, room] of rooms) {
    for (const [fid, file] of room.files) {
      if (file.expiresAt < now) room.files.delete(fid);
    }
    if (room.expiresAt < now || (room.peers.size === 0 && room.files.size === 0)) {
      rooms.delete(id);
    }
  }
}

setInterval(sweepExpired, 60_000).unref();

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
});

app.post("/api/rooms", async (req, res, next) => {
  try {
    let id;
    do {
      id = randomId(roomAlphabet, 6);
    } while (rooms.has(id));

    const joinUrl = `${publicBaseUrl(req)}/send/${id}`;
    const qr = await QRCode.toDataURL(joinUrl, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 320,
      color: { dark: "#101828", light: "#ffffff" },
    });

    const room = {
      id,
      joinUrl,
      qr,
      createdAt: Date.now(),
      expiresAt: Date.now() + ROOM_TTL_MS,
      peers: new Map(),
      files: new Map(),
    };
    rooms.set(id, room);

    res.status(201).json({ id, joinUrl, qr, expiresAt: room.expiresAt });
  } catch (error) {
    next(error);
  }
});

app.get("/api/rooms/:id", (req, res) => {
  const room = ensureRoom(req.params.id.toUpperCase());
  if (!room) return res.status(404).json({ error: "Room not found or expired." });
  res.json(roomSummary(room));
});

app.post("/api/rooms/:id/files", upload.single("file"), (req, res) => {
  const room = ensureRoom(req.params.id.toUpperCase());
  if (!room) return res.status(404).json({ error: "Room not found or expired." });
  if (!req.file) return res.status(400).json({ error: "Choose a file first." });

  const safeName = path.basename(req.file.originalname || "transfer.bin");
  const id = randomId(fileAlphabet, 12);
  const file = {
    id,
    name: safeName,
    type: req.file.mimetype || "application/octet-stream",
    size: req.file.size,
    data: req.file.buffer,
    createdAt: Date.now(),
    expiresAt: Date.now() + FILE_TTL_MS,
    checksum: crypto.createHash("sha256").update(req.file.buffer).digest("hex"),
  };

  room.files.set(id, file);
  broadcast(room, { type: "file:created", file: fileInfo(room, file) });
  res.status(201).json({
    ...fileInfo(room, file),
    checksum: file.checksum,
  });
});

app.get("/api/rooms/:id/files/:fileId", (req, res) => {
  const room = ensureRoom(req.params.id.toUpperCase());
  if (!room) return res.status(404).send("Room not found or expired.");

  const file = room.files.get(req.params.fileId);
  if (!file || file.expiresAt < Date.now()) {
    if (file) room.files.delete(file.id);
    return res.status(404).send("File not found or expired.");
  }

  res.setHeader("Content-Type", file.type);
  res.setHeader("Content-Length", file.size);
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(file.name)}"`);
  res.setHeader("X-Content-SHA256", file.checksum);
  res.send(file.data);
});

app.delete("/api/rooms/:id/files/:fileId", (req, res) => {
  const room = ensureRoom(req.params.id.toUpperCase());
  if (!room) return res.status(404).json({ error: "Room not found or expired." });
  room.files.delete(req.params.fileId);
  broadcast(room, { type: "file:deleted", fileId: req.params.fileId });
  res.status(204).end();
});

app.get("/send/:id", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "send.html"));
});

app.use((error, _req, res, _next) => {
  if (error.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "File is too large. The fallback limit is 150 MB." });
  }
  console.error(error);
  res.status(500).json({ error: "Something went wrong." });
});

const server = app.listen(port, () => {
  console.log(`EasyShare running at http://localhost:${port}`);
  const lanAddress = localLanAddress();
  if (lanAddress) console.log(`LAN address likely available at http://${lanAddress}:${port}`);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use.`);
    console.error("Close the other server or start this one with a different port:");
    console.error("PowerShell: $env:PORT=3001; npm start");
    process.exit(1);
  }

  console.error(error);
  process.exit(1);
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (socket, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = (url.searchParams.get("room") || "").toUpperCase();
  const role = url.searchParams.get("role") === "sender" ? "sender" : "receiver";
  const room = ensureRoom(roomId);

  if (!room) {
    send(socket, { type: "error", message: "Room not found or expired." });
    socket.close();
    return;
  }

  const peer = {
    id: randomId(fileAlphabet, 10),
    role,
    socket,
    joinedAt: Date.now(),
    lastSeen: Date.now(),
  };

  room.peers.set(peer.id, peer);
  send(socket, { type: "socket:ready", peer: { id: peer.id, role: peer.role }, room: roomSummary(room) });
  broadcast(room, { type: "peer:joined", peer: { id: peer.id, role: peer.role, joinedAt: peer.joinedAt } }, peer.id);

  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw);
    } catch (_error) {
      return;
    }

    peer.lastSeen = Date.now();

    if (message.type === "pong") return;
    if (!message.to || typeof message.to !== "string") return;

    const recipient = room.peers.get(message.to);
    if (!recipient) {
      send(socket, { type: "peer:missing", peerId: message.to });
      return;
    }

    send(recipient.socket, {
      ...message,
      from: peer.id,
      role: peer.role,
    });
  });

  socket.on("close", () => {
    room.peers.delete(peer.id);
    broadcast(room, { type: "peer:left", peerId: peer.id });
  });
});

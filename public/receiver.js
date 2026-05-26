const qr = document.querySelector("#qr");
const roomCode = document.querySelector("#roomCode");
const joinUrl = document.querySelector("#joinUrl");
const statusBadge = document.querySelector("#status");
const peerStatus = document.querySelector("#peerStatus");
const files = document.querySelector("#files");
const newRoom = document.querySelector("#newRoom");
const copyLink = document.querySelector("#copyLink");
const expiresIn = document.querySelector("#expiresIn");
const modeLabel = document.querySelector("#modeLabel");
const transferStage = document.querySelector("#transferStage");
const stageTitle = document.querySelector("#stageTitle");
const stageDetail = document.querySelector("#stageDetail");

const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];

let socket;
let currentRoom;
let selfPeerId;
let connections = new Map();
let transfers = new Map();
let activeTransferByPeer = new Map();
let countdownTimer;

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units.shift();
  while (value >= 1024 && units.length) {
    value /= 1024;
    unit = units.shift();
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}

function setStatus(text) {
  statusBadge.textContent = text;
}

function setStage(state, title, detail) {
  transferStage.classList.toggle("receiving", state === "receiving");
  transferStage.classList.toggle("idle", state !== "receiving");
  stageTitle.textContent = title;
  stageDetail.textContent = detail;
}

function socketSend(message) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function clearFiles() {
  files.classList.add("empty");
  files.innerHTML = "<p>No files yet.</p>";
}

function ensureList() {
  if (!files.classList.contains("empty")) return;
  files.classList.remove("empty");
  files.innerHTML = "";
}

function makeFileRow(file) {
  ensureList();

  const row = document.createElement("article");
  row.className = "file-row";
  row.dataset.fileId = file.id;

  const details = document.createElement("div");
  const title = document.createElement("strong");
  const meta = document.createElement("span");
  title.textContent = file.name;
  meta.textContent = `${formatBytes(file.size)} - ${file.mode === "direct" ? "direct transfer" : "relay fallback"}`;
  details.append(title, meta);

  const actions = document.createElement("div");
  actions.className = "row-actions";

  const link = document.createElement("a");
  link.className = "download";
  link.href = file.url || file.downloadUrl;
  link.download = file.name;
  link.textContent = "Download";

  const remove = document.createElement("button");
  remove.type = "button";
  remove.title = "Remove file";
  remove.setAttribute("aria-label", "Remove file");
  remove.textContent = "x";
  remove.addEventListener("click", async () => {
    if (file.url) URL.revokeObjectURL(file.url);
    if (file.mode === "relay") {
      await fetch(`/api/rooms/${currentRoom.id}/files/${file.id}`, { method: "DELETE" });
    }
    row.remove();
    if (!files.children.length) clearFiles();
  });

  actions.append(link, remove);
  row.append(details, actions);
  files.appendChild(row);
}

function makeProgressRow(meta) {
  ensureList();

  const row = document.createElement("article");
  row.className = "file-row transfer-row";
  row.dataset.fileId = meta.id;

  const details = document.createElement("div");
  const title = document.createElement("strong");
  const label = document.createElement("span");
  title.textContent = meta.name;
  label.textContent = `Receiving 0% of ${formatBytes(meta.size)}`;
  details.append(title, label);

  const meter = document.createElement("progress");
  meter.max = 100;
  meter.value = 0;

  row.append(details, meter);
  files.appendChild(row);
  return { row, label, meter };
}

function updateProgress(transfer) {
  const percent = transfer.meta.size ? Math.round((transfer.received / transfer.meta.size) * 100) : 0;
  transfer.ui.meter.value = percent;
  transfer.ui.label.textContent = `Receiving ${percent}% of ${formatBytes(transfer.meta.size)}`;
  setStage("receiving", "Receiving file", `${transfer.meta.name} - ${percent}%`);
}

function completeTransfer(peerId, id) {
  const transfer = transfers.get(id);
  if (!transfer) return;

  const blob = new Blob(transfer.chunks, {
    type: transfer.meta.type || "application/octet-stream",
  });
  const url = URL.createObjectURL(blob);

  transfer.ui.row.remove();
  transfers.delete(id);
  activeTransferByPeer.delete(peerId);

  makeFileRow({
    id,
    name: transfer.meta.name,
    size: transfer.meta.size,
    mode: "direct",
    url,
  });

  setStatus("File received");
  peerStatus.textContent = "Phone ready";
  modeLabel.textContent = "Direct link";
  setStage("complete", "File ready", `${transfer.meta.name} arrived successfully.`);
}

function handleDataMessage(peerId, data) {
  if (typeof data === "string") {
    const message = JSON.parse(data);

    if (message.kind === "meta") {
      const ui = makeProgressRow(message);
      transfers.set(message.id, {
        meta: message,
        chunks: [],
        received: 0,
        ui,
      });
      activeTransferByPeer.set(peerId, message.id);
      setStatus("Receiving");
      modeLabel.textContent = "Direct link";
      setStage("receiving", "Receiving file", `${message.name} - 0%`);
      return;
    }

    if (message.kind === "done") completeTransfer(peerId, message.id);
    return;
  }

  const activeId = activeTransferByPeer.get(peerId);
  const active = activeId ? transfers.get(activeId) : null;
  if (!active) return;

  active.chunks.push(data);
  active.received += data.byteLength;
  updateProgress(active);
}

function createPeerConnection(peerId) {
  const existing = connections.get(peerId);
  if (existing) return existing;

  const pc = new RTCPeerConnection({ iceServers });

  pc.addEventListener("icecandidate", (event) => {
    if (event.candidate) {
      socketSend({ type: "signal:candidate", to: peerId, candidate: event.candidate });
    }
  });

  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "connected") {
      setStatus("Direct link");
      peerStatus.textContent = "Phone connected";
      modeLabel.textContent = "Direct link";
      setStage("ready", "Phone connected", "Ready to receive files.");
    }
    if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
      peerStatus.textContent = "Waiting for phone";
      if (!transfers.size) setStage("idle", "Waiting for files", "Scan the QR code from another device.");
    }
  });

  pc.addEventListener("datachannel", (event) => {
    const channel = event.channel;
    channel.binaryType = "arraybuffer";
    channel.addEventListener("open", () => {
      setStatus("Ready");
      peerStatus.textContent = "Phone ready";
      modeLabel.textContent = "Direct link";
      setStage("ready", "Phone ready", "Choose files on the sending device.");
    });
    channel.addEventListener("message", (message) => handleDataMessage(peerId, message.data));
  });

  connections.set(peerId, pc);
  return pc;
}

async function handleOffer(message) {
  const pc = createPeerConnection(message.from);
  await pc.setRemoteDescription(message.description);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socketSend({ type: "signal:answer", to: message.from, description: pc.localDescription });
}

async function handleCandidate(message) {
  const pc = createPeerConnection(message.from);
  if (message.candidate) await pc.addIceCandidate(message.candidate);
}

function renderRelayFiles(fileItems) {
  clearFiles();
  fileItems.forEach((file) => makeFileRow(file));
}

function startCountdown(expiresAt) {
  clearInterval(countdownTimer);

  function tick() {
    const remaining = Math.max(0, expiresAt - Date.now());
    const minutes = Math.floor(remaining / 60_000);
    const seconds = Math.floor((remaining % 60_000) / 1000);
    expiresIn.textContent = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    if (remaining <= 0) {
      clearInterval(countdownTimer);
      setStatus("Expired");
      peerStatus.textContent = "Start a new room";
      setStage("idle", "Room expired", "Start a new room from this screen.");
    }
  }

  tick();
  countdownTimer = setInterval(tick, 1000);
}

function connect(room) {
  if (socket) socket.close();
  connections.forEach((pc) => pc.close());
  connections = new Map();
  transfers = new Map();
  activeTransferByPeer = new Map();

  const protocol = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${location.host}/ws?room=${room.id}&role=receiver`);

  socket.addEventListener("open", () => setStatus("Connected"));

  socket.addEventListener("message", async (event) => {
    const message = JSON.parse(event.data);

    if (message.type === "socket:ready") {
      selfPeerId = message.peer.id;
      renderRelayFiles(message.room.files);
      peerStatus.textContent = "Waiting for phone";
      setStage("idle", "Waiting for files", "Scan the QR code from another device.");
    }

    if (message.type === "peer:joined" && message.peer.role === "sender") {
      peerStatus.textContent = "Phone joined";
      setStage("ready", "Phone joined", "Creating a direct link.");
    }

    if (message.type === "peer:left") {
      const pc = connections.get(message.peerId);
      if (pc) pc.close();
      connections.delete(message.peerId);
      activeTransferByPeer.delete(message.peerId);
      peerStatus.textContent = "Waiting for phone";
      if (!transfers.size) setStage("idle", "Waiting for files", "Scan the QR code from another device.");
    }

    if (message.type === "signal:offer") await handleOffer(message);
    if (message.type === "signal:candidate") await handleCandidate(message);

    if (message.type === "file:created") {
      makeFileRow(message.file);
      setStatus("Fallback file");
      modeLabel.textContent = "Relay fallback";
      setStage("complete", "File ready", `${message.file.name} arrived through fallback.`);
    }

    if (message.type === "file:deleted") {
      const row = files.querySelector(`[data-file-id="${message.fileId}"]`);
      if (row) row.remove();
      if (!files.children.length) clearFiles();
    }
  });

  socket.addEventListener("close", () => {
    if (currentRoom && currentRoom.id === room.id) setStatus("Disconnected");
  });

  socket.addEventListener("error", () => {
    setStatus("Connection issue");
    peerStatus.textContent = "Retrying may help";
  });
}

async function copyRoomLink() {
  if (!currentRoom) return;
  try {
    await navigator.clipboard.writeText(currentRoom.joinUrl);
    copyLink.title = "Copied";
  } catch (_error) {
    const helper = document.createElement("textarea");
    helper.value = currentRoom.joinUrl;
    document.body.appendChild(helper);
    helper.select();
    document.execCommand("copy");
    helper.remove();
    copyLink.title = "Copied";
  }
}

async function createRoom() {
  setStatus("Creating");
  peerStatus.textContent = "Starting room";
  setStage("idle", "Starting room", "Preparing a fresh QR code.");

  const response = await fetch("/api/rooms", { method: "POST" });
  currentRoom = await response.json();
  qr.src = currentRoom.qr;
  roomCode.textContent = currentRoom.id;
  joinUrl.textContent = currentRoom.joinUrl;
  modeLabel.textContent = "Direct first";
  clearFiles();
  startCountdown(currentRoom.expiresAt);
  connect(currentRoom);
}

newRoom.addEventListener("click", createRoom);
copyLink.addEventListener("click", copyRoomLink);
createRoom();

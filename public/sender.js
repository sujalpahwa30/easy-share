const roomId = location.pathname.split("/").pop().toUpperCase();
const roomCode = document.querySelector("#roomCode");
const form = document.querySelector("#uploadForm");
const fileInput = document.querySelector("#file");
const fileText = document.querySelector("#fileText");
const result = document.querySelector("#result");
const sendButton = document.querySelector("#sendButton");
const clearButton = document.querySelector("#clearButton");
const progress = document.querySelector("#progress");
const mode = document.querySelector("#mode");
const dropzone = document.querySelector("#dropzone");
const queue = document.querySelector("#queue");
const beam = document.querySelector(".beam");

const chunkSize = 64 * 1024;
const highWaterMark = 8 * 1024 * 1024;
const lowWaterMark = 2 * 1024 * 1024;
const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];

let socket;
let selfPeerId;
let receiverId;
let peerConnection;
let dataChannel;
let selectedFiles = [];
let transferBusy = false;
let queuedAutoStart = false;

roomCode.textContent = roomId;

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

function setMode(text) {
  mode.textContent = text;
}

function setProgress(value) {
  progress.value = Math.max(0, Math.min(100, value));
}

function setBusy(isBusy) {
  transferBusy = isBusy;
  sendButton.disabled = isBusy || selectedFiles.length === 0;
  clearButton.disabled = isBusy || selectedFiles.length === 0;
  beam.classList.toggle("active", isBusy);
}

function socketSend(message) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function renderQueue() {
  queue.classList.toggle("empty", selectedFiles.length === 0);
  queue.innerHTML = "";

  if (!selectedFiles.length) {
    queue.innerHTML = "<p>No files selected.</p>";
    fileText.textContent = "Drop files here";
    sendButton.disabled = true;
    clearButton.disabled = true;
    return;
  }

  const total = selectedFiles.reduce((sum, item) => sum + item.size, 0);
  fileText.textContent = `${selectedFiles.length} file${selectedFiles.length === 1 ? "" : "s"} selected`;

  selectedFiles.forEach((item, index) => {
    const row = document.createElement("article");
    row.className = "queue-row";

    const details = document.createElement("div");
    const title = document.createElement("strong");
    const meta = document.createElement("span");
    title.textContent = item.name;
    meta.textContent = formatBytes(item.size);
    details.append(title, meta);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "quiet-button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      if (transferBusy) return;
      selectedFiles.splice(index, 1);
      renderQueue();
    });

    row.append(details, remove);
    queue.appendChild(row);
  });

  const summary = document.createElement("article");
  summary.className = "queue-row summary-row";
  summary.innerHTML = `<strong>Total</strong><span>${formatBytes(total)}</span>`;
  queue.appendChild(summary);

  sendButton.disabled = transferBusy;
  clearButton.disabled = transferBusy;
}

function setSelectedFiles(items) {
  selectedFiles = [...items].filter((item) => item && item.size >= 0);
  setProgress(0);
  result.textContent = selectedFiles.length ? "Ready to send." : "";
  renderQueue();
}

async function waitForBuffer() {
  while (dataChannel && dataChannel.bufferedAmount > highWaterMark) {
    dataChannel.bufferedAmountLowThreshold = lowWaterMark;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 250);
      dataChannel.addEventListener(
        "bufferedamountlow",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    });
  }
}

async function sendDirectFile(selectedFile, index, totalFiles, overallSent, overallBytes) {
  if (!dataChannel || dataChannel.readyState !== "open") {
    throw new Error("Direct link is not ready.");
  }

  const id = `${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`;
  dataChannel.send(
    JSON.stringify({
      kind: "meta",
      id,
      name: selectedFile.name,
      type: selectedFile.type || "application/octet-stream",
      size: selectedFile.size,
      index: index + 1,
      total: totalFiles,
    })
  );

  let offset = 0;
  while (offset < selectedFile.size) {
    const chunk = await selectedFile.slice(offset, offset + chunkSize).arrayBuffer();
    await waitForBuffer();
    dataChannel.send(chunk);
    offset += chunk.byteLength;
    const nextTotal = overallSent + offset;
    setProgress(overallBytes ? Math.round((nextTotal / overallBytes) * 100) : 100);
  }

  await waitForBuffer();
  dataChannel.send(JSON.stringify({ kind: "done", id }));
  return overallSent + selectedFile.size;
}

function sendFallbackFile(selectedFile, index, totalFiles, overallSent, overallBytes) {
  return new Promise((resolve, reject) => {
    const body = new FormData();
    body.append("file", selectedFile);

    const request = new XMLHttpRequest();
    request.open("POST", `/api/rooms/${roomId}/files`);

    request.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      const nextTotal = overallSent + event.loaded;
      setProgress(overallBytes ? Math.round((nextTotal / overallBytes) * 100) : 100);
    });

    request.addEventListener("load", () => {
      let payload = {};
      try {
        payload = JSON.parse(request.responseText || "{}");
      } catch (_error) {
        payload = {};
      }

      if (request.status < 200 || request.status >= 300) {
        reject(new Error(payload.error || "Upload failed."));
        return;
      }

      result.textContent = `Sent ${index + 1} of ${totalFiles} through fallback.`;
      resolve(overallSent + selectedFile.size);
    });

    request.addEventListener("error", () => reject(new Error("Network error while uploading.")));
    request.send(body);
  });
}

async function ensureDirectOrFallback() {
  if (dataChannel && dataChannel.readyState === "open") return "direct";

  result.textContent = "Connecting directly...";
  for (let i = 0; i < 32; i += 1) {
    if (dataChannel && dataChannel.readyState === "open") return "direct";
    await wait(250);
  }

  setMode("Relay fallback");
  return "fallback";
}

async function sendQueue() {
  if (!selectedFiles.length || transferBusy) return;

  const filesToSend = [...selectedFiles];
  const totalBytes = filesToSend.reduce((sum, item) => sum + item.size, 0);
  let sentBytes = 0;

  setBusy(true);
  sendButton.textContent = "Sending...";
  setProgress(0);

  try {
    const modeToUse = await ensureDirectOrFallback();

    for (let index = 0; index < filesToSend.length; index += 1) {
      const current = filesToSend[index];
      result.textContent = `Sending ${index + 1} of ${filesToSend.length}: ${current.name}`;

      if (modeToUse === "direct") {
        sentBytes = await sendDirectFile(current, index, filesToSend.length, sentBytes, totalBytes);
      } else {
        sentBytes = await sendFallbackFile(current, index, filesToSend.length, sentBytes, totalBytes);
      }
    }

    setProgress(100);
    result.textContent = `${filesToSend.length} file${filesToSend.length === 1 ? "" : "s"} sent.`;
    selectedFiles = [];
    form.reset();
    renderQueue();
  } catch (error) {
    result.textContent = error.message;
  } finally {
    setBusy(false);
    sendButton.textContent = "Send files";
    queuedAutoStart = false;
  }
}

function createPeerConnection(peerId) {
  receiverId = peerId;
  if (peerConnection) peerConnection.close();

  peerConnection = new RTCPeerConnection({ iceServers });
  dataChannel = peerConnection.createDataChannel("easyshare-file", { ordered: true });
  dataChannel.binaryType = "arraybuffer";

  dataChannel.addEventListener("open", async () => {
    setMode("Direct link ready");
    result.textContent = selectedFiles.length ? "Ready to send." : "Direct link ready.";
    if (queuedAutoStart && selectedFiles.length && !transferBusy) await sendQueue();
  });

  dataChannel.addEventListener("close", () => {
    if (!transferBusy) setMode("Relay available");
  });

  peerConnection.addEventListener("icecandidate", (event) => {
    if (event.candidate) {
      socketSend({ type: "signal:candidate", to: receiverId, candidate: event.candidate });
    }
  });

  peerConnection.addEventListener("connectionstatechange", () => {
    if (peerConnection.connectionState === "connecting") setMode("Connecting");
    if (peerConnection.connectionState === "connected") setMode("Direct link ready");
    if (["failed", "disconnected", "closed"].includes(peerConnection.connectionState)) {
      if (!transferBusy) setMode("Relay available");
    }
  });

  return peerConnection;
}

async function startDirectLink(peerId) {
  const pc = createPeerConnection(peerId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socketSend({ type: "signal:offer", to: peerId, description: pc.localDescription });
}

async function handleAnswer(message) {
  if (peerConnection) await peerConnection.setRemoteDescription(message.description);
}

async function handleCandidate(message) {
  if (peerConnection && message.candidate) await peerConnection.addIceCandidate(message.candidate);
}

function connect() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${location.host}/ws?room=${roomId}&role=sender`);
  setMode("Joining room");

  socket.addEventListener("message", async (event) => {
    const message = JSON.parse(event.data);

    if (message.type === "socket:ready") {
      selfPeerId = message.peer.id;
      const receiver = message.room.peers.find((peer) => peer.role === "receiver" && peer.id !== selfPeerId);
      if (receiver) {
        setMode("Connecting");
        await startDirectLink(receiver.id);
      } else {
        setMode("Waiting for screen");
      }
    }

    if (message.type === "peer:joined" && message.peer.role === "receiver") {
      setMode("Connecting");
      await startDirectLink(message.peer.id);
    }

    if (message.type === "signal:answer") await handleAnswer(message);
    if (message.type === "signal:candidate") await handleCandidate(message);
    if (message.type === "peer:missing") setMode("Relay available");
  });

  socket.addEventListener("close", () => setMode("Disconnected"));
  socket.addEventListener("error", () => setMode("Connection issue"));
}

fileInput.addEventListener("change", () => {
  setSelectedFiles(fileInput.files);
});

dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzone.classList.add("dragging");
});

dropzone.addEventListener("dragleave", () => {
  dropzone.classList.remove("dragging");
});

dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzone.classList.remove("dragging");
  if (event.dataTransfer.files.length) setSelectedFiles(event.dataTransfer.files);
});

clearButton.addEventListener("click", () => {
  if (transferBusy) return;
  selectedFiles = [];
  form.reset();
  result.textContent = "";
  setProgress(0);
  renderQueue();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedFiles.length || transferBusy) return;
  queuedAutoStart = true;
  await sendQueue();
});

renderQueue();
connect();

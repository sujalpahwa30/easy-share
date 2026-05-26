const WebSocket = require("ws");

const serverUrl = process.env.EASYSHARE_URL || process.env.QUICKDROP_URL || "http://localhost:3000";
const wsUrl = serverUrl.replace(/^http/, "ws");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const room = await fetch(`${serverUrl}/api/rooms`, { method: "POST" }).then((response) => response.json());
  const seen = [];

  const receiver = new WebSocket(`${wsUrl}/ws?room=${room.id}&role=receiver`);
  let receiverId;
  let senderId;

  receiver.on("message", (raw) => {
    const message = JSON.parse(raw);
    seen.push(`receiver:${message.type}`);
    if (message.type === "socket:ready") receiverId = message.peer.id;
    if (message.type === "signal:offer") seen.push(`offer-from:${message.from}`);
  });

  await new Promise((resolve) => receiver.on("open", resolve));
  await wait(250);

  const sender = new WebSocket(`${wsUrl}/ws?room=${room.id}&role=sender`);
  sender.on("message", (raw) => {
    const message = JSON.parse(raw);
    seen.push(`sender:${message.type}`);
    if (message.type === "socket:ready") {
      senderId = message.peer.id;
      sender.send(
        JSON.stringify({
          type: "signal:offer",
          to: receiverId,
          description: { type: "offer", sdp: "smoke-test" },
        })
      );
    }
  });

  await new Promise((resolve) => sender.on("open", resolve));
  await wait(750);

  receiver.close();
  sender.close();

  const ok =
    seen.includes("receiver:socket:ready") &&
    seen.includes("sender:socket:ready") &&
    seen.includes("receiver:peer:joined") &&
    seen.some((event) => event.startsWith("offer-from:"));

  if (!ok) throw new Error(`Signaling failed: ${seen.join(", ")}`);

  console.log(`ok ${room.id} ${receiverId} ${senderId}`);
  console.log(seen.join(", "));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

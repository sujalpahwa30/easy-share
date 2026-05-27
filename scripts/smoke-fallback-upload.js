const serverUrl = process.env.EASYSHARE_URL || process.env.QUICKDROP_URL || "http://localhost:3000";

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed: ${response.status}`);
  return payload;
}

async function main() {
  const room = await postJson(`${serverUrl}/api/rooms`, {});
  const config = await fetch(`${serverUrl}/api/config`).then((response) => response.json());
  const chunkBytes = config.fallbackChunkBytes || 1024 * 1024;
  const data = Buffer.alloc(chunkBytes * 2 + 37, "e");
  data.write("EasyShare chunked fallback smoke test.", 0, "utf8");
  const totalChunks = Math.ceil(data.length / chunkBytes);

  const upload = await postJson(`${serverUrl}/api/rooms/${room.id}/uploads`, {
    name: "smoke.txt",
    type: "text/plain",
    size: data.length,
    totalChunks,
  });

  for (let index = 0; index < totalChunks; index += 1) {
    const form = new FormData();
    const chunk = data.subarray(index * chunkBytes, (index + 1) * chunkBytes);
    form.append("index", String(index));
    form.append("chunk", new Blob([chunk], { type: "application/octet-stream" }), `chunk-${index}`);

    const response = await fetch(`${serverUrl}/api/rooms/${room.id}/uploads/${upload.id}/chunks`, {
      method: "POST",
      body: form,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Chunk failed: ${response.status}`);
  }

  const completed = await postJson(`${serverUrl}/api/rooms/${room.id}/uploads/${upload.id}/complete`, {});
  const downloaded = await fetch(`${serverUrl}${completed.downloadUrl}`).then((response) => response.arrayBuffer());
  const text = Buffer.from(downloaded).toString("utf8");

  if (text !== data.toString("utf8")) throw new Error("Downloaded fallback file did not match uploaded content.");

  console.log(`ok ${room.id} ${completed.id} ${totalChunks} chunks`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

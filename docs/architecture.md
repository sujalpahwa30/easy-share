# EasyShare Architecture

EasyShare solves a narrow classroom workflow: move one file from a student's device to a presentation machine without signing into WhatsApp, Google Drive, email, or a personal account.

## Is This A Good Problem?

Yes, if the product stays focused. The real user pain is not "file sharing" in general; it is a short-lived handoff to a shared machine where logging into personal accounts is risky and slow. Colleges, labs, training rooms, conference rooms, print shops, and small offices all have this same pattern.

The product wins only when it is faster than opening WhatsApp Web and safer than forgetting to sign out. That means QR pairing, no account, visible expiry, and a projector-friendly receiver screen.

## Current Implementation

This codebase uses a WebRTC-first design:

1. The projector opens `/` and creates a 20 minute room.
2. The server creates a short room code and QR link to `/send/:roomId`.
3. The phone scans the QR code and joins the same room over WebSocket.
4. The phone creates a WebRTC offer and a DataChannel.
5. The server relays only signaling messages: offer, answer, and ICE candidates.
6. The phone streams file chunks over the DataChannel directly to the projector browser.
7. The projector creates a local object URL and shows a download button.

The Node server does not store file bytes in the direct path.

The relay fallback now uses upload sessions and 1 MB chunks. If one chunk fails, the sender retries that chunk instead of restarting the entire file.

## Interaction Features

- QR pairing with a visible room code.
- Copyable room link for rooms where scanning is inconvenient.
- Expiry countdown on the receiver screen.
- Multi-file selection and drag/drop on the sender screen.
- Ordered file queue with whole-batch progress.
- Animated receiving state on the projector screen.
- Direct transfer first, temporary relay fallback when peer-to-peer fails.

## Why Keep The Relay Fallback?

WebRTC is the right default because file bytes move peer-to-peer, but real campus networks can block peer-to-peer paths through firewall rules, client isolation, captive portals, or strict NAT behavior. For that reason the old temporary relay path remains:

- `POST /api/rooms/:roomId/uploads` creates an upload session.
- `POST /api/rooms/:roomId/uploads/:uploadId/chunks` uploads retryable file chunks.
- `POST /api/rooms/:roomId/uploads/:uploadId/complete` assembles the file and announces it to the receiver.
- `GET /api/rooms/:roomId/files/:fileId` downloads it on the projector.
- Files expire quickly and can be removed from the projector screen.

This fallback is intentionally basic. In production it should move from memory to encrypted temporary object storage.

## Same Wi-Fi vs Different Networks

When EasyShare runs on your laptop at `localhost`, phones can only open the QR link if they can reach that laptop over the network. In practice that usually means both devices are on the same Wi-Fi and Windows Firewall allows Node.js.

To work across different networks, EasyShare must run at a public HTTPS URL:

1. Deploy the Node server to a public host.
2. Set `PUBLIC_BASE_URL` to that public URL.
3. Configure a TURN server so WebRTC can relay through strict NAT/firewall networks.
4. Keep the existing relay fallback for cases where direct WebRTC still fails.

The app now exposes `/api/config` so browsers receive ICE server settings from the backend. Configure TURN with either:

- `TURN_URL`, `TURN_USERNAME`, and `TURN_CREDENTIAL`
- `EASYSHARE_ICE_SERVERS` as full JSON for multiple STUN/TURN servers

Example:

```powershell
$env:PUBLIC_BASE_URL="https://easyshare.example.com"
$env:TURN_URL="turn:turn.example.com:3478"
$env:TURN_USERNAME="easyshare-user"
$env:TURN_CREDENTIAL="easyshare-password"
npm start
```

For quick demos without deployment, use a secure tunnel such as Cloudflare Tunnel or ngrok and set `PUBLIC_BASE_URL` to the generated HTTPS URL.

## Possible File Tool Features

These features fit EasyShare if they stay lightweight and task-oriented:

- Merge PDFs before sending.
- Split or compress PDFs.
- Convert images to PDF.
- Rename files before transfer.
- Bundle multiple files into a ZIP.
- Preview PDFs/images on the receiver before download.
- One-click "open presentation" for PDF/PPT/PPTX on the receiver.
- Basic image compression for large photos.
- Expiring transfer history for the current room.

Avoid full document editing at first. Editing PPT, DOCX, PDF, audio, and video inside the browser is a much larger product. A better path is to add small utilities around the transfer workflow: merge, compress, rename, preview, and bundle.

## Design Principles

- **No login:** Pairing is based on physical presence with the QR code.
- **Ephemeral by default:** Rooms and fallback files expire quickly.
- **Server-minimal direct path:** The server helps discovery and signaling, then gets out of the file path.
- **Explicit receiver context:** The receiver screen is optimized for a projector or smart TV.
- **Fallback over purity:** A reliable product beats a technically elegant one that fails on blocked networks.

## Production Hardening

- Serve over HTTPS. WebRTC and QR-based pairing should not run over plain HTTP outside local development.
- Add TURN servers for networks where direct peer-to-peer fails.
- Move fallback uploads to encrypted object storage with signed URLs.
- Add chunked fallback uploads with retry and progress.
- Add receiver approval before accepting files in public rooms.
- Add a visible one-time confirmation code for crowded classrooms.
- Add per-room and per-IP rate limits.
- Add malware scanning for institutional deployments.
- Add audit-light observability: room created, transfer mode, size bucket, success/failure reason, but never filenames unless the institution explicitly requires it.

## Snapdrop Reference

Classic Snapdrop uses the same core idea: vanilla frontend, WebRTC, WebSockets, Node.js, and a PWA-style browser experience. In its classic server, peers are grouped into rooms and signaling messages are relayed between peers, while file transfer happens in the browser data channel. EasyShare adapts that shape for a presentation-room workflow where the projector is the receiver and the QR code is the pairing action.

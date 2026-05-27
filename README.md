# EasyShare

EasyShare is a no-login file transfer app for classrooms, labs, meetings, and shared screens. One device opens a receiver room, another device scans the QR code, and files move through a WebRTC-first transfer path with a chunked relay fallback.

## Project Structure

```text
.
├─ server.js                  # Backend: Express, QR rooms, WebSocket signaling, relay fallback
├─ package.json               # Node scripts and dependencies
├─ package-lock.json
├─ public/
│  ├─ index.html              # Receiver/projector page
│  ├─ send.html               # Sender/mobile page
│  ├─ receiver.js             # Receiver room, WebRTC receive, file list
│  ├─ sender.js               # Sender queue, direct transfer, chunked fallback
│  ├─ theme.js                # Light/dark theme toggle
│  └─ styles.css              # Responsive UI, animations, dark mode
├─ scripts/
│  └─ smoke-signaling.js      # WebSocket signaling smoke test
├─ docs/
│  └─ architecture.md         # Architecture notes and production roadmap
└─ .env.example               # Deployment environment variable examples
```

## Frontend

The frontend is everything in `public/`.

- `index.html` and `receiver.js` run on the receiving device.
- `send.html` and `sender.js` run on the sending device.
- `styles.css` handles desktop/mobile layouts, dark mode, animations, and visual polish.
- `theme.js` persists light/dark mode.

The frontend talks to the backend through:

- `POST /api/rooms`
- `GET /api/config`
- `POST /api/rooms/:id/uploads`
- `POST /api/rooms/:id/uploads/:uploadId/chunks`
- `POST /api/rooms/:id/uploads/:uploadId/complete`
- `GET /api/rooms/:id/files/:fileId`
- `WebSocket /ws?room=:roomId&role=sender|receiver`

## Backend

The backend is `server.js`.

It handles:

- Serving the frontend files.
- Creating short-lived rooms and QR codes.
- WebSocket signaling for WebRTC.
- STUN/TURN configuration through `/api/config`.
- Chunked relay fallback when direct WebRTC cannot connect.
- Room/file/upload expiry cleanup.
- WebSocket heartbeat cleanup.

## Local Development

```bash
npm install
npm start
```

Open:

```text
http://localhost:3000
```

For phone testing on the same Wi-Fi, use the LAN URL printed by the server:

```text
http://192.168.x.x:3000
```

## Git Bash Port Command

```bash
PORT=3001 npm start
```

## PowerShell Port Command

```powershell
$env:PORT="3001"
npm start
```

## Public Deployment

Deploy this as a Node app on a host that supports long-running servers and WebSockets, such as Render, Railway, Fly.io, or a VPS.

Vercel-style serverless hosting is not ideal for this backend because EasyShare uses WebSockets and in-memory room state.

Required production environment:

```bash
PUBLIC_BASE_URL=https://your-domain.com
```

Recommended production environment:

```bash
TURN_URL=turn:turn.example.com:3478
TURN_USERNAME=your-user
TURN_CREDENTIAL=your-password
```

Start command:

```bash
npm start
```

## Transfer Algorithm

EasyShare uses two paths:

1. WebRTC DataChannel direct transfer with ordered binary chunks and browser backpressure.
2. Chunked relay fallback with upload sessions, 1 MB chunks, retry per chunk, and final assembly on the receiver side.

The direct path is fastest and most private. The fallback path is more reliable when campus Wi-Fi, NAT, or firewalls block peer-to-peer connections.

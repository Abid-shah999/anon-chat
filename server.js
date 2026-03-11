import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import helmet from 'helmet';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileURLToPath } from 'url';

// __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isProd = process.env.NODE_ENV === 'production';
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const app = express();

// Security headers (dev-এ CSP সহজ রাখছি; প্রোড-এ চাইলে কনফিগ করুন)
app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

// CORS (dev/production condition)
if (allowedOrigins.length) {
  app.use(cors({ origin: allowedOrigins, credentials: true }));
} else if (!isProd) {
  app.use(cors({ origin: ['http://localhost:4000'], credentials: true }));
} else {
  app.use(cors()); // same-origin হলে ঠিক আছে
}

// Serve static frontend files from /public
app.use(express.static(path.join(__dirname, 'public')));

// Simple health endpoint
app.get('/health', (_, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: allowedOrigins.length
      ? allowedOrigins
      : (!isProd ? ['http://localhost:4000'] : undefined),
    methods: ['GET', 'POST']
  }
});

// === In-memory state (MVP) ===
// একজন ওয়েট করলে তাকে ধরে রাখা হবে; পরের ইউজার এলেই pair করবো
let waitingSocket = null;
// roomId -> { a: socketId, b: socketId, createdAt, status }
const rooms = new Map();

function randomAlias() {
  const animals = ['Fox','Owl','Koala','Panda','Hawk','Dolphin','Tiger','Wolf','Eagle','Lynx'];
  return `${animals[Math.floor(Math.random()*animals.length)]}-${Math.floor(100+Math.random()*900)}`;
}

io.on('connection', (socket) => {
  // প্রতিটি নতুন ইউজারের জন্য একটা random নাম (ডেমোর জন্য)
  socket.data.alias = randomAlias();
  socket.data.roomId = null;

  // ইউজার pairing শুরু করতে বলেছে
  socket.on('start', () => {
    // ছোট্ট rate-limit: 1 start প্রতি 3s
    const now = Date.now();
    if (socket.data.lastStart && now - socket.data.lastStart < 3000) {
      socket.emit('error', 'Too fast. Please wait a moment.');
      return;
    }
    socket.data.lastStart = now;

    if (waitingSocket && waitingSocket.id !== socket.id) {
      // দুজনকে pair করা হলো
      const roomId = uuidv4();
      rooms.set(roomId, {
        a: waitingSocket.id,
        b: socket.id,
        createdAt: now,
        status: 'active'
      });

      waitingSocket.join(roomId);
      socket.join(roomId);

      waitingSocket.data.roomId = roomId;
      socket.data.roomId = roomId;

      // উভয়কে জানানো হলো যে pair হয়েছে
      io.to(roomId).emit('paired', {
        roomId,
        you: socket.data.alias,           // ডেমো হিসেবে পাঠালাম; UI-তে ব্যবহার না করলেও চলে
        partner: waitingSocket.data.alias
      });

      // waiting queue খালি
      waitingSocket = null;
    } else {
      // কেউ নেই, আপনি অপেক্ষায় থাকুন
      waitingSocket = socket;
      socket.emit('waiting', 'Looking for a partner…');
    }
  });

  // চ্যাট মেসেজ পাওয়া গেলে
  socket.on('message', (text) => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms.has(roomId)) return;

    const now = Date.now();
    // flood control: ৩ সেকেন্ডে ১০টা মেসেজের বেশি না
    socket.data.lastMsgTimes = socket.data.lastMsgTimes || [];
    socket.data.lastMsgTimes = socket.data.lastMsgTimes.filter(t => now - t < 3000);
    if (socket.data.lastMsgTimes.length > 10) {
      socket.emit('error', 'You are sending messages too quickly.');
      return;
    }
    socket.data.lastMsgTimes.push(now);

    // ইনপুট স্যানিটাইজ (সাধারণ লিমিট)
    const safe = String(text ?? '').slice(0, 2000);

    // sender বাদ দিয়ে room-এ broadcast
    socket.to(roomId).emit('message', {
      from: socket.data.alias, // চাইলে hide করতে পারেন
      text: safe,
      ts: now
    });
  });

  // ইউজার চ্যাট ছাড়লে
  socket.on('leave', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    io.to(roomId).emit('ended', 'Your partner has left.');

    // room থেকে সবাইকে বার করা
    for (const s of io.sockets.adapter.rooms.get(roomId) || []) {
      io.sockets.sockets.get(s)?.leave(roomId);
      const peer = io.sockets.sockets.get(s);
      if (peer) peer.data.roomId = null;
    }
    rooms.delete(roomId);

    if (waitingSocket && waitingSocket.id === socket.id) waitingSocket = null;
  });

  // ইউজার কানেকশন কাটলে
  socket.on('disconnect', () => {
    if (waitingSocket && waitingSocket.id === socket.id) {
      waitingSocket = null;
    }
    const roomId = socket.data.roomId;
    if (roomId && rooms.has(roomId)) {
      socket.to(roomId).emit('ended', 'Partner disconnected.');
      rooms.delete(roomId);

      for (const s of io.sockets.adapter.rooms.get(roomId) || []) {
        const peer = io.sockets.sockets.get(s);
        if (peer) peer.data.roomId = null;
      }
    }
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
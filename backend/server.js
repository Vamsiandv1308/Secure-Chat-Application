require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const { EventEmitter } = require('events');

EventEmitter.defaultMaxListeners = 20;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
  },
});

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 4000;

const users = new Map();
const sessions = new Map();
const socketsByUser = new Map();
const undeliveredMessages = new Map();

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.SUPABASE_ANON_KEY ??
  process.env.VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY;
const useSupabase = Boolean(supabaseUrl && supabaseKey);
const supabase = useSupabase ? createClient(supabaseUrl, supabaseKey) : null;

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function createToken() {
  return crypto.randomBytes(24).toString('hex');
}

function buildUserPayload(user) {
  return {
    id: user.id,
    username: user.username,
    friends: [...user.friends],
  };
}

async function loadUsersFromSupabase() {
  if (!useSupabase) {
    console.warn('Supabase credentials missing; running in memory-only mode.');
    return;
  }
  const { data, error } = await supabase
    .from('users')
    .select('id, username, password_hash, friends, incoming_requests, outgoing_requests');
  if (error) {
    console.error('Unable to load users from Supabase:', error.message);
    return;
  }
  users.clear();
  data?.forEach((row) => {
    users.set(row.id, {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      friends: new Set(Array.isArray(row.friends) ? row.friends : []),
      incomingRequests: new Set(Array.isArray(row.incoming_requests) ? row.incoming_requests : []),
      outgoingRequests: new Set(Array.isArray(row.outgoing_requests) ? row.outgoing_requests : []),
    });
  });
}

async function persistUser(user) {
  if (!useSupabase) {
    return;
  }
  const { error } = await supabase.from('users').upsert(
    {
      id: user.id,
      username: user.username,
      password_hash: user.passwordHash,
      friends: [...user.friends],
      incoming_requests: [...user.incomingRequests],
      outgoing_requests: [...user.outgoingRequests],
    },
    { onConflict: 'id' }
  );
  if (error) {
    console.error('Unable to persist user', user.id, error.message);
  }
}

function requireAuth(req, res, next) {
  const authHeader = req.headers?.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }
  const token = authHeader.slice(7);
  const userId = sessions.get(token);
  if (!userId) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  const user = users.get(userId);
  if (!user) {
    return res.status(401).json({ error: 'User no longer exists' });
  }
  req.user = user;
  req.token = token;
  next();
}

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  const normalized = username.toLowerCase();
  if ([...users.values()].some((u) => u.username.toLowerCase() === normalized)) {
    return res.status(409).json({ error: 'Username already exists' });
  }
  const id = crypto.randomUUID();
  const passwordHash = hashPassword(password);
  const user = {
    id,
    username,
    passwordHash,
    friends: new Set(),
    incomingRequests: new Set(),
    outgoingRequests: new Set(),
  };
  users.set(id, user);
  await persistUser(user);
  return res.status(201).json({ success: true });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  const user = [...users.values()].find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (!user || user.passwordHash !== hashPassword(password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = createToken();
  sessions.set(token, user.id);
  return res.json({ token, user: buildUserPayload(user) });
});

app.get('/api/me', requireAuth, (req, res) => {
  return res.json({ user: buildUserPayload(req.user) });
});

app.get('/api/friends', requireAuth, (req, res) => {
  const friends = [...req.user.friends].map((friendId) => {
    const friend = users.get(friendId);
    if (!friend) return null;
    return { id: friend.id, username: friend.username };
  }).filter(Boolean);
  return res.json({ friends });
});

app.get('/api/requests', requireAuth, (req, res) => {
  const incoming = [...req.user.incomingRequests].map((userId) => {
    const requester = users.get(userId);
    if (!requester) return null;
    return { id: requester.id, username: requester.username };
  }).filter(Boolean);
  return res.json({ incoming });
});

app.post('/api/friend/request', requireAuth, async (req, res) => {
  const { username } = req.body;
  if (!username) {
    return res.status(400).json({ error: 'Missing username' });
  }
  const target = [...users.values()].find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (!target) {
    return res.status(404).json({ error: 'Target user not found' });
  }
  if (target.id === req.user.id) {
    return res.status(400).json({ error: 'Cannot add yourself' });
  }
  if (req.user.friends.has(target.id)) {
    return res.status(400).json({ error: 'Already friends' });
  }
  if (target.incomingRequests.has(req.user.id)) {
    return res.status(400).json({ error: 'Request already sent' });
  }
  target.incomingRequests.add(req.user.id);
  req.user.outgoingRequests.add(target.id);
  const targetSocket = socketsByUser.get(target.id);
  if (targetSocket) {
    targetSocket.emit('friend-request', {
      id: req.user.id,
      username: req.user.username,
    });
  }
  await persistUser(target);
  await persistUser(req.user);
  return res.json({ success: true });
});

app.post('/api/friend/accept', requireAuth, async (req, res) => {
  const { userId } = req.body;
  if (!userId || !req.user.incomingRequests.has(userId)) {
    return res.status(400).json({ error: 'No incoming request from that user' });
  }
  const requester = users.get(userId);
  if (!requester) {
    req.user.incomingRequests.delete(userId);
    return res.status(404).json({ error: 'Requesting user no longer exists' });
  }
  req.user.incomingRequests.delete(userId);
  req.user.friends.add(userId);
  requester.friends.add(req.user.id);
  requester.outgoingRequests.delete(req.user.id);
  await persistUser(req.user);
  await persistUser(requester);
  const requesterSocket = socketsByUser.get(userId);
  if (requesterSocket) {
    requesterSocket.emit('friend-accepted', {
      id: req.user.id,
      username: req.user.username,
    });
  }
  return res.json({ success: true, friend: { id: requester.id, username: requester.username } });
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) {
    return next(new Error('token required'));
  }
  const userId = sessions.get(token);
  if (!userId) {
    return next(new Error('invalid token'));
  }
  const user = users.get(userId);
  if (!user) {
    return next(new Error('user not found'));
  }
  socket.user = user;
  next();
});

io.on('connection', (socket) => {
  socketsByUser.set(socket.user.id, socket);
  const pending = undeliveredMessages.get(socket.user.id) || [];
  pending.forEach((message) => socket.emit(message.event, message.payload));
  undeliveredMessages.set(socket.user.id, []);

  socket.on('dh-public', ({ toUserId, publicKey }) => {
    if (!socket.user.friends.has(toUserId)) {
      return;
    }
    sendOrStore(toUserId, 'dh-public', {
      from: socket.user.id,
      publicKey,
    });
  });

  socket.on('secure-message', (payload) => {
    const { toUserId } = payload;
    if (!socket.user.friends.has(toUserId)) {
      return;
    }
    sendOrStore(toUserId, 'secure-message', {
      from: socket.user.id,
      ...payload,
    });
  });

  socket.on('disconnect', () => {
    socketsByUser.delete(socket.user.id);
  });
});

function sendOrStore(userId, event, payload) {
  const targetSocket = socketsByUser.get(userId);
  if (targetSocket) {
    targetSocket.emit(event, payload);
    return;
  }
  const bucket = undeliveredMessages.get(userId) || [];
  bucket.push({ event, payload });
  undeliveredMessages.set(userId, bucket);
}

async function startServer() {
  await loadUsersFromSupabase();
  server.listen(PORT, () => {
    console.log(`Secure chat backend listening on http://localhost:${PORT}`);
  });
}

startServer().catch((error) => {
  console.error('Backend failed to start', error);
  process.exit(1);
});

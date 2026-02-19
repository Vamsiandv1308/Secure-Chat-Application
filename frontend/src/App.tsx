import React, { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  createKeyPair,
  deriveSharedKey,
  exportPublicKey,
  importPublicKey,
  encryptWithKey,
  decryptWithKey,
  bufferToBase64,
  base64ToBytes,
} from './utils/crypto';
import { embedTextInImage, extractTextFromImage } from './utils/stego';

const backendUrl = import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:4000';

const flowSteps = [
  { label: 'Compose plain text', detail: 'Draft message in the editor' },
  { label: 'AES encryption', detail: 'AES-GCM scrambles the plaintext' },
  { label: 'Ciphertext packaged', detail: 'Ciphertext base64 ready for hiding' },
  { label: 'LSB embedding', detail: 'Ciphertext mapped into the image pixels' },
  { label: 'Transmit stego image', detail: 'Stego image sent through the socket' },
  { label: 'Message displayed', detail: 'Decrypted plaintext appears in chat' },
];

type Friend = {
  id: string;
  username: string;
};

type Message = {
  id: string;
  from: string;
  text: string;
  imageDataUrl: string;
  createdAt: number;
  status: 'sent' | 'received';
};

type DHState = {
  keyPair?: CryptoKeyPair;
  sharedKey?: CryptoKey;
  sentPublic?: boolean;
};

const getInitials = (username: string) =>
  username
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((segment) => segment[0].toUpperCase())
    .join('') || username.slice(0, 2).toUpperCase();

function App() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<{ id: string; username: string } | null>(null);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [requests, setRequests] = useState<Friend[]>([]);
  const [selectedFriendId, setSelectedFriendId] = useState<string | null>(null);
  const [friendSearch, setFriendSearch] = useState('');
  const [conversationFilter, setConversationFilter] = useState('');
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState('Ready');
  const [autoEncrypt, setAutoEncrypt] = useState(true);
  const [historyBackup, setHistoryBackup] = useState(false);
  const [, setKeyVersion] = useState(0);
  const [, setMessagesVersion] = useState(0);
  const threadsRef = useRef<Record<string, Message[]>>({});
  const sharedKeys = useRef(new Map<string, DHState>());
  const pendingMessagesRef = useRef(new Map<string, Array<any>>());
  const socketRef = useRef<Socket | null>(null);
  const [flowStage, setFlowStage] = useState(0);
  const finalFlowStageIndex = flowSteps.length - 1;

  const messages = selectedFriendId ? threadsRef.current[selectedFriendId] ?? [] : [];
  const conversationEntries = friends.map((friend) => {
    const thread = threadsRef.current[friend.id] ?? [];
    const last = thread[thread.length - 1];
    return {
      ...friend,
      lastMessage: last?.text ?? 'Send an encrypted hello to start',
      timestamp: last?.createdAt ? new Date(last.createdAt).toLocaleTimeString() : '—',
      unread: thread.filter((message) => message.status === 'received').length,
    };
  });
  const activeFriend = friends.find((friend) => friend.id === selectedFriendId);
  const filteredConversations = conversationEntries.filter((entry) =>
    entry.username.toLowerCase().includes(conversationFilter.toLowerCase().trim())
  );

  useEffect(() => {
    if (!token) return;
    fetchFriends();
    fetchRequests();
  }, [token]);

  useEffect(() => {
    if (!token) return;
    const socket = io(backendUrl, { auth: { token } });
    socketRef.current = socket;

    socket.on('secure-message', handleIncomingPayload);
    socket.on('dh-public', handleDhPayload);
    socket.on('friend-request', () => {
      fetchRequests();
      setStatus('New friend request received');
    });
    socket.on('friend-accepted', ({ id, username: friendName }: Friend) => {
      setStatus(`Friend added: ${friendName}`);
      fetchFriends();
      emitPublicKey(id);
    });
    socket.on('connect', () => setStatus('Connected to secure relay'));
    socket.on('disconnect', () => setStatus('Disconnected from relay'));

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [token]);

  useEffect(() => {
    if (!friends.length) {
      setSelectedFriendId(null);
      return;
    }
    if (!selectedFriendId || !friends.some((friend) => friend.id === selectedFriendId)) {
      setSelectedFriendId(friends[0].id);
    }
  }, [friends]);

  useEffect(() => {
    friends.forEach((friend) => {
      void emitPublicKey(friend.id);
    });
  }, [friends]);

  async function fetchFriends() {
    if (!token) return;
    try {
      const res = await fetch(`${backendUrl}/api/friends`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || 'Failed to load friends');
      setFriends(payload.friends);
    } catch (error) {
      console.error(error);
    }
  }

  async function fetchRequests() {
    if (!token) return;
    try {
      const res = await fetch(`${backendUrl}/api/requests`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || 'Failed to load requests');
      setRequests(payload.incoming);
    } catch (error) {
      console.error(error);
    }
  }

  async function handleRegister() {
    try {
      const res = await fetch(`${backendUrl}/api/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || 'Registration failed');
      }
      setMode('login');
      setStatus('Registered successfully. Please log in.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Registration failed');
    }
  }

  async function handleLogin() {
    try {
      const res = await fetch(`${backendUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || 'Login failed');
      }
      const payload = await res.json();
      setToken(payload.token);
      setUser(payload.user);
      setStatus(`Welcome ${payload.user.username}`);
      setUsername('');
      setPassword('');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Login failed');
    }
  }

  async function sendFriendRequest() {
    const normalized = friendSearch.trim();
    if (!normalized || !token) return;
    try {
      const res = await fetch(`${backendUrl}/api/friend/request`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ username: normalized }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || 'Request failed');
      }
      setFriendSearch('');
      setStatus('Friend request sent');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Request failed');
    }
  }

  async function acceptFriend(userId: string) {
    if (!token) return;
    try {
      const res = await fetch(`${backendUrl}/api/friend/accept`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ userId }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || 'Accept failed');
      }
      await res.json();
      setRequests((prev) => prev.filter((request) => request.id !== userId));
      await fetchFriends();
      setStatus('Friend added. Initiating secure key exchange.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Accept failed');
    }
  }

  function pushMessage(friendId: string, message: Message) {
    threadsRef.current[friendId] = [...(threadsRef.current[friendId] ?? []), message];
    setMessagesVersion((prev) => prev + 1);
  }

  function queuePendingMessage(friendId: string, payload: any) {
    const bucket = pendingMessagesRef.current.get(friendId) ?? [];
    bucket.push(payload);
    pendingMessagesRef.current.set(friendId, bucket);
  }

  async function runPendingMessages(friendId: string) {
    const bucket = pendingMessagesRef.current.get(friendId);
    if (!bucket?.length) return;
    pendingMessagesRef.current.delete(friendId);
    for (const payload of bucket) {
      await decryptIncoming(payload);
    }
  }

  async function handleDhPayload(data: { from: string; publicKey: JsonWebKey }) {
    await deriveSharedSecret(data.from, data.publicKey);
  }

  async function ensureDHState(friendId: string) {
    let state = sharedKeys.current.get(friendId);
    if (!state) {
      state = {};
      sharedKeys.current.set(friendId, state);
    }
    if (!state.keyPair) {
      state.keyPair = await createKeyPair();
    }
    return state;
  }

  async function emitPublicKey(friendId: string) {
    const state = await ensureDHState(friendId);
    if (state.sentPublic || !state.keyPair) {
      return;
    }
    const exported = await exportPublicKey(state.keyPair.publicKey);
    socketRef.current?.emit('dh-public', {
      toUserId: friendId,
      publicKey: exported,
    });
    state.sentPublic = true;
    sharedKeys.current.set(friendId, state);
  }

  async function deriveSharedSecret(friendId: string, theirPublic: JsonWebKey) {
    const state = await ensureDHState(friendId);
    const imported = await importPublicKey(theirPublic);
    state.sharedKey = await deriveSharedKey(state.keyPair!.privateKey, imported);
    sharedKeys.current.set(friendId, state);
    setKeyVersion((prev) => prev + 1);
    setStatus(`Secure channel established with ${getFriendName(friendId)}`);
    await runPendingMessages(friendId);
    if (!state.sentPublic) {
      await emitPublicKey(friendId);
    }
  }

  async function ensureSharedKey(friendId: string) {
    const state = sharedKeys.current.get(friendId);
    if (state?.sharedKey) {
      return state.sharedKey;
    }
    await emitPublicKey(friendId);
    return null;
  }

  function getFriendName(friendId: string) {
    return friends.find((friend) => friend.id === friendId)?.username ?? 'Friend';
  }

  async function decryptIncoming(payload: any) {
    const { from, imageDataUrl, iv } = payload;
    const state = sharedKeys.current.get(from);
    if (!state?.sharedKey) {
      queuePendingMessage(from, payload);
      await emitPublicKey(from);
      setStatus('Waiting for peer key to decrypt message');
      return;
    }
    try {
      const stegoPayload = await extractTextFromImage(imageDataUrl);
      const cipherBytes = base64ToBytes(stegoPayload);
      const plain = await decryptWithKey(state.sharedKey, cipherBytes, base64ToBytes(iv));
      pushMessage(from, {
        id: crypto.randomUUID(),
        from,
        text: plain,
        imageDataUrl,
        createdAt: Date.now(),
        status: 'received',
      });
      setFlowStage(finalFlowStageIndex);
    } catch (error) {
      console.error('decrypt incoming failed', error);
    }
  }

  async function handleIncomingPayload(payload: any) {
    await decryptIncoming(payload);
  }

  async function handleSendMessage() {
    if (!token || !selectedFriendId || !draft.trim()) return;
    const messageText = draft.trim();
    const sharedKey = await ensureSharedKey(selectedFriendId);
    if (!sharedKey) {
      setStatus('Waiting for shared key exchange');
      return;
    }
    setFlowStage(0);
    try {
      setFlowStage(1);
      const { cipherBytes, iv } = await encryptWithKey(sharedKey, messageText);
      setFlowStage(2);
      const cipherBase64 = bufferToBase64(cipherBytes);
      setFlowStage(3);
      const stegoImage = await embedTextInImage(cipherBase64);
      setFlowStage(4);
      socketRef.current?.emit('secure-message', {
        toUserId: selectedFriendId,
        imageDataUrl: stegoImage,
        iv: bufferToBase64(iv),
      });
      pushMessage(selectedFriendId, {
        id: crypto.randomUUID(),
        from: user?.id ?? 'me',
        text: messageText,
        imageDataUrl: stegoImage,
        createdAt: Date.now(),
        status: 'sent',
      });
      setDraft('');
      setStatus('Encrypted message sent via image');
      setFlowStage(finalFlowStageIndex);
    } catch (error) {
      console.error('send message error', error);
      setStatus('Failed to send secure message');
      setFlowStage(finalFlowStageIndex);
    }
  }

  function logout() {
    socketRef.current?.disconnect();
    socketRef.current = null;
    setToken(null);
    setUser(null);
    setFriends([]);
    setRequests([]);
    setSelectedFriendId(null);
    threadsRef.current = {};
    setMessagesVersion(0);
    sharedKeys.current.clear();
    pendingMessagesRef.current.clear();
    setStatus('Logged out');
  }

  const fillPercent = Math.round(((flowStage + 1) / flowSteps.length) * 100);

  if (!token) {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <div className="auth-hero">
            <span className="auth-hero-badge">ZERO-KNOWLEDGE</span>
            <h1>Secured Chat</h1>
            <p className="auth-subtitle">
              Real-time messaging with AES encryption and LSB steganography for every session.
            </p>
            <ul>
              <li>Multi-step issuance: key exchange → AES → steganography</li>
              <li>Visual flow tracking keeps you informed</li>
              <li>Responsive, professionally styled interfaces</li>
            </ul>
          </div>
          <div className="auth-form">
            <div className="auth-mode">
              <button
                type="button"
                className={mode === 'login' ? 'active' : ''}
                onClick={() => setMode('login')}
              >
                Sign in
              </button>
              <button
                type="button"
                className={mode === 'register' ? 'active' : ''}
                onClick={() => setMode('register')}
              >
                Create account
              </button>
            </div>
            <div className="auth-form-body">
              <label className="input-label">
                <span>Username</span>
                <input value={username} onChange={(event) => setUsername(event.target.value)} />
              </label>
              <label className="input-label">
                <span>Password</span>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
            </div>
            <button
              type="button"
              className="auth-submit"
              onClick={mode === 'login' ? handleLogin : handleRegister}
            >
              {mode === 'login' ? 'Sign in securely' : 'Create secured account'}
            </button>
            <p className="status-bar">{status}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <section className="conversations-panel">
        <div className="panel-heading">
          <div>
            <strong>Connections</strong>
            <p>Confirmed friends and pending requests</p>
          </div>
          <small>Secure, trusted peers only</small>
        </div>
        <div className="friend-request">
          <input
            placeholder="Invite a username"
            value={friendSearch}
            onChange={(event) => setFriendSearch(event.target.value)}
          />
          <button type="button" onClick={sendFriendRequest}>
            Send invite
          </button>
        </div>
        <div className="requests-panel">
          <div className="requests-header">
            <strong>Incoming requests</strong>
            <span>{requests.length} pending</span>
          </div>
          {requests.length === 0 ? (
            <p className="empty-state">No pending approvals</p>
          ) : (
            requests.map((request) => (
              <div key={request.id} className="request-row">
                <div>
                  <strong>{request.username}</strong>
                  <small>Awaiting your confirmation</small>
                </div>
                <button type="button" onClick={() => acceptFriend(request.id)}>
                  Accept
                </button>
              </div>
            ))
          )}
        </div>
        <div className="conversation-search">
          <input
            type="text"
            placeholder="Search conversations..."
            value={conversationFilter}
            onChange={(event) => setConversationFilter(event.target.value)}
          />
        </div>
        <div className="conversation-list">
          {filteredConversations.length === 0 && (
            <p className="empty-state">No secured conversations yet</p>
          )}
          {filteredConversations.map((entry) => (
            <div
              key={entry.id}
              className={`conversation-item ${entry.id === selectedFriendId ? 'active' : ''}`}
              onClick={() => setSelectedFriendId(entry.id)}
            >
              <div className="conversation-avatar">{getInitials(entry.username)}</div>
              <div className="conversation-meta">
                <strong>{entry.username}</strong>
                <p>{entry.lastMessage}</p>
              </div>
              <div className="conversation-meta-right">
                <span>{entry.timestamp}</span>
                {entry.unread > 0 && <span className="unread-badge">{entry.unread}</span>}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="chat-columns">
        <div className="chat-panel">
          <header className="chat-header">
            <div className="chat-profile">
              <div className="conversation-avatar">
                {activeFriend ? getInitials(activeFriend.username) : 'SC'}
              </div>
              <div>
                <h3>{activeFriend ? activeFriend.username : 'Select a secured friend'}</h3>
                <p>{activeFriend ? 'Online • AES ready' : 'Choose a friend to unlock stego flow'}</p>
              </div>
            </div>
            <div className="chat-actions">
              <button type="button" aria-label="Voice call">
                📞
              </button>
              <button type="button" aria-label="Video call">
                🎥
              </button>
              <button type="button" aria-label="Session info">
                ℹ️
              </button>
            </div>
          </header>
          <div className="chat-messages">
            {!selectedFriendId && (
              <p className="empty-state">Select a friend and start the secure chat.</p>
            )}
            {messages.map((message) => (
              <article key={message.id} className={`chat-bubble ${message.status}`}>
                <strong>{message.status === 'sent' ? 'You' : getFriendName(message.from)}</strong>
                <p>{message.text}</p>
                <small>{new Date(message.createdAt).toLocaleTimeString()}</small>
              </article>
            ))}
          </div>
          <div className="chat-composer">
            <button type="button" className="icon-button" aria-label="Attachment">
              📎
            </button>
            <textarea
              placeholder="Type message..."
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="composer-actions">
              <button type="button" className="icon-button" aria-label="Emoji">
                😊
              </button>
              <button type="button" className="send-button" onClick={handleSendMessage}>
                Send secure
              </button>
            </div>
          </div>
        </div>
        <div className="flow-panel">
          <div className="flow-heading">
            <strong>Security flow</strong>
            <p>Every message follows AES encryption + LSB steganography.</p>
          </div>
          <div className="flow-progress">
            <div className="flow-progress-track">
              <div className="flow-progress-filled" style={{ width: `${fillPercent}%` }} />
            </div>
            <span>
              Stage {flowStage + 1} of {flowSteps.length}
            </span>
          </div>
          <div className="flow-steps">
            {flowSteps.map((step, index) => (
              <div key={step.label} className={`flow-step ${index === flowStage ? 'active' : ''}`}>
                <div className="flow-step-index">{index + 1}</div>
                <div>
                  <span>{step.label}</span>
                  <small>{step.detail}</small>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

export default App;

<<<<<<< HEAD
# Secure Steganographic Chat

This workspace contains a prototype of a real-time chat that chains AES encryption, Diffie-Hellman key exchange, and LSB steganography to hide ciphertext inside an image before sending it over the wire.

## Architecture
- **Backend (ackend/)**: Node/Express server with Socket.IO for real-time relaying, in-memory stores for users/friends/tokens, REST endpoints for account management, and events for key exchange and encrypted payload delivery.
- **Frontend (rontend/)**: Vite + React + Socket.IO client. The UI handles authentication, friend requests, Diffie-Hellman handshakes, AES-GCM encryption/decryption, and LSB encoding/decoding on a canvas to simulate hiding ciphertext inside an image.

## Getting started
1. **Install dependencies**
   `ash
   cd backend
   npm install
   cd ../frontend
   npm install
   `
2. **Run the backend** (default port 4000):
   `ash
   cd backend
   npm run dev
   `
3. **Run the frontend** (default port 5173):
   `ash
   cd frontend
   npm run dev
   `
4. Open http://localhost:5173 in two different browsers (or incognito tabs), register two users, exchange friend requests, then send messages to observe the AES ? LSB ? image ? extract ? AES flow.

## Security flow
1. Friends exchange ECDH P-256 public keys via Socket.IO.
2. Each client derives a shared 256-bit AES-GCM key with Web Crypto.
3. Plaintext is encrypted and base64-encoded ciphertext is embedded into the least-significant bits of a synthetic image (blue channel only).
4. The modified image + IV are sent over Socket.IO.
5. The receiver extracts the ciphertext from the LSBs, decrypts with AES, and reveals the message.

## Supabase persistence
Backend user accounts are saved in Supabase so registration data survives process restarts. You now need two `.env` files (both already ignored):

- `frontend/.env` – contains Vite variables that the browser can access (you already filled this).
- `backend/.env` – contains Supabase connection data for Node. Example entries:

```
SUPABASE_URL=https://xsxugnbhfvnpirifwbjm.supabase.co
SUPABASE_ANON_KEY=<your service or anon key with write permissions>
```

The backend will also accept `SUPABASE_SERVICE_ROLE_KEY` instead of `SUPABASE_ANON_KEY`, and it still falls back to VITE-prefixed variables for legacy compatibility. Populate the backend `.env` before you run `backend/npm run dev`, and the server will print any Supabase errors it encounters.

```
VITE_SUPABASE_URL=https://xsxugnbhfvnpirifwbjm.supabase.co
VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY=sb_publishable_NfbgWmZVctfwsEvAgPI7rQ_zvE1qffc
```

Create a `users` table in Supabase with these columns (adjust names if you map them differently in Supabase):

- `id` (text, primary key)
- `username` (text, unique)
- `password_hash` (text)
- `friends` (jsonb, default `[]`)
- `incoming_requests` (jsonb, default `[]`)
- `outgoing_requests` (jsonb, default `[]`)

The backend loads every user row on startup and keeps the federation in sync by upserting the row whenever someone registers, requests, or accepts a friendship.

## Notes
- All state is kept in-memory for the prototype; production code should persist users, sessions, and messages securely.
- Frontend assumes http://localhost:4000 backend; point VITE_BACKEND_URL to another address in .env if needed.
=======
# Secure-Chat-Application
>>>>>>> e39bf36d5e033c39c31ae4223118b126a3e5f508

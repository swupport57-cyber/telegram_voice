import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import http from 'http';
import pg from 'pg';

const execAsync = promisify(exec);
const { Pool } = pg;

// ---- config ----
const PORT = process.env.PORT || 3001;
const APP_BASE_URL = process.env.APP_BASE_URL;
const TG_API_ID = parseInt(process.env.TG_API_ID);
const TG_API_HASH = process.env.TG_API_HASH;
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL;
const BRIDGE_SECRET = process.env.BRIDGE_SECRET;

if (!APP_BASE_URL || !TG_API_ID || !TG_API_HASH || !SUPABASE_DB_URL || !BRIDGE_SECRET) {
  console.error('Missing required environment variables');
  process.exit(1);
}

const adminPool = new Pool({ connectionString: SUPABASE_DB_URL });

// In-memory client cache, keyed by userId
const clients = new Map();

// Per-user login state: userId -> { client, phoneCodeHash, phone }
const pendingLogins = new Map();

async function getUserSession(userId) {
  const schema = `tg_${String(userId).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40) || 'default'}`;
  await adminPool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await adminPool.query(`
    CREATE TABLE IF NOT EXISTS ${schema}.sessions (
      user_id TEXT PRIMARY KEY,
      session_string TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  const res = await adminPool.query(
    `SELECT session_string FROM ${schema}.sessions WHERE user_id = $1`,
    [userId]
  );
  return res.rows[0]?.session_string || '';
}

async function saveUserSession(userId, sessionString) {
  const schema = `tg_${String(userId).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40) || 'default'}`;
  await adminPool.query(
    `INSERT INTO ${schema}.sessions (user_id, session_string, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE SET session_string = $2, updated_at = NOW()`,
    [userId, sessionString]
  );
}

async function getOrCreateClient(userId) {
  if (clients.has(userId)) return clients.get(userId);

  const sessionString = await getUserSession(userId);
  const session = new StringSession(sessionString);

  const client = new TelegramClient(session, TG_API_ID, TG_API_HASH, {
    connectionRetries: 5,
    useWSS: false,
  });

  const entry = { client, connected: false };
  clients.set(userId, entry);

  if (sessionString) {
    try {
      await client.connect();
      entry.connected = true;
      console.log(`[${userId}] reconnected from saved session`);
    } catch (e) {
      console.error(`[${userId}] reconnect failed:`, e.message);
      clients.delete(userId);
      throw new Error('Saved session is invalid — please log in again.');
    }
  }

  return entry;
}

// ---- the server ----

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Bridge-Secret');

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');

  res.setHeader('Content-Type', 'application/json');

  const providedSecret = req.headers['x-bridge-secret'];
  if (providedSecret !== BRIDGE_SECRET) {
    res.writeHead(401).end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    // ---- POST /tg/start-login ----
    if (req.method === 'POST' && url.pathname === '/tg/start-login') {
      const { userId, phone } = JSON.parse(raw || '{}');
      if (!userId || !phone) {
        res.writeHead(400).end(JSON.stringify({ ok: false, error: 'userId and phone required' }));
        return;
      }

      const cleanPhone = String(phone).replace(/[^0-9+]/g, '');

      // Create a fresh client for this login attempt.
      const session = new StringSession('');
      const client = new TelegramClient(session, TG_API_ID, TG_API_HASH, {
        connectionRetries: 5,
        useWSS: false,
      });

      await client.connect();

      const result = await client.invoke({
        _: 'auth.sendCode',
        phoneNumber: cleanPhone,
        apiId: TG_API_ID,
        apiHash: TG_API_HASH,
        settings: { _: 'codeSettings' },
      });

      pendingLogins.set(userId, {
        client,
        phone: cleanPhone,
        phoneCodeHash: result.phoneCodeHash,
      });

      res.end(JSON.stringify({ ok: true, message: 'Code sent. Check your Telegram app.' }));
      return;
    }

    // ---- POST /tg/verify ----
    if (req.method === 'POST' && url.pathname === '/tg/verify') {
      const { userId, code } = JSON.parse(raw || '{}');
      if (!userId || !code) {
        res.writeHead(400).end(JSON.stringify({ ok: false, error: 'userId and code required' }));
        return;
      }

      const pending = pendingLogins.get(userId);
      if (!pending) {
        res.writeHead(400).end(JSON.stringify({ ok: false, error: 'No pending login. Start over.' }));
        return;
      }

      try {
        await pending.client.invoke({
          _: 'auth.signIn',
          phoneNumber: pending.phone,
          phoneCodeHash: pending.phoneCodeHash,
          phoneCode: String(code),
        });

        const sessionString = pending.client.session.save();
        await saveUserSession(userId, sessionString);

        // Move the authenticated client into the live cache.
        clients.set(userId, { client: pending.client, connected: true });
        pendingLogins.delete(userId);

        res.end(JSON.stringify({ ok: true, message: 'Logged in successfully.' }));
      } catch (err) {
        const msg = err?.errorMessage || err?.message || String(err);
        if (msg.includes('SESSION_PASSWORD_NEEDED')) {
          res.end(JSON.stringify({ ok: true, passwordNeeded: true, message: '2FA password required.' }));
        } else if (msg.includes('PHONE_CODE_INVALID')) {
          res.writeHead(400).end(JSON.stringify({ ok: false, error: 'Invalid code. Try again.' }));
        } else {
          res.writeHead(500).end(JSON.stringify({ ok: false, error: msg }));
        }
      }
      return;
    }

    // ---- POST /tg/verify-password ----
    if (req.method === 'POST' && url.pathname === '/tg/verify-password') {
      const { userId, password } = JSON.parse(raw || '{}');
      if (!userId || !password) {
        res.writeHead(400).end(JSON.stringify({ ok: false, error: 'userId and password required' }));
        return;
      }

      const pending = pendingLogins.get(userId);
      if (!pending) {
        res.writeHead(400).end(JSON.stringify({ ok: false, error: 'No pending login. Start over.' }));
        return;
      }

      try {
        await pending.client.invoke({
          _: 'auth.checkPassword',
          password: await pending.client.invoke({
            _: 'account.getPassword',
            password: password,
          }),
        });

        const sessionString = pending.client.session.save();
        await saveUserSession(userId, sessionString);
        clients.set(userId, { client: pending.client, connected: true });
        pendingLogins.delete(userId);

        res.end(JSON.stringify({ ok: true, message: 'Logged in successfully.' }));
      } catch (err) {
        res.writeHead(400).end(JSON.stringify({ ok: false, error: err?.errorMessage || 'Wrong password.' }));
      }
      return;
    }

    // ---- GET /tg/status ----
    if (req.method === 'GET' && url.pathname === '/tg/status') {
      const userId = url.searchParams.get('userId');
      const entry = clients.get(userId);
      const hasSaved = userId ? !!(await getUserSession(userId)) : false;
      res.end(JSON.stringify({
        ok: true,
        connected: !!entry?.connected,
        hasSavedSession: hasSaved,
      }));
      return;
    }

    // ---- POST /tg/send ----
    if (req.method === 'POST' && url.pathname === '/tg/send') {
      const { userId, to, resultId, mode } = JSON.parse(raw || '{}');
      if (!userId || !to || !resultId) {
        res.writeHead(400).end(JSON.stringify({ ok: false, error: 'userId, to, resultId required' }));
        return;
      }

      const entry = clients.get(userId);
      if (!entry?.connected) {
        res.writeHead(409).end(JSON.stringify({ ok: false, error: 'Not logged in. Please log in first.' }));
        return;
      }

      // Fetch the converted audio from app.py
      const audioRes = await fetch(`${APP_BASE_URL}/api/result/${encodeURIComponent(resultId)}`);
      if (!audioRes.ok) {
        res.writeHead(502).end(JSON.stringify({ ok: false, error: `Audio fetch failed: ${audioRes.status}` }));
        return;
      }
      const inputBuf = Buffer.from(await audioRes.arrayBuffer());

      const tmpDir = os.tmpdir();
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const inPath = path.join(tmpDir, `tg-${stamp}.wav`);
      const outPath = path.join(tmpDir, `tg-${stamp}.${mode === 'video' ? 'mp4' : 'ogg'}`);

      await fs.writeFile(inPath, inputBuf);

      try {
        if (mode === 'video') {
          // Video note: mp4, square, with audio.
          await execAsync(
            `ffmpeg -y -i "${inPath}" ` +
            `-c:v libx264 -preset ultrafast -crf 28 ` +
            `-vf "scale=480:480:force_original_aspect_ratio=increase,crop=480:480" ` +
            `-c:a aac -b:a 64k -movflags +faststart ` +
            `-t 60 "${outPath}"`,
            { timeout: 60000 }
          );
        } else {
          // Voice note: OGG / Opus / 16kHz / mono.
          await execAsync(
            `ffmpeg -y -i "${inPath}" ` +
            `-vn -c:a libopus -b:a 32k -ar 16000 -ac 1 ` +
            `-application voip -avoid_negative_ts make_zero -map_metadata -1 ` +
            `"${outPath}"`,
            { timeout: 30000 }
          );
        }

        const media = await entry.client.uploadFile({
          file: new CustomFile(
            path.basename(outPath),
            (await fs.stat(outPath)).size,
            outPath
          ),
          workers: 1,
        });

        const sendOptions = {
          file: media,
          voiceNote: mode !== 'video',
          videoNote: mode === 'video',
          attributes: mode === 'video' ? [] : undefined,
        };

        await entry.client.sendFile(to, sendOptions);

        res.end(JSON.stringify({ ok: true, to, mode: mode || 'voice' }));
      } finally {
        await fs.unlink(inPath).catch(() => {});
        await fs.unlink(outPath).catch(() => {});
      }
      return;
    }

    res.writeHead(404).end(JSON.stringify({ ok: false, error: 'not found' }));
  } catch (err) {
    console.error('request failed:', err);
    res.writeHead(500).end(JSON.stringify({ ok: false, error: err?.message || String(err) }));
  }
});

// GramJS needs a CustomFile wrapper for uploads.
import { CustomFile } from 'telegram/client/uploads.js';

server.listen(PORT, () => console.log(`TG bridge on :${PORT}`));

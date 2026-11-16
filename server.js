'use strict';
// ShotDrop upload server — no dependencies, Node.js 20+.
//
//   POST   /api/upload        multipart/form-data, field "file" (PNG/JPEG/GIF/WebP)  → {"url": ".../Ab3dE9xZ.png"}
//   DELETE /api/<id>          delete a screenshot
//   GET    /<id>.<ext>        the image itself (cached forever)
//   GET    /health            "ok"
//
// /api/* requires "Authorization: Bearer <UPLOAD_TOKEN>".
//
// Environment:
//   UPLOAD_TOKEN   required — the secret the desktop app sends
//   PUBLIC_URL     base for returned links, e.g. https://shots.example.com (default: taken from the request)
//   DATA_DIR       where images are stored (default /data)
//   PORT           default 3000
//   MAX_UPLOAD_MB  default 25

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || '/data');
const IMAGES = path.join(DATA_DIR, 'images');
const TOKEN = (process.env.UPLOAD_TOKEN || '').trim();
let PUBLIC_URL = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
if (PUBLIC_URL && !/^https?:\/\//i.test(PUBLIC_URL)) PUBLIC_URL = 'https://' + PUBLIC_URL; // "img.example.com" → https://…
const MAX_BYTES = (Number(process.env.MAX_UPLOAD_MB) || 25) * 1024 * 1024;

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const ID_LENGTH = 8; // 62^8 ≈ 2·10^14 — not guessable by enumeration
const FILE_RE = /^\/([A-Za-z0-9]{8})\.(png|jpg|gif|webp)$/;
const DELETE_RE = /^\/api\/([A-Za-z0-9]{8})(?:\.(?:png|jpg|gif|webp))?$/;

const TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

if (TOKEN.length < 16) {
  console.error('UPLOAD_TOKEN is not set or shorter than 16 characters — refusing to start.');
  process.exit(1);
}
fs.mkdirSync(IMAGES, { recursive: true });
fs.accessSync(IMAGES, fs.constants.W_OK); // fail fast if the volume is not writable

// ------------------------------------------------------------------ helpers

function newId() {
  let id = '';
  for (let i = 0; i < ID_LENGTH; i++) id += ID_ALPHABET[crypto.randomInt(ID_ALPHABET.length)];
  return id;
}

/** File type by content (magic bytes), not by what the client claims. */
function detectType(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

function authorized(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return false;
  const a = crypto.createHash('sha256').update(m[1].trim()).digest();
  const b = crypto.createHash('sha256').update(TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body === 'object';
  const data = isJson ? JSON.stringify(body) : String(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`).split(',')[0].trim();
  return `${proto}://${host}`;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > limit) return reject(Object.assign(new Error('File is too large'), { status: 413 }));
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('File is too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Returns the first file part of a multipart/form-data body: {field, filename, data}. */
function firstFilePart(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) return null;
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
  let pos = body.indexOf(boundary);
  while (pos !== -1) {
    const headStart = pos + boundary.length + 2; // skip CRLF
    const headEnd = body.indexOf('\r\n\r\n', headStart);
    if (headEnd === -1) return null;
    const head = body.subarray(headStart, headEnd).toString('utf8');
    const next = body.indexOf(boundary, headEnd + 4);
    if (next === -1) return null;
    const data = body.subarray(headEnd + 4, next - 2); // strip CRLF before the boundary
    // quotes are optional: .NET sends  name=file; filename=Shot.png; filename*=utf-8''Shot.png
    const filename = /[;\s]filename\*?="?([^";\r\n]*)"?/i.exec(head);
    if (filename) {
      const field = /[;\s]name="?([^";\r\n]*)"?/i.exec(head);
      return { field: field ? field[1] : '', filename: filename[1], data };
    }
    pos = next;
  }
  return null;
}

async function saveUnique(data, ext) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const id = newId();
    const file = path.join(IMAGES, `${id}.${ext}`);
    const tmp = path.join(IMAGES, `.${id}.${process.pid}.tmp`);
    await fsp.writeFile(tmp, data, { flag: 'wx' });
    try {
      // link() fails if the name already exists — no chance of overwriting another screenshot
      await fsp.link(tmp, file);
      return id;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    } finally {
      await fsp.unlink(tmp).catch(() => {});
    }
  }
  throw new Error('Could not allocate a file name');
}

async function findById(id) {
  for (const ext of Object.keys(TYPES)) {
    const file = path.join(IMAGES, `${id}.${ext}`);
    try {
      await fsp.access(file);
      return file;
    } catch {}
  }
  return null;
}

// ------------------------------------------------------------------ handlers

async function handleUpload(req, res) {
  if (!authorized(req)) {
    await new Promise((r) => setTimeout(r, 500)); // slow down token guessing
    return send(res, 401, { error: 'Invalid or missing token' });
  }
  const ct = req.headers['content-type'] || '';
  if (!/^multipart\/form-data/i.test(ct)) return send(res, 400, { error: 'Expected multipart/form-data' });

  const body = await readBody(req, MAX_BYTES + 64 * 1024);
  const part = firstFilePart(body, ct);
  if (!part || part.data.length === 0) return send(res, 400, { error: 'No file in the request' });
  if (part.data.length > MAX_BYTES) return send(res, 413, { error: 'File is too large' });

  const ext = detectType(part.data);
  if (!ext) return send(res, 415, { error: 'Only PNG, JPEG, GIF and WebP images are accepted' });

  const id = await saveUnique(part.data, ext);
  const url = `${baseUrl(req)}/${id}.${ext}`;
  console.log(`upload ${id}.${ext} ${part.data.length} bytes`);
  return send(res, 201, { url, id }, { Location: url });
}

async function handleDelete(req, res, id) {
  if (!authorized(req)) return send(res, 401, { error: 'Invalid or missing token' });
  const file = await findById(id);
  if (!file) return send(res, 404, { error: 'Not found' });
  await fsp.unlink(file);
  console.log(`delete ${path.basename(file)}`);
  return send(res, 200, { deleted: id });
}

async function handleImage(req, res, id, ext) {
  const file = path.join(IMAGES, `${id}.${ext}`);
  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    return send(res, 404, 'Not found');
  }
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': TYPES[ext],
    'Content-Length': st.size,
    'Cache-Control': 'public, max-age=31536000, immutable',
    ETag: etag,
    'Last-Modified': st.mtime.toUTCString(),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': headers['Cache-Control'] });
    return res.end();
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (p === '/health') return send(res, 200, 'ok');

    if (p === '/api/upload') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' }, { Allow: 'POST' });
      return await handleUpload(req, res);
    }

    let m = DELETE_RE.exec(p);
    if (m && req.method === 'DELETE') return await handleDelete(req, res, m[1]);

    m = FILE_RE.exec(p);
    if (m && (req.method === 'GET' || req.method === 'HEAD')) return await handleImage(req, res, m[1], m[2]);

    return send(res, 404, 'Not found');
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
    if (!e.status) console.error(e);
  }
});

server.requestTimeout = 120_000;
server.listen(PORT, () => {
  console.log(`ShotDrop server on :${PORT}, images in ${IMAGES}, public URL: ${PUBLIC_URL || '(from request)'}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}

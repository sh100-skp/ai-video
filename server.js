'use strict';
// Planet Live 서버: 정적 파일 + JSON API + SQLite. 외부 패키지 없음(Node 22.5+ 내장 sqlite 사용).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_HOURS = 8;
const MAX_BODY = 4 * 1024 * 1024;
const MAX_THUMB = 2 * 1024 * 1024;
const DEFAULT_CATEGORIES = ['AI · 업무 생산성', '마케팅 · 세일즈', '데이터 · 분석', 'IT · 디지털'];

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

// ---------- DB ----------
function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS lectures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      video_url TEXT NOT NULL,
      instructor TEXT NOT NULL,
      category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
      description TEXT NOT NULL DEFAULT '',
      thumbnail BLOB,
      thumb_mime TEXT,
      is_public INTEGER NOT NULL DEFAULT 1,
      is_sample INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lectures_created ON lectures(created_at DESC);
  `);
  seed(db);
  return db;
}

function sampleThumb(label, c1, c2) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs><rect width="640" height="360" fill="url(#g)"/><circle cx="320" cy="150" r="46" fill="rgba(255,255,255,.16)"/><path d="M306 126l36 24-36 24z" fill="#fff"/><text x="320" y="248" text-anchor="middle" font-family="sans-serif" font-size="26" font-weight="700" fill="#fff">${esc(label)}</text><text x="320" y="288" text-anchor="middle" font-family="sans-serif" font-size="18" letter-spacing="6" fill="rgba(255,255,255,.7)">SAMPLE</text></svg>`
  );
}

function seed(db) {
  const seeded = db.prepare("SELECT value FROM meta WHERE key='seeded'").get();
  if (seeded) return;
  const insCat = db.prepare('INSERT OR IGNORE INTO categories (name, sort_order) VALUES (?, ?)');
  DEFAULT_CATEGORIES.forEach((n, i) => insCat.run(n, i));
  const catId = (n) => db.prepare('SELECT id FROM categories WHERE name=?').get(n).id;
  const samples = [
    ['[샘플] 생성형 AI로 보고서 초안 10분 만에 쓰기', '샘플 강사 A', DEFAULT_CATEGORIES[0], 1, '#111827', '#4b5563', 'AI · 업무 생산성'],
    ['[샘플] 회의록 자동 정리와 업무 자동화 입문', '샘플 강사 B', DEFAULT_CATEGORIES[0], 0, '#1f2937', '#6b7280', 'AI · 업무 생산성'],
    ['[샘플] 고객 퍼널 분석으로 전환율 높이기', '샘플 강사 C', DEFAULT_CATEGORIES[1], 1, '#262626', '#737373', '마케팅 · 세일즈'],
    ['[샘플] 세일즈 첫 미팅 스크립트 설계', '샘플 강사 D', DEFAULT_CATEGORIES[1], 0, '#171717', '#525252', '마케팅 · 세일즈'],
    ['[샘플] 엑셀과 SQL로 시작하는 데이터 분석', '샘플 강사 E', DEFAULT_CATEGORIES[2], 1, '#0f172a', '#475569', '데이터 · 분석'],
    ['[샘플] 클라우드와 보안 기초 한눈에 보기', '샘플 강사 F', DEFAULT_CATEGORIES[3], 0, '#18181b', '#52525b', 'IT · 디지털'],
  ];
  const ins = db.prepare(`INSERT INTO lectures (title, video_url, instructor, category_id, description, thumbnail, thumb_mime,
    is_public, is_sample, created_at, updated_at) VALUES (?,?,?,?,?,?,?,1,1,?,?)`);
  const now = Date.now();
  samples.forEach((s, i) => {
    const ts = new Date(now - (samples.length - i) * 86400000).toISOString();
    ins.run(s[0], '/sample-video.html', s[1], catId(s[2]),
      '실제 강의가 아닌 테스트용 샘플 콘텐츠입니다. 관리자 화면에서 수정하거나 삭제하세요.',
      sampleThumb(s[6], s[4], s[5]), 'image/svg+xml', ts, ts);
  });
  db.prepare("INSERT INTO meta (key, value) VALUES ('seeded', '1')").run();
}

// ---------- 유틸 ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function sendJson(res, status, data, extra = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) {
      return reject(new HttpError(415, 'JSON 형식의 요청만 허용됩니다.'));
    }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, '요청 크기가 너무 큽니다.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new HttpError(400, '잘못된 요청입니다.')); }
    });
    req.on('error', reject);
  });
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function validVideoUrl(u) {
  if (typeof u !== 'string' || u.length > 2000) return false;
  if (/^\/(?!\/)[^\s]*$/.test(u)) return true; // 사이트 내부 경로 (샘플 페이지용)
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch { return false; }
}

function decodeThumbnail(dataUrl) {
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl || '');
  if (!m) throw new HttpError(400, '썸네일은 PNG, JPG, WEBP, GIF 이미지만 업로드할 수 있습니다.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_THUMB) throw new HttpError(400, '썸네일 이미지는 2MB 이하여야 합니다.');
  const ok = {
    'image/png': buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    'image/jpeg': buf.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
    'image/gif': buf.subarray(0, 4).toString('latin1') === 'GIF8',
    'image/webp': buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP',
  }[m[1]];
  if (!ok) throw new HttpError(400, '올바른 이미지 파일이 아닙니다.');
  return { buf, mime: m[1] };
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

// ---------- 앱 ----------
function createServer(opts = {}) {
  const adminPassword = opts.adminPassword ?? process.env.ADMIN_PASSWORD;
  if (!adminPassword || adminPassword.length < 4) {
    throw new Error('ADMIN_PASSWORD(4자 이상) 환경변수를 설정해야 서버를 시작할 수 있습니다.');
  }
  const secret = opts.sessionSecret ?? process.env.SESSION_SECRET ?? crypto.randomBytes(32).toString('hex');
  const secureCookie = opts.secureCookie ?? process.env.NODE_ENV === 'production';
  const trustProxy = opts.trustProxy ?? process.env.TRUST_PROXY === '1';
  const db = openDb(opts.dbPath ?? process.env.DB_PATH ?? path.join(__dirname, 'data', 'planet-live.db'));
  const pwHash = crypto.createHash('sha256').update(adminPassword).digest();

  // 관리자 세션: "만료시각.HMAC서명" 형태의 서명 쿠키 (서버 비밀키 없이는 위조 불가)
  const sign = (exp) => crypto.createHmac('sha256', secret).update('admin.' + exp).digest('base64url');
  const makeToken = () => { const exp = Date.now() + SESSION_HOURS * 3600e3; return `${exp}.${sign(exp)}`; };
  function isAdmin(req) {
    const tok = parseCookies(req.headers.cookie).pl_admin;
    if (!tok) return false;
    const [exp, sig] = tok.split('.');
    if (!exp || !sig || !(Number(exp) > Date.now())) return false;
    const a = Buffer.from(sig), b = Buffer.from(sign(exp));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  const requireAdmin = (req) => { if (!isAdmin(req)) throw new HttpError(401, '관리자 로그인이 필요합니다.'); };
  const cookieAttrs = `Path=/; HttpOnly; SameSite=Strict${secureCookie ? '; Secure' : ''}`;

  // 로그인 시도 제한 (IP당 10분에 5회 실패)
  const fails = new Map();
  const clientIp = (req) => (trustProxy && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress;

  const LECTURE_SELECT = `SELECT l.id, l.title, l.video_url, l.instructor, l.category_id, c.name AS category_name,
      l.description, l.is_public, l.is_sample, l.created_at, l.updated_at,
      (l.thumbnail IS NOT NULL) AS has_thumb FROM lectures l JOIN categories c ON c.id = l.category_id`;
  const toLecture = (r) => ({
    id: r.id, title: r.title, videoUrl: r.video_url, instructor: r.instructor,
    categoryId: r.category_id, categoryName: r.category_name, description: r.description,
    isPublic: !!r.is_public, isSample: !!r.is_sample,
    createdAt: r.created_at, updatedAt: r.updated_at,
    thumbnailUrl: r.has_thumb ? `/api/lectures/${r.id}/thumbnail?v=${encodeURIComponent(r.updated_at)}` : null,
  });
  const getLecture = (id) => db.prepare(LECTURE_SELECT + ' WHERE l.id = ?').get(id);

  function validateLecture(body, existing) {
    const s = (v, d = '') => (typeof v === 'string' ? v.trim() : v === undefined ? d : null);
    const m = {
      title: s(body.title, existing?.title), videoUrl: s(body.videoUrl, existing?.video_url),
      instructor: s(body.instructor, existing?.instructor), description: s(body.description, existing?.description ?? ''),
      categoryId: body.categoryId !== undefined ? Number(body.categoryId) : existing?.category_id,
      isPublic: body.isPublic !== undefined ? !!body.isPublic : existing ? !!existing.is_public : true,    };
    if (!m.title) throw new HttpError(400, '강의 제목을 입력해 주세요.');
    if (m.title.length > 120) throw new HttpError(400, '강의 제목은 120자 이하로 입력해 주세요.');
    if (!m.videoUrl) throw new HttpError(400, '영상 URL을 입력해 주세요.');
    if (!validVideoUrl(m.videoUrl)) throw new HttpError(400, '영상 URL은 http:// 또는 https://로 시작하는 주소여야 합니다.');
    if (!m.instructor) throw new HttpError(400, '강사명을 입력해 주세요.');
    if (m.instructor.length > 50) throw new HttpError(400, '강사명은 50자 이하로 입력해 주세요.');
    if (m.description === null || m.description.length > 2000) throw new HttpError(400, '강의 소개는 2000자 이하로 입력해 주세요.');
    if (!Number.isInteger(m.categoryId) || !db.prepare('SELECT 1 FROM categories WHERE id=?').get(m.categoryId)) {
      throw new HttpError(400, '카테고리를 선택해 주세요.');
    }
    return m;
  }

  async function handleApi(req, res, url) {
    const { pathname } = url;
    const method = req.method;
    let m;

    // ----- 공개 API -----
    if (method === 'GET' && pathname === '/api/categories') {
      const rows = db.prepare(`SELECT c.id, c.name, (SELECT COUNT(*) FROM lectures l WHERE l.category_id=c.id AND l.is_public=1) AS count
        FROM categories c ORDER BY c.sort_order, c.id`).all();
      return sendJson(res, 200, rows.map((r) => ({ id: r.id, name: r.name, count: r.count })));
    }
    if (method === 'GET' && pathname === '/api/lectures') {
      const where = ['l.is_public = 1'];
      const params = [];
      const q = (url.searchParams.get('q') || '').trim();
      if (q) {
        const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
        where.push("(l.title LIKE ? ESCAPE '\\' OR l.instructor LIKE ? ESCAPE '\\')");
        params.push(like, like);
      }
      const cat = Number(url.searchParams.get('category'));
      if (cat) { where.push('l.category_id = ?'); params.push(cat); }
      const order = url.searchParams.get('sort') === 'oldest' ? 'ASC' : 'DESC';
      const rows = db.prepare(`${LECTURE_SELECT} WHERE ${where.join(' AND ')} ORDER BY l.created_at ${order}, l.id ${order}`).all(...params);
      return sendJson(res, 200, rows.map(toLecture));
    }
    if (method === 'GET' && (m = pathname.match(/^\/api\/lectures\/(\d+)\/thumbnail$/))) {
      const r = db.prepare('SELECT thumbnail, thumb_mime, is_public FROM lectures WHERE id=?').get(Number(m[1]));
      if (!r || !r.thumbnail || (!r.is_public && !isAdmin(req))) throw new HttpError(404, '이미지를 찾을 수 없습니다.');
      res.writeHead(200, {
        'Content-Type': r.thumb_mime, 'Content-Length': r.thumbnail.length, 'Cache-Control': 'private, max-age=86400',
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      });
      return res.end(Buffer.from(r.thumbnail));
    }

    // ----- 관리자 인증 -----
    if (method === 'GET' && pathname === '/api/admin/me') return sendJson(res, 200, { admin: isAdmin(req) });
    if (method === 'POST' && pathname === '/api/admin/login') {
      const ip = clientIp(req);
      const f = fails.get(ip);
      if (f && f.count >= 5 && f.resetAt > Date.now()) throw new HttpError(429, '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.');
      const body = await readJson(req);
      const given = crypto.createHash('sha256').update(String(body.password ?? '')).digest();
      if (!crypto.timingSafeEqual(given, pwHash)) {
        const cur = f && f.resetAt > Date.now() ? f : { count: 0, resetAt: Date.now() + 600e3 };
        cur.count++;
        fails.set(ip, cur);
        throw new HttpError(401, '비밀번호가 올바르지 않습니다.');
      }
      fails.delete(ip);
      return sendJson(res, 200, { admin: true }, { 'Set-Cookie': `pl_admin=${makeToken()}; Max-Age=${SESSION_HOURS * 3600}; ${cookieAttrs}` });
    }
    if (method === 'POST' && pathname === '/api/admin/logout') {
      return sendJson(res, 200, { admin: false }, { 'Set-Cookie': `pl_admin=; Max-Age=0; ${cookieAttrs}` });
    }

    // ----- 관리자 전용 API (모든 경로에서 서버가 인증을 검사) -----
    if (pathname.startsWith('/api/admin/')) {
      requireAdmin(req);

      if (method === 'GET' && pathname === '/api/admin/lectures') {
        return sendJson(res, 200, db.prepare(LECTURE_SELECT + ' ORDER BY l.created_at DESC, l.id DESC').all().map(toLecture));
      }
      if (method === 'POST' && pathname === '/api/admin/lectures') {
        const body = await readJson(req);
        const v = validateLecture(body, null);
        const thumb = body.thumbnail ? decodeThumbnail(body.thumbnail) : null;
        const now = new Date().toISOString(); // 등록일 자동 입력
        const r = db.prepare(`INSERT INTO lectures (title, video_url, instructor, category_id, description, thumbnail, thumb_mime,
          is_public, is_sample, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,0,?,?)`)
          .run(v.title, v.videoUrl, v.instructor, v.categoryId, v.description, thumb?.buf ?? null, thumb?.mime ?? null,
            v.isPublic ? 1 : 0, now, now);
        return sendJson(res, 201, toLecture(getLecture(Number(r.lastInsertRowid))));
      }
      if ((m = pathname.match(/^\/api\/admin\/lectures\/(\d+)$/))) {
        const id = Number(m[1]);
        const existing = db.prepare('SELECT * FROM lectures WHERE id=?').get(id);
        if (!existing) throw new HttpError(404, '강의를 찾을 수 없습니다.');
        if (method === 'PUT') {
          const body = await readJson(req);
          const v = validateLecture(body, existing);
          let thumb = { buf: existing.thumbnail, mime: existing.thumb_mime };
          if (body.removeThumbnail) thumb = { buf: null, mime: null };
          if (body.thumbnail) thumb = decodeThumbnail(body.thumbnail);
          db.prepare(`UPDATE lectures SET title=?, video_url=?, instructor=?, category_id=?, description=?, thumbnail=?, thumb_mime=?,
            is_public=?, updated_at=? WHERE id=?`)
            .run(v.title, v.videoUrl, v.instructor, v.categoryId, v.description, thumb.buf, thumb.mime,
              v.isPublic ? 1 : 0, new Date().toISOString(), id);
          return sendJson(res, 200, toLecture(getLecture(id)));
        }
        if (method === 'DELETE') {
          db.prepare('DELETE FROM lectures WHERE id=?').run(id);
          return sendJson(res, 200, { ok: true });
        }
      }
      if (method === 'POST' && pathname === '/api/admin/categories') {
        const body = await readJson(req);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) throw new HttpError(400, '카테고리 이름을 입력해 주세요.');
        if (name.length > 30) throw new HttpError(400, '카테고리 이름은 30자 이하로 입력해 주세요.');
        if (db.prepare('SELECT 1 FROM categories WHERE name=?').get(name)) throw new HttpError(409, '이미 있는 카테고리입니다.');
        const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM categories').get().m;
        const r = db.prepare('INSERT INTO categories (name, sort_order) VALUES (?, ?)').run(name, max + 1);
        return sendJson(res, 201, { id: Number(r.lastInsertRowid), name, count: 0 });
      }
      if (method === 'DELETE' && (m = pathname.match(/^\/api\/admin\/categories\/(\d+)$/))) {
        const id = Number(m[1]);
        if (db.prepare('SELECT 1 FROM lectures WHERE category_id=?').get(id)) {
          throw new HttpError(409, '이 카테고리에 속한 강의가 있어 삭제할 수 없습니다. 강의를 먼저 다른 카테고리로 옮겨 주세요.');
        }
        db.prepare('DELETE FROM categories WHERE id=?').run(id);
        return sendJson(res, 200, { ok: true });
      }
    }
    throw new HttpError(404, '존재하지 않는 API입니다.');
  }

  function serveStatic(req, res, url) {
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    if (p === '/admin') p = '/admin.html';
    const file = path.normalize(path.join(PUBLIC_DIR, p));
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new HttpError(404, '페이지를 찾을 수 없습니다.');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        // 브라우저가 보낸 쓰기 요청은 같은 사이트에서 온 것만 허용 (CSRF 이중 방어)
        const origin = req.headers.origin;
        if (req.method !== 'GET' && origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, '허용되지 않은 요청입니다.');
        await handleApi(req, res, url);
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        serveStatic(req, res, url);
      } else {
        throw new HttpError(405, '허용되지 않은 요청입니다.');
      }
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      if (res.headersSent) return res.end();
      if (req.url.startsWith('/api/')) sendJson(res, status, { error: status === 500 ? '서버 오류가 발생했습니다.' : e.message });
      else { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(e.message); }
    }
  });
  server.on('close', () => db.close());
  return server;
}

module.exports = { createServer };

if (require.main === module) {
  loadEnvFile(path.join(__dirname, '.env'));
  const port = Number(process.env.PORT) || 3000;
  try {
    createServer().listen(port, () => console.log(`Planet Live 실행 중: http://localhost:${port}  (관리자: /admin)`));
  } catch (e) {
    console.error('\n[시작 실패] ' + e.message + '\n.env 파일에 ADMIN_PASSWORD=원하는비밀번호 를 입력해 주세요. (.env.example 참고)\n');
    process.exit(1);
  }
}

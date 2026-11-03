'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../server');

let server, base, cookie, tmp;
// 1x1 PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const J = { 'Content-Type': 'application/json' };

async function call(method, url, body, withCookie = false) {
  const headers = { ...(body !== undefined ? J : {}), ...(withCookie ? { Cookie: cookie } : {}) };
  const r = await fetch(base + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, headers: r.headers };
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-'));
  server = createServer({ adminPassword: 'test-pass-1234', dbPath: path.join(tmp, 't.db') });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.close(); });

test('시드: 기본 카테고리 4개, 샘플 강의 6개(샘플 표시)', async () => {
  const cats = await call('GET', '/api/categories');
  assert.deepEqual(cats.data.map((c) => c.name), ['AI · 업무 생산성', '마케팅 · 세일즈', '데이터 · 분석', 'IT · 디지털']);
  const l = await call('GET', '/api/lectures');
  assert.equal(l.data.length, 6);
  assert.ok(l.data.every((x) => x.isSample && x.title.startsWith('[샘플]')));
  assert.ok(l.data[0].createdAt >= l.data[5].createdAt, '최신순');
});

test('권한: 로그인 없이 쓰기/관리자 API는 모두 401', async () => {
  for (const [m, u, b] of [
    ['GET', '/api/admin/lectures'], ['POST', '/api/admin/lectures', { title: 'x' }],
    ['PUT', '/api/admin/lectures/1', { title: 'x' }], ['DELETE', '/api/admin/lectures/1'],
    ['POST', '/api/admin/categories', { name: 'x' }], ['DELETE', '/api/admin/categories/1'],
  ]) {
    assert.equal((await call(m, u, b)).status, 401, `${m} ${u}`);
  }
  // 위조 쿠키
  const forged = await fetch(base + '/api/admin/lectures', { headers: { Cookie: 'pl_admin=9999999999999.AAAA' } });
  assert.equal(forged.status, 401);
  assert.equal((await call('GET', '/api/lectures')).data.length, 6, '데이터 변경 없음');
});

test('로그인: 틀린 비밀번호 거부, 올바른 비밀번호는 HttpOnly 쿠키 발급', async () => {
  assert.equal((await call('POST', '/api/admin/login', { password: 'wrong' })).status, 401);
  const ok = await call('POST', '/api/admin/login', { password: 'test-pass-1234' });
  assert.equal(ok.status, 200);
  const sc = ok.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
  cookie = sc.split(';')[0];
  assert.equal((await call('GET', '/api/admin/me', undefined, true)).data.admin, true);
});

test('프런트엔드 파일에 비밀번호가 노출되지 않음', () => {
  for (const f of fs.readdirSync(path.join(__dirname, '../public'))) {
    assert.ok(!fs.readFileSync(path.join(__dirname, '../public', f), 'utf8').includes('test-pass-1234'));
  }
});

let newId;
test('등록: 필수값 검증, 자동 등록일, 썸네일 저장', async () => {
  assert.equal((await call('POST', '/api/admin/lectures', { title: '', videoUrl: 'https://a.com', instructor: 'a', categoryId: 1 }, true)).status, 400);
  assert.equal((await call('POST', '/api/admin/lectures', { title: 't', videoUrl: 'javascript:alert(1)', instructor: 'a', categoryId: 1 }, true)).status, 400);
  assert.equal((await call('POST', '/api/admin/lectures', { title: 't', videoUrl: 'https://a.com', instructor: '', categoryId: 1 }, true)).status, 400);
  assert.equal((await call('POST', '/api/admin/lectures', { title: 't', videoUrl: 'https://a.com', instructor: 'a', categoryId: 999 }, true)).status, 400);
  assert.equal((await call('POST', '/api/admin/lectures', { title: 't', videoUrl: 'https://a.com', instructor: 'a', categoryId: 1, thumbnail: 'data:image/png;base64,AAAA' }, true)).status, 400, '가짜 이미지 거부');
  const r = await call('POST', '/api/admin/lectures', { title: '신규 강의 %_', videoUrl: 'https://example.com/v/1', instructor: '김강사', categoryId: 2, description: '소개', thumbnail: PNG }, true);
  assert.equal(r.status, 201);
  newId = r.data.id;
  assert.ok(Math.abs(Date.now() - Date.parse(r.data.createdAt)) < 5000);
  assert.ok(r.data.thumbnailUrl);
  const img = await fetch(base + r.data.thumbnailUrl);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal((await call('GET', '/api/lectures')).data[0].id, newId, '최신 등록이 맨 앞');
});

test('검색(제목/강사명, 특수문자 안전)과 카테고리 필터', async () => {
  assert.equal((await call('GET', '/api/lectures?q=' + encodeURIComponent('신규'))).data.length, 1);
  assert.equal((await call('GET', '/api/lectures?q=' + encodeURIComponent('김강사'))).data.length, 1);
  assert.equal((await call('GET', '/api/lectures?q=' + encodeURIComponent('%'))).data.length, 1, '% 는 문자로만 취급');
  assert.equal((await call('GET', '/api/lectures?q=' + encodeURIComponent('샘플 강사 C'))).data.length, 1);
  assert.equal((await call('GET', '/api/lectures?q=없는검색어')).data.length, 0);
  const cat2 = (await call('GET', '/api/lectures?category=2')).data;
  assert.ok(cat2.length >= 3 && cat2.every((x) => x.categoryId === 2));
});

test('수정 및 공개/비공개 처리', async () => {
  const u = await call('PUT', `/api/admin/lectures/${newId}`, { title: '수정된 제목' }, true);
  assert.equal(u.data.title, '수정된 제목');
  assert.equal(u.data.instructor, '김강사', '부분 수정 시 다른 값 유지');
  assert.ok(u.data.thumbnailUrl, '썸네일 유지');
  assert.equal((await call('PUT', `/api/admin/lectures/${newId}`, { title: '  ' }, true)).status, 400);
  await call('PUT', `/api/admin/lectures/${newId}`, { isPublic: false }, true);
  assert.ok(!(await call('GET', '/api/lectures')).data.some((x) => x.id === newId), '비공개는 목록에서 제외');
  assert.equal((await fetch(base + `/api/lectures/${newId}/thumbnail`)).status, 404, '비공개 썸네일도 차단');
  assert.equal((await fetch(base + `/api/lectures/${newId}/thumbnail`, { headers: { Cookie: cookie } })).status, 200);
  assert.ok((await call('GET', '/api/admin/lectures', undefined, true)).data.some((x) => x.id === newId), '관리자는 비공개도 확인');
  assert.equal((await call('GET', '/api/categories')).data.find((c) => c.id === 2).count, 2);
  await call('PUT', `/api/admin/lectures/${newId}`, { isPublic: true }, true);
  assert.ok((await call('GET', '/api/lectures')).data.some((x) => x.id === newId));
});

test('카테고리 추가/중복/삭제 제한', async () => {
  const c = await call('POST', '/api/admin/categories', { name: '리더십' }, true);
  assert.equal(c.status, 201);
  assert.equal((await call('POST', '/api/admin/categories', { name: '리더십' }, true)).status, 409);
  assert.equal((await call('POST', '/api/admin/categories', { name: ' ' }, true)).status, 400);
  assert.equal((await call('DELETE', '/api/admin/categories/1', undefined, true)).status, 409, '강의가 있으면 삭제 불가');
  assert.equal((await call('DELETE', `/api/admin/categories/${c.data.id}`, undefined, true)).status, 200);
});

test('삭제 및 로그아웃', async () => {
  assert.equal((await call('DELETE', `/api/admin/lectures/${newId}`, undefined, true)).status, 200);
  assert.ok(!(await call('GET', '/api/admin/lectures', undefined, true)).data.some((x) => x.id === newId));
  assert.equal((await call('DELETE', '/api/admin/lectures/99999', undefined, true)).status, 404);
});

test('교차 출처 쓰기 요청 차단 및 JSON 외 형식 거부', async () => {
  const r = await fetch(base + '/api/admin/lectures', { method: 'POST', headers: { ...J, Cookie: cookie, Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(r.status, 403);
  const t = await fetch(base + '/api/admin/categories', { method: 'POST', headers: { 'Content-Type': 'text/plain', Cookie: cookie }, body: '{}' });
  assert.equal(t.status, 415);
});

test('정적 파일 경로 이탈 차단', async () => {
  const r = await fetch(base + '/..%2fserver.js');
  assert.equal(r.status, 404);
});

test('로그인 5회 실패 후 잠금', async () => {
  let last;
  for (let i = 0; i < 7; i++) last = await call('POST', '/api/admin/login', { password: 'bad' + i });
  assert.equal(last.status, 429);
});

test('서버 재시작 후에도 데이터 유지, 샘플 재생성 없음', async () => {
  const p = path.join(tmp, 'persist.db');
  let s = createServer({ adminPassword: 'abcdefgh', dbPath: p });
  await new Promise((r) => s.listen(0, r));
  const b = `http://localhost:${s.address().port}`;
  const login = await fetch(b + '/api/admin/login', { method: 'POST', headers: J, body: JSON.stringify({ password: 'abcdefgh' }) });
  const ck = login.headers.get('set-cookie').split(';')[0];
  for (const l of (await (await fetch(b + '/api/lectures')).json())) await fetch(b + '/api/admin/lectures/' + l.id, { method: 'DELETE', headers: { Cookie: ck } });
  await fetch(b + '/api/admin/lectures', { method: 'POST', headers: { ...J, Cookie: ck }, body: JSON.stringify({ title: '유지', videoUrl: 'https://a.com', instructor: 'x', categoryId: 1 }) });
  await new Promise((r) => s.close(r));
  s = createServer({ adminPassword: 'abcdefgh', dbPath: p });
  await new Promise((r) => s.listen(0, r));
  const list = await (await fetch(`http://localhost:${s.address().port}/api/lectures`)).json();
  assert.deepEqual(list.map((x) => x.title), ['유지']);
  s.close();
});

test('ADMIN_PASSWORD 없으면 서버 시작 거부', () => {
  assert.throws(() => createServer({ adminPassword: '', dbPath: ':memory:' }), /ADMIN_PASSWORD/);
});

'use strict';
const $ = (s) => document.querySelector(s);
let lectures = [];
let categories = [];
let editingId = null;
let thumbData = null;      // 새로 선택한 썸네일(dataURL)
let thumbRemoved = false;  // 기존 썸네일 제거 여부

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const fmtDate = (iso) => { const d = new Date(iso); return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`; };

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

async function api(url, method = 'GET', body) {
  const opt = { method, headers: {} };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(url, opt);
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && !url.endsWith('/login')) { showLogin(); throw new Error('로그인이 만료되었습니다. 다시 로그인해 주세요.'); }
  if (!r.ok) throw new Error(data.error || '요청에 실패했습니다.');
  return data;
}

// ---------- 로그인 ----------
function showLogin() { $('#appView').classList.add('hidden'); $('#loginView').classList.remove('hidden'); $('#password').focus(); }
async function showApp() {
  $('#loginView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  await refresh();
}
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginErr').textContent = '';
  try {
    await api('/api/admin/login', 'POST', { password: $('#password').value });
    $('#password').value = '';
    await showApp();
  } catch (err) { $('#loginErr').textContent = err.message; }
});
$('#logoutBtn').addEventListener('click', async () => { await api('/api/admin/logout', 'POST', {}); showLogin(); });

// ---------- 목록 ----------
async function refresh() {
  [lectures, categories] = await Promise.all([api('/api/admin/lectures'), api('/api/categories')]);
  renderRows();
}

function renderRows() {
  $('#total').textContent = `${lectures.length}개`;
  $('#emptyRows').classList.toggle('hidden', lectures.length > 0);
  const rows = lectures.map((l) => {
    const tr = el('tr');
    const tdThumb = el('td');
    if (l.thumbnailUrl) { const img = el('img', 'mini'); img.src = l.thumbnailUrl; img.alt = ''; tdThumb.append(img); }
    else tdThumb.append(el('div', 'mini'));
    const tdTitle = el('td', 't');
    const a = el('a', '', l.title);
    a.href = l.videoUrl; a.target = '_blank'; a.rel = 'noopener noreferrer';
    tdTitle.append(a);
    if (l.isSample) tdTitle.append(el('span', 'pill', '샘플'));

    const tdPub = el('td', 'nowrap');
    tdPub.append(toggle(l.isPublic, `${l.title} 공개 여부`, (v) => patch(l, { isPublic: v })), el('span', 'state-label', l.isPublic ? '공개' : '비공개'));

    const tdAct = el('td');
    const box = el('div', 'row-actions');
    const edit = el('button', 'btn small', '수정'); edit.type = 'button';
    edit.addEventListener('click', () => openForm(l));
    const del = el('button', 'btn small danger', '삭제'); del.type = 'button';
    del.addEventListener('click', () => remove(l));
    box.append(edit, del); tdAct.append(box);

    tr.append(tdThumb, tdTitle, el('td', 'nowrap', l.instructor), el('td', 'nowrap', l.categoryName), tdPub, el('td', 'nowrap', fmtDate(l.createdAt)), tdAct);
    return tr;
  });
  $('#rows').replaceChildren(...rows);
}

function toggle(checked, label, onChange) {
  const w = el('label', 'switch');
  const i = el('input'); i.type = 'checkbox'; i.checked = checked; i.setAttribute('aria-label', label);
  i.addEventListener('change', () => onChange(i.checked));
  w.append(i, el('i'));
  return w;
}

async function patch(l, fields) {
  try { await api(`/api/admin/lectures/${l.id}`, 'PUT', fields); toast('변경되었습니다.'); }
  catch (e) { toast(e.message); }
  await refresh();
}

async function remove(l) {
  if (!confirm(`“${l.title}” 강의를 삭제할까요?\n삭제하면 되돌릴 수 없습니다.\n(잠시 숨기려면 삭제 대신 ‘공개’를 꺼 주세요.)`)) return;
  try { await api(`/api/admin/lectures/${l.id}`, 'DELETE'); toast('삭제되었습니다.'); await refresh(); }
  catch (e) { toast(e.message); }
}

// ---------- 등록/수정 폼 ----------
function fillCategories(selected) {
  const sel = $('#fCategory');
  sel.replaceChildren(el('option', '', '카테고리를 선택하세요'), ...categories.map((c) => { const o = el('option', '', c.name); o.value = c.id; return o; }));
  sel.firstChild.value = '';
  sel.value = selected ? String(selected) : '';
}

function setPreview(url) {
  $('#thumbPreview').classList.toggle('hidden', !url);
  if (url) $('#thumbImg').src = url;
}

function openForm(l) {
  editingId = l ? l.id : null;
  thumbData = null; thumbRemoved = false;
  $('#dialogTitle').textContent = l ? '강의 수정' : '강의 등록';
  $('#fTitle').value = l?.title ?? '';
  $('#fUrl').value = l?.videoUrl ?? '';
  $('#fInstructor').value = l?.instructor ?? '';
  $('#fDesc').value = l?.description ?? '';
  $('#fPublic').checked = l ? l.isPublic : true;
  $('#fThumb').value = '';
  $('#fNewCat').value = '';
  $('#formErr').textContent = '';
  $('#dateHint').textContent = l ? `등록일: ${fmtDate(l.createdAt)} (수정해도 바뀌지 않습니다)` : '등록일은 저장하는 시점으로 자동 입력됩니다.';
  fillCategories(l?.categoryId);
  setPreview(l?.thumbnailUrl ?? null);
  $('#lectureDialog').showModal();
}

// 업로드 이미지를 가로 1280px 이내 JPEG/PNG로 줄여 저장 용량을 낮춘다
function resizeImage(file) {
  return new Promise((resolve, reject) => {
    if (file.type === 'image/gif') {
      if (file.size > 1.5 * 1024 * 1024) return reject(new Error('GIF는 1.5MB 이하만 가능합니다. PNG/JPG를 사용해 주세요.'));
      const fr = new FileReader(); fr.onload = () => resolve(fr.result); fr.onerror = reject; return fr.readAsDataURL(file);
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1280 / img.width);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('이미지를 읽을 수 없습니다.')); };
    img.src = url;
  });
}

$('#fThumb').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  $('#formErr').textContent = '';
  try { thumbData = await resizeImage(f); thumbRemoved = false; setPreview(thumbData); }
  catch (err) { $('#formErr').textContent = err.message; e.target.value = ''; }
});
$('#thumbRemove').addEventListener('click', () => { thumbData = null; thumbRemoved = true; $('#fThumb').value = ''; setPreview(null); });

async function addCategory(name, errBox) {
  errBox.textContent = '';
  try {
    const c = await api('/api/admin/categories', 'POST', { name });
    categories.push(c);
    return c;
  } catch (e) { errBox.textContent = e.message; return null; }
}

$('#addCatInline').addEventListener('click', async () => {
  const name = $('#fNewCat').value.trim();
  if (!name) { $('#formErr').textContent = '추가할 카테고리 이름을 입력해 주세요.'; return; }
  const c = await addCategory(name, $('#formErr'));
  if (c) { fillCategories(c.id); $('#fNewCat').value = ''; toast('카테고리가 추가되었습니다.'); }
});

$('#cancelBtn').addEventListener('click', () => $('#lectureDialog').close());
$('#lectureForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#formErr').textContent = '';
  const body = {
    title: $('#fTitle').value, videoUrl: $('#fUrl').value, instructor: $('#fInstructor').value,
    categoryId: $('#fCategory').value, description: $('#fDesc').value,
    isPublic: $('#fPublic').checked,
  };
  if (thumbData) body.thumbnail = thumbData;
  if (thumbRemoved) body.removeThumbnail = true;
  $('#saveBtn').disabled = true;
  try {
    await api(editingId ? `/api/admin/lectures/${editingId}` : '/api/admin/lectures', editingId ? 'PUT' : 'POST', body);
    $('#lectureDialog').close();
    toast(editingId ? '수정되었습니다.' : '등록되었습니다.');
    await refresh();
  } catch (err) { $('#formErr').textContent = err.message; }
  finally { $('#saveBtn').disabled = false; }
});

// ---------- 카테고리 관리 ----------
function renderCats() {
  const counts = {};
  lectures.forEach((l) => { counts[l.categoryId] = (counts[l.categoryId] || 0) + 1; });
  $('#catList').replaceChildren(...categories.map((c) => {
    const li = el('li');
    const name = el('span', '', c.name);
    name.append(el('span', 'n', `강의 ${counts[c.id] || 0}개`));
    const del = el('button', 'btn small danger', '삭제'); del.type = 'button';
    del.addEventListener('click', async () => {
      if (!confirm(`카테고리 “${c.name}”을(를) 삭제할까요?`)) return;
      try { await api(`/api/admin/categories/${c.id}`, 'DELETE'); await refresh(); renderCats(); $('#catErr').textContent = ''; }
      catch (e) { $('#catErr').textContent = e.message; }
    });
    li.append(name, del);
    return li;
  }));
}
$('#catBtn').addEventListener('click', () => { $('#catErr').textContent = ''; renderCats(); $('#catDialog').showModal(); });
$('#catClose').addEventListener('click', () => $('#catDialog').close());
$('#catForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const c = await addCategory($('#catName').value.trim(), $('#catErr'));
  if (c) { $('#catName').value = ''; renderCats(); toast('카테고리가 추가되었습니다.'); }
});
$('#newBtn').addEventListener('click', () => openForm(null));

(async function init() {
  try { const me = await api('/api/admin/me'); me.admin ? await showApp() : showLogin(); }
  catch { showLogin(); }
})();

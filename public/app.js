'use strict';
const $ = (s) => document.querySelector(s);
const state = { q: '', category: 0, sort: 'latest' };
let categories = [];
let searchTimer;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text; // 사용자 입력은 항상 textContent로만 넣는다(XSS 방지)
  return e;
}

function fmtDate(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

function placeholder() {
  const ph = el('div', 'ph');
  ph.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  return ph;
}

function makeCard(l, badgeText) {
  const a = el('a', 'card');
  a.href = l.videoUrl;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  const thumb = el('div', 'thumb');
  if (l.thumbnailUrl) {
    const img = el('img');
    img.src = l.thumbnailUrl;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => { img.replaceWith(placeholder()); });
    thumb.append(img);
  } else {
    thumb.append(placeholder());
  }
  if (badgeText) thumb.append(el('span', 'badge', badgeText));
  if (l.isSample) thumb.append(el('span', 'badge sample', '샘플'));
  a.append(thumb, el('h3', '', l.title));
  const meta = el('p', 'meta');
  const who = el('b', '', l.instructor);
  meta.append(who, document.createTextNode(` · ${l.categoryName} · ${fmtDate(l.createdAt)}`));
  a.append(meta);
  return a;
}

async function get(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('불러오기 실패');
  return r.json();
}

function renderChips() {
  const box = $('#chips');
  box.replaceChildren();
  const total = categories.reduce((s, c) => s + c.count, 0);
  const mk = (id, name, n) => {
    const b = el('button', 'chip', name);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(state.category === id));
    b.append(el('span', 'n', String(n)));
    b.addEventListener('click', () => { state.category = id; renderChips(); loadLectures(); });
    box.append(b);
  };
  mk(0, '전체', total);
  categories.forEach((c) => mk(c.id, c.name, c.count));
}

async function loadLectures() {
  const params = new URLSearchParams({ sort: state.sort });
  if (state.q) params.set('q', state.q);
  if (state.category) params.set('category', state.category);
  let list;
  try { list = await get('/api/lectures?' + params); }
  catch { showEmpty('강의를 불러오지 못했습니다', '잠시 후 새로고침해 주세요.'); return; }

  const filtering = !!(state.q || state.category);
  $('#listTitle').firstChild.textContent = filtering ? '검색 결과' : '전체 강의';
  $('#count').textContent = list.length ? `${list.length}개` : '';
  $('#grid').replaceChildren(...list.map((l) => makeCard(l)));

  if (list.length) {
    $('#empty').classList.add('hidden');
  } else if (filtering) {
    showEmpty('조건에 맞는 강의가 없습니다', '다른 검색어를 입력하거나 카테고리를 변경해 보세요.');
  } else {
    showEmpty('아직 등록된 강의가 없습니다', '새로운 강의가 곧 등록될 예정입니다. 잠시 후 다시 확인해 주세요.');
  }
}

function showEmpty(title, text) {
  $('#grid').replaceChildren();
  $('#count').textContent = '';
  $('#emptyTitle').textContent = title;
  $('#emptyText').textContent = text;
  $('#empty').classList.remove('hidden');
}

$('#q').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.q = e.target.value.trim(); loadLectures(); }, 250);
});
$('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(searchTimer); state.q = $('#q').value.trim(); loadLectures(); });
$('#sort').addEventListener('change', (e) => { state.sort = e.target.value; loadLectures(); });

(async function init() {
  try { categories = await get('/api/categories'); } catch { categories = []; }
  renderChips();
  loadLectures();
})();

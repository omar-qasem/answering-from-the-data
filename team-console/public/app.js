/* Team console: polls /api/state, shows every post with its comments and the prepared replies, sends on "Reply now". */
(() => {
  'use strict';

  // ---------- helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ls = {
    get(k, d) {
      try {
        const v = localStorage.getItem('replies.' + k);
        return v === null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem('replies.' + k, JSON.stringify(v));
      } catch {}
    },
  };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtDay = (iso) => {
    if (!iso) return '';
    const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
    return `${d} ${MONTHS[m - 1]} ${y}`;
  };
  const ago = (iso) => {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
  };
  const daysOld = (iso, today) => Math.round((Date.parse(today) - Date.parse(iso)) / 86400000);
  const pct = (n, t) => (t ? Math.round((n / t) * 100) : 0);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  const ICON_CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>';

  // ---------- state ----------
  const S = {
    view: 'overview',
    state: null,
    version: null,
    health: null,
    data: null,
    filter: { status: ls.get('f.status', 'waiting'), post: 'all', lang: 'all' },
    search: '',
    editing: new Map(),
    openTrace: new Set(),
    busy: new Set(),
    seen: null,
    flash: new Set(),
    fallback: false,
    sound: ls.get('sound', false),
    error: null,
    lastOk: 0,
    skew: 0, // server clock minus this browser's clock
  };
  const srvNow = () => Date.now() + (S.skew || 0); // drafts and job beats carry server times
  // models that read text only (Groq's) get the caption alone
  const postReads = () => (S.health && S.health.ai && S.health.ai.enabled && !S.health.ai.vision ? 'reads the caption' : 'looks at the image and caption');

  // ---------- API ----------
  let passPrompt = null;
  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const pass = ls.get('passcode', '');
    if (pass) headers['X-Team-Passcode'] = pass;
    const res = await fetch(path, { method: opts.method || (opts.body ? 'POST' : 'GET'), headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    let data = null;
    try {
      data = await res.json();
    } catch {}
    if (res.status === 401 && data && data.passcode) {
      await askPasscode();
      return api(path, opts);
    }
    if (!res.ok) {
      const msg = res.status === 404 && !data ? 'the API functions are not deployed (404). Deploy with the Netlify CLI or from Git, as the README says' : (data && data.error) || `The server answered ${res.status}.`;
      const e = new Error(msg);
      e.data = data;
      e.status = res.status;
      throw e;
    }
    return data;
  }

  function askPasscode() {
    if (passPrompt) return passPrompt;
    passPrompt = new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'modal-wrap';
      wrap.innerHTML = `<form class="modal"><h3>Team passcode</h3><div class="note">This console is protected. Ask whoever set up the site for the passcode.</div><input type="password" autocomplete="current-password" placeholder="Passcode" required><div class="actions"><span class="spacer"></span><button class="btn" type="submit">Continue</button></div></form>`;
      document.body.appendChild(wrap);
      const input = $('input', wrap);
      input.focus();
      $('form', wrap).addEventListener('submit', (e) => {
        e.preventDefault();
        ls.set('passcode', input.value.trim());
        wrap.remove();
        passPrompt = null;
        resolve();
      });
    });
    return passPrompt;
  }

  let toastTimer = null;
  function toast(msg, err = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast show${err ? ' err' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = 'toast'), err ? 5200 : 2600);
  }

  // ---------- comment status ----------
  const STATUS = {
    waiting: { label: 'comments waiting', pill: '', short: 'Waiting' },
    ready: { label: 'drafts ready to send', pill: 'p-ready', short: 'Ready' },
    needs_choice: { label: 'drafts that need a choice', pill: 'p-choice', short: 'Needs a choice' },
    needs_human: { label: 'comments for a person', pill: 'p-human', short: 'Needs a person' },
    no_reply: { label: 'comments with no reply needed', pill: 'p-none', short: 'No reply needed' },
    drafting: { label: 'drafts in progress', pill: 'p-drafting', short: 'Drafting…' },
    failed: { label: 'failed drafts', pill: 'p-failed', short: 'Failed' },
    replied: { label: 'replied comments', pill: 'p-replied', short: 'Replied' },
    dismissed: { label: 'dismissed comments', pill: 'p-none', short: 'Dismissed' },
    all: { label: 'all comments', pill: '', short: 'All' },
  };
  const WAITING = new Set(['drafting', 'ready', 'needs_choice', 'needs_human', 'failed']);
  function statusOf(c) {
    if (c.reply && !c.reply.dismissed) return 'replied';
    if (c.reply && c.reply.dismissed) return 'dismissed';
    if (!c.draft) return 'drafting';
    return c.draft.status;
  }
  function matchesFilter(c, post) {
    const st = statusOf(c);
    const f = S.filter;
    if (f.status === 'waiting' && !WAITING.has(st)) return false;
    if (f.status !== 'waiting' && f.status !== 'all' && st !== f.status) return false;
    if (f.post !== 'all' && post.id !== f.post) return false;
    if (f.lang !== 'all') {
      const ar = /[؀-ۿ]/.test(c.text);
      if ((f.lang === 'ar') !== ar) return false;
    }
    if (S.search) {
      const q = S.search.toLowerCase();
      const hay = [c.text, c.author_name, c.author_handle, c.draft && c.draft.text, c.reply && c.reply.text].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }
  const allComments = () => (S.state ? S.state.posts.flatMap((p) => p.comments.map((c) => ({ c, p }))) : []);

  // ---------- links ----------
  function feedUrl() {
    return (ls.get('feedUrl', '') || (S.health && S.health.feed_url) || '').replace(/\/+$/, '');
  }
  function feedHref() {
    const f = feedUrl();
    return f ? `${f}/?api=${encodeURIComponent(location.origin)}` : '#setup';
  }

  // ---------- ribbon ----------
  function renderRibbon() {
    const r = $('#ribbon');
    const t = $('#ribbon-text');
    const h = S.health;
    r.className = 'ribbon';
    if (S.error && Date.now() - S.lastOk > 8000) {
      r.classList.add('bad');
      t.innerHTML = `Can't reach the backend: ${esc(S.error)} <a href="#health">See health ›</a>`;
      return;
    }
    if (!h) {
      t.textContent = 'Connecting…';
      return;
    }
    const age = h.data ? h.data.age_days : null;
    const queued = allComments().filter(({ c }) => c.beat && statusOf(c) === 'drafting').length;
    if (h.engine !== 'langgraph') {
      r.classList.add('warn');
      t.innerHTML = `LangGraph didn't load, so drafts run on the built-in runner (same steps). <a href="#health">See health ›</a>`;
    } else if (!h.ai.enabled && !(h.embeddings && h.embeddings.enabled)) {
      r.classList.add('warn');
      t.innerHTML = `AI is off, so drafts are built from rules and templates. Add <b>JINA_API_KEY</b> (search) or a chat model key in Netlify. <a href="#setup">See setup ›</a>`;
    } else if (!h.ai.enabled) {
      t.innerHTML = `All systems normal. Search uses ${esc(h.embeddings.provider_name)} vectors; drafts come from rules and templates (no chat model key). <a href="#setup">See setup ›</a>`;
    } else if (h.ai.provider === 'groq' && queued > 1) {
      t.innerHTML = `LangGraph is drafting with Groq (${esc(h.ai.model)}): ${queued} drafts in the queue, made one after another to stay within the free tier's 8,000 tokens a minute. <a href="#health">See health ›</a>`;
    } else if (age !== null && age > 30) {
      r.classList.add('warn');
      t.innerHTML = `All systems running. The visit data is ${age} days old (last visit ${esc(fmtDay(h.data.date_max))}). <a href="#data">Upload a newer file ›</a>`;
    } else {
      t.innerHTML = `All systems normal. LangGraph is drafting with ${esc(h.ai.provider_name || 'AI')} (${esc(h.ai.model)}). <a href="#health">See health ›</a>`;
    }
  }

  // ---------- views ----------
  const VIEWS = ['overview', 'posts', 'data', 'health', 'how', 'setup'];
  function route() {
    const v = (location.hash || '#overview').slice(1);
    S.view = VIEWS.includes(v) ? v : 'overview';
    $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === S.view));
    closeMenu();
    renderView(true);
    window.scrollTo({ top: 0 });
  }

  function renderView(full) {
    const app = $('#app');
    if (S.view === 'overview') return renderOverview(full);
    if (!full) {
      if (S.view === 'posts') return renderPosts();
      return;
    }
    if (S.view === 'posts') return renderPosts();
    if (S.view === 'data') return renderData();
    if (S.view === 'health') return renderHealth();
    if (S.view === 'how') return (app.innerHTML = howHtml());
    if (S.view === 'setup') return renderSetup();
  }

  // ---------- overview ----------
  function counts() {
    const n = { waiting: 0, ready: 0, needs_choice: 0, needs_human: 0, no_reply: 0, drafting: 0, failed: 0, replied: 0, dismissed: 0, edited: 0, total: 0 };
    for (const { c } of allComments()) {
      const st = statusOf(c);
      n.total++;
      n[st] = (n[st] || 0) + 1;
      if (WAITING.has(st)) n.waiting++;
      if (st === 'replied' && c.reply.edited) n.edited++;
    }
    return n;
  }

  function overviewShell() {
    return `<section class="view" data-view="overview">
      <div class="hero"><h1>Replies</h1>
        <div class="hero-side"><p class="tag">Every question. Every answer.<br>Straight from the shelf.</p>
          <a id="feed-link" href="${esc(feedHref())}" ${feedUrl() ? 'target="_blank" rel="noopener"' : ''}>Open the feed ↗</a>
          <a href="#health">Check system health ›</a></div></div>
      <div class="filter" id="filter"></div>
      <div class="filter-sub" id="filter-sub"></div>
      <div class="kpis-shell"><div class="kpis" id="kpis"></div><button class="kpi-next" id="kpi-next" aria-label="More">${ICON_CHEV}</button></div>
      <h2 class="sec" id="the-queue">The queue. <span>Every question under its post.</span></h2>
      <div id="queue"></div>
      <h2 class="sec" id="the-questions">The questions. <span>What customers ask, and where.</span></h2>
      <div class="grid g2" id="charts"></div>
    </section>`;
  }

  function renderOverview(full) {
    const app = $('#app');
    if (full || !$('[data-view="overview"]', app)) app.innerHTML = overviewShell();
    if (!S.state) {
      $('#queue').innerHTML = `<div class="card"><div class="skeleton" style="width:40%"></div><div class="skeleton"></div><div class="skeleton" style="width:70%"></div></div>`;
      return;
    }
    const n = counts();
    const f = S.filter;
    const postName = f.post === 'all' ? 'all posts' : `the ${postLabel(S.state.posts.find((p) => p.id === f.post))} post`;
    const langName = { all: 'any language', ar: 'Arabic', en: 'English' }[f.lang];
    $('#filter').innerHTML = `Showing <button class="pick" data-menu>${esc(STATUS[f.status].label)}</button>on <button class="pick" data-menu>${esc(postName)}</button>in <button class="pick last" data-menu>${esc(langName)}</button>.`;
    const shown = allComments().filter(({ c, p }) => matchesFilter(c, p)).length;
    $('#filter-sub').textContent = `${plural(shown, 'comment', 'comments')} shown. LangGraph prepares each reply from the latest shelf visits; nothing is sent until you click Reply now.`;
    const fl = $('#feed-link');
    if (fl) {
      fl.href = feedHref();
      if (feedUrl()) {
        fl.target = '_blank';
        fl.rel = 'noopener';
      }
    }
    const age = S.state.data ? daysOld(S.state.data.date_max, S.state.today) : null;
    const kpis = [
      ['waiting', n.waiting, 'Waiting', 'need you', 'c-black'],
      ['ready', n.ready, 'Ready', 'to send', 'c-blue'],
      ['needs_choice', n.needs_choice, 'Need a choice', 'which one?', 'c-amber'],
      ['needs_human', n.needs_human, 'Need a person', 'complaints and more', 'c-orange'],
      ['drafting', n.drafting + n.failed, 'In progress', n.failed ? `${n.failed} failed` : 'being drafted', n.failed ? 'c-red' : 'c-gray'],
      ['no_reply', n.no_reply, 'No reply needed', 'tags and chat', 'c-gray'],
      ['replied', n.replied, 'Replied', n.edited ? `${n.edited} edited first` : 'sent', 'c-green'],
      ['all', S.state.posts.length, 'Posts', `${n.total} comments`, 'c-black'],
      [null, age === null ? '—' : `${age} d`, 'Data age', S.state.data ? `last visit ${fmtDay(S.state.data.date_max)}` : 'no data', age !== null && age > 30 ? 'c-amber' : 'c-green'],
    ];
    $('#kpis').innerHTML = kpis
      .map(([key, num, l, s, cls]) => `<button class="kpi${key && key === f.status ? ' sel' : ''}" ${key ? `data-kpi="${key}"` : 'data-go="data"'}><div class="n ${cls}">${esc(num)}</div><div class="l">${esc(l)}</div><div class="s">${esc(s)}</div></button>`)
      .join('');
    renderQueue();
    renderCharts();
  }

  function baseLabel(p) {
    const prods = (p.ctx && p.ctx.products) || [];
    if (prods.length) return prods.map((x) => x.name).join(' + ');
    return (p.caption || 'untitled').split('\n')[0].slice(0, 28);
  }
  function postLabel(p) {
    if (!p) return '';
    const base = baseLabel(p);
    const twins = S.state ? S.state.posts.filter((x) => baseLabel(x) === base).length : 1;
    return twins > 1 ? `${base} · ${ago(p.created_at)}` : base;
  }

  // keyed rendering so typing in an edit box survives the 3-second refresh
  function renderQueue() {
    const q = $('#queue');
    if (!q) return;
    const posts = S.state.posts.filter((p) => S.filter.post === 'all' || p.id === S.filter.post);
    const visible = posts.map((p) => ({ p, list: p.comments.filter((c) => matchesFilter(c, p)) })).filter(({ p, list }) => list.length || (S.filter.status === 'all' && !S.search) || p.comments.length === 0 && S.filter.status === 'waiting' && !S.search);
    if (!visible.length) {
      q.innerHTML = `<div class="card"><h3>All clear.</h3><div class="sub">${S.filter.status === 'waiting' ? 'Every comment has been handled. New comments from the feed show up here within seconds.' : 'Nothing matches this filter.'}</div></div>`;
      return;
    }
    const empty = q.querySelector(':scope > .card');
    if (empty) empty.remove();
    const keep = new Set();
    let prev = null;
    for (const { p, list } of visible) {
      keep.add(p.id);
      let el = q.querySelector(`:scope > [data-post="${CSS.escape(p.id)}"]`);
      if (!el) {
        el = document.createElement('article');
        el.className = 'post';
        el.dataset.post = p.id;
        el.innerHTML = `<div class="post-head"></div><div class="cmts"></div>`;
      }
      const headSig = JSON.stringify([p.caption, p.image, p.ctx, p.comments.length, p.comments.map(statusOf)]);
      if (el.dataset.sig !== headSig) {
        el.querySelector('.post-head').innerHTML = postHeadHtml(p);
        el.dataset.sig = headSig;
      }
      const box = el.querySelector('.cmts');
      const keepC = new Set();
      let prevC = null;
      for (const c of list) {
        keepC.add(c.id);
        let ce = box.querySelector(`:scope > [data-c="${CSS.escape(c.id)}"]`);
        const fresh = !ce;
        if (!ce) {
          ce = document.createElement('div');
          ce.className = 'cmt';
          ce.dataset.c = c.id;
        }
        const editing = S.editing.has(c.id);
        const sig = JSON.stringify([c, S.busy.has(c.id), S.openTrace.has(c.id), editing, Math.floor(Date.now() / 30000)]);
        if (ce.dataset.sig !== sig && !(editing && ce.querySelector('textarea'))) {
          ce.innerHTML = commentHtml(c, p);
          ce.dataset.sig = sig;
          if (editing) {
            const ta = ce.querySelector('textarea');
            if (ta) ta.value = S.editing.get(c.id);
          }
        }
        if (fresh && S.flash.has(c.id)) {
          ce.classList.add('new-flash');
          S.flash.delete(c.id);
        }
        const want = prevC ? prevC.nextSibling : box.firstChild;
        if (want !== ce) box.insertBefore(ce, want);
        prevC = ce;
      }
      $$(':scope > [data-c]', box).forEach((ce) => !keepC.has(ce.dataset.c) && !S.editing.has(ce.dataset.c) && ce.remove());
      if (!list.length && !box.children.length) box.innerHTML = `<div class="empty">No comments match on this post.</div>`;
      else $$(':scope > .empty', box).forEach((e) => e.remove());
      const want = prev ? prev.nextSibling : q.firstChild;
      if (want !== el) q.insertBefore(el, want);
      prev = el;
    }
    $$(':scope > [data-post]', q).forEach((el) => !keep.has(el.dataset.post) && el.remove());
  }

  function srcLabel(s) {
    return { ai: 'seen by AI', openai: 'seen by AI', rules: 'from the caption', team: 'set by the team', seed: 'demo' }[s] || s;
  }

  function postHeadHtml(p) {
    const ctx = p.ctx;
    const prods = (ctx && ctx.products) || [];
    const replied = p.comments.filter((c) => statusOf(c) === 'replied').length;
    const waiting = p.comments.filter((c) => WAITING.has(statusOf(c))).length;
    let products;
    if (!ctx || ctx.status === 'pending') products = `<span class="pill p-drafting">Finding the products in this post…</span>`;
    else if (ctx.status === 'failed') products = `<span class="pill p-failed">Post analysis failed</span> <a href="#posts">Set the products ›</a>`;
    else if (!prods.length) products = `<span class="pill p-human">No catalog product found</span> <a href="#posts">Set the products ›</a>`;
    else products = prods.map((x) => `<span class="chip"><span>${esc(x.name)}${x.pack ? ` · ${esc(x.pack)}` : ''}</span><span class="src">${esc(srcLabel(x.source))}</span></span>`).join('') + ` <a href="#posts" style="font-size:14px">Edit</a>`;
    return `<img src="${esc(p.image)}" alt="" loading="lazy">
      <div><div class="post-cap" dir="auto">${esc(p.caption)}</div>
        <div class="post-meta">Posted ${esc(ago(p.created_at))} · ${plural(p.comments.length, 'comment', 'comments')}</div>
        <div class="post-products">${products}</div></div>
      <div class="post-stats"><b>${waiting}</b>waiting<br>${replied} replied</div>`;
  }

  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/);
    if (/[\u0600-\u06ff]/.test(parts[0] || '')) return esc((parts[0] || '?').charAt(0)); // one letter reads better in Arabic
    return esc((parts[0] || '?').charAt(0) + (parts[1] ? parts[1].charAt(0) : ''));
  }
  function personaColor(id) {
    const per = S.state && S.state.personas.find((x) => x.id === id);
    return per ? per.color : '#8e8e93';
  }

  function basisHtml(d) {
    if (!d.basis || !d.basis.length) return '';
    const seen = new Map();
    for (const b of d.basis) {
      const k = `${b.store_id}|${b.role}|${b.product}`;
      if (!seen.has(k)) seen.set(k, { ...b, packs: [] });
      seen.get(k).packs.push(b);
    }
    const ST = { in_stock: 'In stock', low_stock: 'Low stock', out_of_stock: 'Out of stock' };
    const today = (S.state && S.state.today) || new Date().toISOString().slice(0, 10);
    const oldest = Math.max(...d.basis.map((b) => daysOld(b.date, today)));
    const multiProduct = new Set(d.basis.map((b) => b.product)).size > 1;
    const items = [...seen.values()]
      .map((b) => {
        const packs = b.packs.map((x) => `<span class="st ${x.status}">${ST[x.status]}${x.qty !== null && x.qty !== undefined ? ` (${x.qty})` : ''}</span>${b.packs.length > 1 ? ` ${esc(x.pack)}` : ''}${x.price !== null && x.price !== undefined ? ` · JOD ${Number(x.price).toFixed(2)}` : ''}`).join(' · ');
        return `<li><b>${esc(b.store_name)}</b><span style="color:var(--muted)">${esc(b.area)}, ${esc(b.city)}</span>${multiProduct ? `<span class="badge">${esc(b.product)}</span>` : ''}${packs} <span style="color:var(--muted)">· visited ${esc(fmtDay(b.date))}${b.role === 'out_in_requested' ? ' · not used in the reply' : ''}</span></li>`;
      })
      .join('');
    return `<div class="basis"><h6>Based on these shelf visits</h6><ul>${items}</ul>
      ${d.scope_note ? `<div class="scope">${esc(d.scope_note)}</div>` : ''}
      ${oldest > 30 ? `<div class="stale">The oldest visit used here is ${oldest} days old.</div>` : ''}</div>`;
  }

  function traceHtml(d) {
    const isAi = (v) => v === 'ai' || v === 'openai';
    const u = isAi(d.understood_by) ? `the AI model${d.model ? ` (${d.model})` : ''}` : 'rules';
    const w = isAi(d.written_by) ? 'the AI model' : d.written_by === 'template' ? 'a template' : 'nobody';
    return `<div class="trace"><div>Read by ${u}${d.reason ? ` — “${esc(d.reason)}”` : ''}. Written by ${w}. Engine: ${esc(d.engine || '?')}${d.model ? ` · ${esc(d.model)}` : ''} · ${d.ms} ms.</div>
      <ol>${(d.trace || []).map((t) => `<li><code>${esc(t.node)}</code> ${esc(t.note || '')} <span>(${t.ms} ms)</span></li>`).join('')}</ol>
      ${d.notes && d.notes.length ? `<div>${d.notes.map((x) => esc(x)).join('<br>')}</div>` : ''}
      ${d.checks && d.checks.length ? `<div style="color:var(--amber)">Fact check: ${d.checks.map((x) => esc(x)).join(' ')}</div>` : ''}</div>`;
  }

  function commentHtml(c, p) {
    const st = statusOf(c);
    const d = c.draft;
    const busy = S.busy.has(c.id);
    const editing = S.editing.has(c.id);
    const head = `<div class="avatar" style="background:${esc(personaColor(c.persona_id))}">${initials(c.author_name)}</div>`;
    const top = `<div class="cmt-top"><div class="who"><b dir="auto">${esc(c.author_name)}</b> <span>@${esc(c.author_handle)} · ${esc(ago(c.created_at))}</span></div><span class="pill ${STATUS[st].pill}">${esc(STATUS[st].short)}</span></div>
      <div class="cmt-text" dir="auto">${esc(c.text)}</div>`;
    let body = '';
    const ids = `data-c="${esc(c.id)}" data-p="${esc(p.id)}"`;
    if (st === 'replied') {
      body = `<div class="draft sent"><div class="draft-top"><span>Replied ${esc(ago(c.reply.at))}${c.reply.edited ? ' · edited before sending' : ''}${c.reply.by === 'seed' ? ' · demo history' : ''}</span><button class="linkish" data-act="undo" ${ids}>Undo</button></div><div class="draft-text" dir="auto">${esc(c.reply.text)}</div></div>`;
    } else if (st === 'dismissed') {
      body = `<div class="draft"><div class="draft-top"><span>Dismissed ${esc(ago(c.reply.at))}. Nothing was posted.</span><button class="linkish" data-act="undo" ${ids}>Bring back</button></div></div>`;
    } else if (st === 'drafting' || !d) {
      const b = c.beat;
      const now = srvNow();
      const since = d && d.started_at ? Math.round((now - Date.parse(d.started_at)) / 1000) : 0;
      const line = b && b.state === 'queued' ? `Waiting its turn · ${b.pos} of ${b.of} in the queue` : `LangGraph is preparing a reply${since > 3 && !b ? ` · ${since}s` : ''}…`;
      const left = b && b.wait ? Math.round((Date.parse(b.wait.until) - now) / 1000) : 0;
      const wait = left > 0 && b.state === 'running' ? ` · waiting out the ${esc(b.wait.why)}, about ${left} s` : '';
      body = `<div class="draft"><div class="draft-top"><span>${line}${wait}</span></div><div class="skeleton" style="width:85%"></div><div class="skeleton" style="width:60%"></div></div>`;
    } else if (st === 'failed') {
      body = `<div class="draft human"><div class="draft-top"><span style="color:var(--red)">Drafting failed: ${esc(d.error || 'unknown error')}</span></div><div class="actions"><button class="btn sm" data-act="redraft" ${ids} ${busy ? 'disabled' : ''}>Try again</button></div></div>`;
    } else {
      const label = { ready: 'Suggested reply', needs_choice: 'Suggested reply · asks the customer which one', needs_human: 'Holding reply · a person should follow up', no_reply: 'No reply needed' }[st] || 'Suggested reply';
      const by = d.written_by === 'ai' || d.written_by === 'openai' ? `LangGraph · ${esc(d.model || 'AI')}` : d.written_by === 'template' ? 'LangGraph · template' : 'LangGraph';
      const text = st === 'no_reply' && !editing ? `<div class="draft-text" style="color:var(--muted)">${esc(d.reason || 'Nothing to answer.')}</div>` : editing ? `<textarea data-edit="${esc(c.id)}" dir="auto" aria-label="Edit the reply"></textarea>` : `<div class="draft-text" dir="auto">${esc(d.text)}</div>`;
      const choices =
        d.options && d.options.items.length && !editing
          ? `<div class="choices"><span class="q">${d.options.slot === 'product' ? 'Which product did they mean?' : 'Which place did they mean?'}</span>${d.options.items.map((o) => `<button class="choice" data-act="choose" data-slot="${esc(d.options.slot)}" data-id="${esc(o.id)}" ${ids} ${busy ? 'disabled' : ''}>${esc(o.label)}</button>`).join('')}</div>`
          : '';
      const canSend = editing || (st !== 'no_reply' && d.text);
      body = `<div class="draft${st === 'needs_human' ? ' human' : ''}"><div class="draft-top"><span>${esc(label)}</span><span class="badge">${by}</span></div>${text}${choices}${st !== 'no_reply' ? basisHtml(d) : ''}
        <div class="actions">
          ${canSend ? `<button class="btn" data-act="send" ${ids} ${busy ? 'disabled' : ''}>${busy ? 'Sending…' : 'Reply now'}</button>` : ''}
          ${editing ? `<button class="btn ghost" data-act="cancel" ${ids}>Cancel</button>` : st === 'no_reply' ? `<button class="btn ghost" data-act="write" ${ids}>Write a reply</button>` : `<button class="btn ghost" data-act="edit" ${ids}>Edit</button>`}
          <button class="btn ghost" data-act="redraft" ${ids} ${busy ? 'disabled' : ''}>Redraft</button>
          <button class="btn danger" data-act="dismiss" ${ids} ${busy ? 'disabled' : ''}>Dismiss</button>
          <span class="spacer"></span>
          <button class="linkish" data-act="trace" ${ids} style="font-size:14px">${S.openTrace.has(c.id) ? 'Hide how it was made' : 'How this draft was made ›'}</button>
        </div>${S.openTrace.has(c.id) ? traceHtml(d) : ''}</div>`;
    }
    return `${head}<div>${top}${body}</div>`;
  }

  function bars(rows, color = '') {
    const total = rows.reduce((s, r) => s + r[1], 0);
    const max = Math.max(1, ...rows.map((r) => r[1]));
    if (!total) return `<div class="empty">Nothing yet.</div>`;
    return `<div class="bars">${rows.map(([l, v, c]) => `<div class="lab" dir="auto" title="${esc(l)}">${esc(l)}</div><div class="track"><div class="bar ${c || color}" style="width:${Math.max(1, (v / max) * 82)}%"></div><span class="val">${v} · ${pct(v, total)}%</span></div>`).join('')}</div>`;
  }

  function renderCharts() {
    const ch = $('#charts');
    if (!ch) return;
    const intents = { availability: 0, price: 0, praise: 0, complaint: 0, other_question: 0, tag_or_chat: 0, spam: 0 };
    const places = new Map();
    const products = new Map();
    for (const { c } of allComments()) {
      const d = c.draft;
      if (!d || !d.intent) continue;
      intents[d.intent] = (intents[d.intent] || 0) + 1;
      if (d.place) places.set(d.place.name, (places.get(d.place.name) || 0) + 1);
      for (const pr of d.products || []) products.set(pr.name, (products.get(pr.name) || 0) + 1);
    }
    const IL = { availability: ['Where to buy', ''], price: ['Price', ''], praise: ['Praise', 'green'], complaint: ['Complaint', 'orange'], other_question: ['Other question', 'amber'], tag_or_chat: ['Tags and chat', 'gray'], spam: ['Spam', 'gray'] };
    const intentRows = Object.entries(intents).filter(([, v]) => v).sort((a, b) => b[1] - a[1]).map(([k, v]) => [IL[k][0], v, IL[k][1]]);
    const placeRows = [...places.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => [k, v]);
    const prodRows = [...products.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => [k, v]);
    ch.innerHTML = `<div class="card"><h3>What customers ask</h3><div class="sub">Every comment, read once by the graph.</div>${bars(intentRows)}</div>
      <div class="card"><h3>Where they ask about</h3><div class="sub">The place each question was matched to.</div>${bars(placeRows)}</div>
      <div class="card"><h3>Which products</h3><div class="sub">The product each question was matched to.</div>${bars(prodRows)}</div>
      <div class="card"><h3>How replies were made</h3><div class="sub">Who wrote the drafts.</div>${bars(writtenRows())}</div>`;
  }
  function writtenRows() {
    const m = { 'AI, fact-checked': 0, Template: 0, 'No reply': 0 };
    for (const { c } of allComments()) {
      const d = c.draft;
      if (!d || d.status === 'drafting') continue;
      if (d.written_by === 'ai' || d.written_by === 'openai') m['AI, fact-checked']++;
      else if (d.written_by === 'template') m.Template++;
      else m['No reply']++;
    }
    return [['AI, fact-checked', m['AI, fact-checked'], ''], ['Template', m.Template, 'amber'], ['No reply', m['No reply'], 'gray']];
  }

  // ---------- filter menu (same pattern as the Part 1 mega menu) ----------
  function openMenu() {
    closeMenu();
    const posts = S.state ? S.state.posts : [];
    const f = S.filter;
    const opt = (kind, val, label) => `<a href="#" data-set="${kind}" data-val="${esc(val)}" class="${f[kind] === val ? 'sel' : ''}" dir="auto">${esc(label)}</a>`;
    const mega = document.createElement('div');
    mega.className = 'mega';
    mega.innerHTML = `<div class="mega-inner">
      <div class="big"><h6>Explore Overview</h6><a href="#" data-jump="the-queue">The queue</a><a href="#" data-jump="the-questions">The questions</a><a href="#posts">The posts</a><a href="#data">The data</a></div>
      <div class="small"><h6>Comments</h6>${['waiting', 'ready', 'needs_choice', 'needs_human', 'no_reply', 'replied', 'all'].map((k) => opt('status', k, STATUS[k].short === 'Waiting' ? 'Waiting for you' : STATUS[k].short === 'All' ? 'Everything' : STATUS[k].short)).join('')}</div>
      <div class="small"><h6>Post</h6>${opt('post', 'all', 'All posts')}${posts.map((p) => opt('post', p.id, postLabel(p))).join('')}</div>
      <div class="small"><h6>Language</h6>${opt('lang', 'all', 'Any language')}${opt('lang', 'ar', 'Arabic')}${opt('lang', 'en', 'English')}</div></div>`;
    const back = document.createElement('div');
    back.className = 'backdrop';
    back.addEventListener('click', closeMenu);
    document.body.appendChild(back);
    document.body.appendChild(mega);
    mega.addEventListener('click', (e) => {
      const a = e.target.closest('a');
      if (!a) return;
      if (a.dataset.set) {
        e.preventDefault();
        S.filter[a.dataset.set] = a.dataset.val;
        if (a.dataset.set === 'status') ls.set('f.status', a.dataset.val);
        closeMenu();
        renderOverview(false);
      } else if (a.dataset.jump) {
        e.preventDefault();
        closeMenu();
        document.getElementById(a.dataset.jump)?.scrollIntoView({ behavior: 'smooth' });
      } else closeMenu();
    });
  }
  function closeMenu() {
    $$('.mega, .backdrop').forEach((x) => x.remove());
  }

  // ---------- actions ----------
  function findComment(id) {
    for (const p of (S.state && S.state.posts) || []) for (const c of p.comments) if (c.id === id) return { c, p };
    return null;
  }

  async function act(btn) {
    const a = btn.dataset.act;
    const cid = btn.dataset.c;
    const pid = btn.dataset.p;
    const found = cid ? findComment(cid) : null;
    if (a === 'edit' || a === 'write') {
      S.editing.set(cid, a === 'write' ? '' : (found && found.c.draft && found.c.draft.text) || '');
      renderQueue();
      const ta = $(`textarea[data-edit="${CSS.escape(cid)}"]`);
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
      return;
    }
    if (a === 'cancel') {
      S.editing.delete(cid);
      renderQueue();
      return;
    }
    if (a === 'trace') {
      S.openTrace.has(cid) ? S.openTrace.delete(cid) : S.openTrace.add(cid);
      renderQueue();
      return;
    }
    S.busy.add(cid);
    renderQueue();
    try {
      if (a === 'send') {
        const text = S.editing.has(cid) ? S.editing.get(cid) : (found && found.c.draft && found.c.draft.text) || '';
        if (!text.trim()) throw new Error('The reply is empty.');
        await api('/api/reply', { body: { post_id: pid, comment_id: cid, action: 'send', text } });
        S.editing.delete(cid);
        toast('Reply posted. It shows on the feed now.');
      } else if (a === 'dismiss') {
        await api('/api/reply', { body: { post_id: pid, comment_id: cid, action: 'dismiss' } });
        S.editing.delete(cid);
        toast('Dismissed. Nothing was posted.');
      } else if (a === 'undo') {
        await api('/api/reply', { body: { post_id: pid, comment_id: cid, action: 'undo' } });
        toast('Back in the queue. (A reply already seen on the feed is removed there too.)');
      } else if (a === 'redraft') {
        S.editing.delete(cid);
        toast('Redrafting…');
        await api('/api/draft', { body: { post_id: pid, comment_id: cid } });
        toast('New draft ready.');
      } else if (a === 'choose') {
        toast('Redrafting with your choice…');
        await api('/api/draft', { body: { post_id: pid, comment_id: cid, choice: { slot: btn.dataset.slot, id: btn.dataset.id } } });
        toast('Draft updated.');
      }
    } catch (e) {
      toast(e.message, true);
    } finally {
      S.busy.delete(cid);
      await refresh(true);
    }
  }

  // ---------- posts view ----------
  async function ensureData() {
    if (!S.data) S.data = await api('/api/data');
    return S.data;
  }
  function renderPosts() {
    const app = $('#app');
    if (!S.state) {
      app.innerHTML = `<section class="view"><h2 class="sec">The posts. <span>Loading…</span></h2></section>`;
      return;
    }
    if ($('[data-view="posts"] select:focus')) return;
    const products = (S.data && S.data.products) || [];
    const rows = S.state.posts
      .map((p) => {
        const ctx = p.ctx || {};
        const prods = ctx.products || [];
        const analysis = ctx.status === 'pending' ? 'Analysing…' : ctx.status === 'failed' ? `Failed: ${ctx.error || ''}` : `${srcLabel(ctx.by)}${ctx.engine ? ` · ${ctx.engine}` : ''}${ctx.analyzed_at ? ` · ${ago(ctx.analyzed_at)}` : ''}`;
        return `<div class="post" data-pp="${esc(p.id)}"><div class="post-head" style="border:0;padding-bottom:10px"><img src="${esc(p.image)}" alt="" loading="lazy">
          <div><div class="post-cap" dir="auto">${esc(p.caption)}</div><div class="post-meta">Posted ${esc(ago(p.created_at))} · ${plural(p.comments.length, 'comment', 'comments')} · analysis: ${esc(analysis)}</div>
          ${ctx.summary ? `<div class="post-meta">${esc(ctx.summary)}</div>` : ''}
          <div class="post-products">${prods.map((x) => `<span class="chip">${esc(x.name)}<span class="src">${esc(srcLabel(x.source))}</span><button title="Remove" data-rm="${esc(x.id)}" data-p="${esc(p.id)}">×</button></span>`).join('') || '<span class="pill p-human">No product linked</span>'}
            <select data-add="${esc(p.id)}" aria-label="Add a product"><option value="">Add a product…</option>${products.filter((x) => !prods.some((y) => y.id === x.id)).map((x) => `<option value="${esc(x.id)}">${esc(x.name)} · ${esc(x.name_ar)}</option>`).join('')}</select>
            <button class="btn sm secondary" data-reanalyze="${esc(p.id)}">Analyse again</button></div></div>
          <div class="post-stats"><b>${prods.length}</b>${prods.length === 1 ? 'product' : 'products'}</div></div></div>`;
      })
      .join('');
    app.innerHTML = `<section class="view" data-view="posts"><div class="hero"><h1>Posts</h1><div class="hero-side"><p class="tag">Read once when published.<br>Used by every comment below it.</p><a href="${esc(feedHref())}" ${feedUrl() ? 'target="_blank" rel="noopener"' : ''}>Publish a post on the feed ↗</a></div></div>
      <h2 class="sec">The posts. <span>What each one is about.</span></h2>
      <div class="note" style="margin:-18px 0 26px;font-size:16px">When a new post goes up, the post graph ${postReads()} and links the products to the catalog. A comment like “وين بلاقيه؟” then knows what “it” is. Fix the links here if the graph got them wrong.</div>${rows}</section>`;
    if (!S.data) ensureData().then(() => S.view === 'posts' && renderPosts()).catch((e) => toast(e.message, true));
  }

  async function setPostProducts(pid, ids) {
    try {
      await api('/api/post-products', { body: { post_id: pid, product_ids: ids } });
      toast('Products saved. Redraft the comments under this post to use them.');
      await refresh(true);
    } catch (e) {
      toast(e.message, true);
    }
  }

  // ---------- data view ----------
  async function renderData() {
    const app = $('#app');
    app.innerHTML = `<section class="view" data-view="data"><div class="hero"><h1>Data</h1><div class="hero-side"><p class="tag">Answers come from here.<br>Never from a guess.</p><a href="/sample/pos_availability.csv" download>Download the sample file ›</a></div></div><div id="data-body"><div class="card" style="margin-top:60px"><div class="skeleton"></div><div class="skeleton" style="width:60%"></div></div></div></section>`;
    try {
      S.data = await api('/api/data');
    } catch (e) {
      $('#data-body').innerHTML = `<div class="card" style="margin-top:60px"><h3>Could not load the data</h3><div class="sub">${esc(e.message)}</div></div>`;
      return;
    }
    const d = S.data;
    const m = d.meta;
    const today = (S.state && S.state.today) || new Date().toISOString().slice(0, 10);
    const age = daysOld(m.date_max, today);
    const st = d.status;
    const total = st.in_stock + st.low_stock + st.out_of_stock;
    $('#data-body').innerHTML = `
      <h2 class="sec">The file. <span>What the answers rely on.</span></h2>
      <div class="grid g4">
        <div class="card stat"><div class="big">${m.row_count}</div><div class="title">Shelf checks</div><div class="desc">One per shop and item, latest visit kept.</div><div class="foot"><b>${esc(m.file_name)}</b>${m.sample ? ' · built-in sample' : ''}</div></div>
        <div class="card stat"><div class="big">${m.stores}</div><div class="title">Shops</div><div class="desc">In ${m.cities} cities and ${m.areas} areas.</div></div>
        <div class="card stat"><div class="big">${m.products}</div><div class="title">Products</div><div class="desc">${m.skus} pack sizes in total.</div></div>
        <div class="card stat"><div class="big ${age > 30 ? 'c-amber' : ''}">${age} d</div><div class="title">Since the last visit</div><div class="desc">Visits from ${esc(fmtDay(m.date_min))} to ${esc(fmtDay(m.date_max))}. Every reply names the visit date.</div></div>
      </div>
      <h2 class="sec">Upload. <span>Replace the file with a newer one.</span></h2>
      <div class="grid g21">
        <div class="card"><h3>New availability file</h3><div class="sub">CSV with a shop, area or city, product, availability (or quantity) and the visit date. Column names can vary.</div>
          <label class="drop" id="drop"><input type="file" id="file" accept=".csv,text/csv" hidden><b>Drop a CSV here</b> or click to choose one.<br><span class="note">After upload the catalog chunks and the search index are rebuilt automatically.</span></label>
          <div id="upload-out"></div></div>
        <div class="card"><h3>Search index</h3><div class="sub">Hybrid search finds which product, shop or place a comment means.</div>
          <dl class="kv"><dt>Mode</dt><dd>${m.index_mode !== 'words+characters' && !d.search_note ? 'BM25 words + character vectors + AI vectors' : 'BM25 words + character vectors'}</dd><dt>Built</dt><dd>${esc(ago(m.uploaded_at))}</dd>${m.embed_model ? `<dt>Embeddings</dt><dd>${esc(m.embed_model)}</dd>` : ''}</dl>
          ${d.search_note ? `<div class="note">${esc(d.search_note)}</div>` : ''}
          ${m.warnings && m.warnings.length ? `<div class="note" style="color:var(--amber)">${m.warnings.map(esc).join('<br>')}</div>` : ''}
          <div class="actions"><button class="btn sm secondary" id="reindex">Rebuild index</button>${m.sample ? '' : '<button class="btn sm ghost" id="restore">Restore the sample</button>'}</div></div>
      </div>
      <h2 class="sec">The shelves. <span>What the reps saw.</span></h2>
      <div class="grid g2">
        <div class="card"><div class="card-head"><div><h3>Shelf status</h3><div class="sub">All shelf checks in the file.</div></div></div>${bars([['In stock', st.in_stock, 'green'], ['Low stock', st.low_stock, 'amber'], ['Out of stock', st.out_of_stock, 'orange']])}<div class="note">${pct(st.in_stock + st.low_stock, total)}% of checks found the item on the shelf.</div></div>
        <div class="card"><div class="card-head"><div><h3>Shops by city</h3><div class="sub">Shops visited in each city.</div></div></div>${bars(d.cities.map((c) => [c.city, c.stores]))}</div>
      </div>
      <h2 class="sec">The catalog. <span>Names the search knows.</span></h2>
      <div class="card"><table class="table"><thead><tr><th>Product</th><th>Arabic</th><th>Category</th></tr></thead><tbody>${d.products.map((p) => `<tr><td>${esc(p.name)}</td><td dir="rtl" style="text-align:left">${esc(p.name_ar)}</td><td>${esc(p.category)}</td></tr>`).join('')}</tbody></table></div>`;
    const drop = $('#drop');
    const file = $('#file');
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => (e.preventDefault(), drop.classList.add('over'))));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => (e.preventDefault(), drop.classList.remove('over'))));
    drop.addEventListener('drop', (e) => e.dataTransfer.files[0] && upload(e.dataTransfer.files[0]));
    file.addEventListener('change', () => file.files[0] && upload(file.files[0]));
    $('#reindex').addEventListener('click', () => dataAction('reindex', 'Index rebuilt.'));
    $('#restore')?.addEventListener('click', () => dataAction('restore-sample', 'Sample data restored.'));
  }

  async function upload(f) {
    const out = $('#upload-out');
    if (f.size > 4.5e6) return (out.innerHTML = `<div class="problems">The file is larger than 4.5 MB.</div>`);
    out.innerHTML = `<div class="note">Uploading ${esc(f.name)} and rebuilding the index…</div>`;
    try {
      const csv = await f.text();
      const r = await api('/api/data', { body: { action: 'upload', file_name: f.name, csv } });
      toast(`${r.meta.row_count} shelf checks loaded from ${f.name}.`);
      S.data = null;
      await refresh(true);
      renderData();
    } catch (e) {
      const probs = e.data && e.data.problems ? `<ul>${e.data.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : '';
      out.innerHTML = `<div class="problems">${esc(e.message)}${probs}</div>`;
    }
  }

  async function dataAction(action, done) {
    try {
      toast('Working…');
      await api('/api/data', { body: { action } });
      toast(done);
      S.data = null;
      renderData();
    } catch (e) {
      toast(e.message, true);
    }
  }

  // ---------- health view ----------
  async function renderHealth() {
    const app = $('#app');
    app.innerHTML = `<section class="view" data-view="health"><div class="hero"><h1>Health</h1><div class="hero-side"><p class="tag">What is running,<br>and how.</p><a href="/api/health" target="_blank" rel="noopener">Raw health check ↗</a></div></div><div id="health-body"></div></section>`;
    try {
      S.health = await api('/api/health');
    } catch (e) {
      $('#health-body').innerHTML = `<div class="card" style="margin-top:60px"><h3>The backend did not answer</h3><div class="sub">${esc(e.message)}</div><div class="note">If you deployed by drag and drop and this page shows 404 errors, the functions were not deployed. See the README for the two-command CLI deploy.</div></div>`;
      return;
    }
    const h = S.health;
    const n = counts();
    const card = (big, title, desc, foot = '', cls = '') => `<div class="card stat"><div class="big ${cls}">${big}</div><div class="title">${title}</div><div class="desc">${desc}</div>${foot ? `<div class="foot">${foot}</div>` : ''}</div>`;
    $('#health-body').innerHTML = `<h2 class="sec">The parts. <span>Each one, checked just now.</span></h2>
      <div class="grid g4">
        ${card(h.engine === 'langgraph' ? 'On' : 'Off', 'LangGraph', h.engine === 'langgraph' ? 'Both graphs compile and run on @langchain/langgraph.' : `Running the same graph on the built-in runner. ${esc(h.engine_note || '')}`, '', h.engine === 'langgraph' ? 'c-green' : 'c-amber')}
        ${card(h.ai.enabled ? 'On' : 'Off', h.ai.enabled ? `Chat model · ${esc(h.ai.provider_name)}` : 'Chat model', h.ai.enabled ? `Reads comments and writes replies with ${esc(h.ai.model)}.${h.ai.provider === 'groq' ? ' Free tier: about 8,000 tokens a minute, so background drafts run one at a time and wait their turn.' : ''}${h.ai.vision ? '' : ' Reads post captions, not images.'}` : 'No chat model key (GROQ_API_KEY, GEMINI_API_KEY or OPENAI_API_KEY). Rules read the comments and templates write the replies.', `<button class="btn sm secondary" id="ai-check">Test the key</button> <span id="ai-out"></span>`, h.ai.enabled ? 'c-green' : 'c-amber')}
        ${card(h.storage === 'netlify-blobs' ? 'Blobs' : 'Files', 'Storage', h.storage === 'netlify-blobs' ? 'Posts, comments, drafts, replies and the data live in Netlify Blobs.' : 'Local files (development mode).', '', 'c-black')}
        ${card(h.search === 'words+characters+ai' ? '3 ways' : '2 ways', 'Hybrid search', h.search === 'words+characters+ai' ? `BM25 words, character vectors and ${esc((h.embeddings && h.embeddings.provider_name) || 'AI')} vectors (${esc((h.embeddings && h.embeddings.model) || '')}), fused with reciprocal rank fusion.` : `BM25 words and character vectors, fused with reciprocal rank fusion.${h.search_note ? ' ' + esc(h.search_note) : ''}`, '', 'c-blue')}
        ${card(h.data ? h.data.rows : '—', 'Shelf checks', h.data ? `${esc(h.data.file_name)}${h.data.sample ? ' (built-in sample)' : ''}. ${h.data.stores} shops, ${h.data.products} products.` : 'Loads on first use.', h.data ? `Last visit <b>${esc(fmtDay(h.data.date_max))}</b>` : '')}
        ${card(h.data ? `${h.data.age_days} d` : '—', 'Data age', 'Days since the newest visit in the file. Replies always say the visit date.', '', h.data && h.data.age_days > 30 ? 'c-amber' : 'c-green')}
        ${card(n.drafting, 'Drafts in progress', 'Run in background functions (up to 15 minutes each). If a job stops answering, this page drafts the comment directly.', n.failed ? `<b>${n.failed}</b> failed` : '', n.failed ? 'c-red' : 'c-black')}
        ${card(h.passcode ? 'On' : 'Off', 'Team passcode', h.passcode ? 'Team actions need the passcode (TEAM_PASSCODE).' : 'Anyone with the link can use this console. Set TEAM_PASSCODE in Netlify to lock it.', '', h.passcode ? 'c-green' : 'c-gray')}
      </div>
      <div class="note" style="margin-top:22px">Version ${esc(h.version)} · checked ${esc(new Date(h.time).toLocaleTimeString())}</div>`;
    $('#ai-check').addEventListener('click', async () => {
      $('#ai-out').textContent = 'Calling the AI model…';
      try {
        const r = await api('/api/health', { body: { action: 'ai-check' } });
        const chat = r.ok ? `Chat: <b style="color:var(--green)">works</b> · ${esc(r.model)} · ${r.ms} ms` : `Chat: <b style="color:${h.ai.enabled ? 'var(--red)' : 'var(--muted)'}">${h.ai.enabled ? 'failed' : 'off'}</b> · ${esc(r.error || '')}`;
        const emb = r.embeddings ? (r.embeddings.ok ? `Embeddings: <b style="color:var(--green)">work</b> · ${esc(r.embeddings.model)}` : `Embeddings: <b style="color:var(--red)">failed</b> · ${esc(r.embeddings.error || '')}`) : '';
        $('#ai-out').innerHTML = `${chat}${emb ? `<br>${emb}` : ''}`;
      } catch (e) {
        $('#ai-out').textContent = e.message;
      }
    });
  }

  // ---------- how it works ----------
  function howHtml() {
    const node = (n, d) => `<div class="node"><b>${n}</b><span>${d}</span></div>`;
    const textOnly = !!(S.health && S.health.ai && S.health.ai.enabled && !S.health.ai.vision); // e.g. Groq: the post graph reads the caption only
    const arr = '<div class="arrow">→</div>';
    return `<section class="view" data-view="how"><div class="hero"><h1>How it works</h1><div class="hero-side"><p class="tag">Search finds the words.<br>The table gives the answer.</p></div></div>
      <h2 class="sec">The steps. <span>From a file to a reply.</span></h2>
      <div class="grid g3 how-steps">
        <div class="card"><h3>Upload</h3><div class="sub">The CSV becomes a clean table (latest visit per shop and item) plus catalog chunks: one per product, shop, area, city, region and category, each with its Arabic and English names.</div></div>
        <div class="card"><h3>Index</h3><div class="sub">Every name is indexed three ways: BM25 on words (with Arabic prefixes like ب، ال، و), character vectors that survive typos, and AI embeddings (Jina, Gemini or OpenAI) when a key is set.</div></div>
        <div class="card"><h3>Post published</h3><div class="sub">The post graph ${postReads()} once and links its products to the catalog, so “وين بلاقيه؟” under the olive oil post means olive oil.</div></div>
        <div class="card"><h3>Comment arrives</h3><div class="sub">The ask graph reads the comment (intent, product, place, size), and hybrid search resolves each mention, fused with reciprocal rank fusion. Unclear words become a choice for you.</div></div>
        <div class="card"><h3>Exact answer</h3><div class="sub">The availability comes from a filter on the table, not from the model: in stock first, newest visit first, widening from area to city to region when nothing is on the shelf.</div></div>
        <div class="card"><h3>Checked, then you decide</h3><div class="sub">An AI reply must only name shops, dates and prices from the data, or the template replaces it. Nothing is posted until someone clicks Reply now.</div></div>
      </div>
      <h2 class="sec">The ask graph. <span>One run per comment.</span></h2>
      <div class="card"><div class="flow">${node('load_context', 'comment, post, post products')}${arr}${node('understand_comment', 'intent, product, place, size')}${arr}${node('find_entities', 'hybrid search + RRF')}${arr}${node('check_shelves', 'exact table query')}${arr}${node('write_answer', 'facts only')}${arr}${node('fact_check', 'shops, dates, prices')}${arr}${node('assemble_draft', 'draft + basis')}</div>
        <div class="branches">
          <div class="branch"><span class="when">if it is praise</span>${node('write_courtesy', 'short thanks')}${arr}${node('assemble_draft', '')}</div>
          <div class="branch"><span class="when">if a complaint or another question</span>${node('hand_off', 'holding reply, flagged for a person')}${arr}${node('assemble_draft', '')}</div>
          <div class="branch"><span class="when">if tags or chat</span>${node('no_reply', 'nothing to answer')}${arr}${node('assemble_draft', '')}</div>
          <div class="branch"><span class="when">if find_entities is unsure</span>${node('ask_clarify', 'options for you, or a question')}${arr}${node('assemble_draft', '')}</div>
        </div></div>
      <h2 class="sec">The post graph. <span>Once per post.</span></h2>
      <div class="card"><div class="flow">${node('read_post', textOnly ? 'the caption' : 'caption and image')}${arr}${node('spot_products', textOnly ? 'AI reads the caption, or caption rules' : 'vision model, or caption rules')}${arr}${node('link_catalog', 'hybrid search to catalog')}${arr}${node('save_context', 'products stored with the post')}</div></div>
      <h2 class="sec">Without a key. <span>Still works.</span></h2>
      <div class="card"><div class="sub" style="font-size:18px">With no AI key, the same graphs run with rule-based reading and templates. Search still uses BM25 and character vectors, and every answer still comes from the table with its visit dates.</div></div>
    </section>`;
  }

  // ---------- setup ----------
  function renderSetup() {
    const h = S.health;
    const prov = h && h.ai && h.ai.provider;
    $('#app').innerHTML = `<section class="view" data-view="setup"><div class="hero"><h1>Setup</h1><div class="hero-side"><p class="tag">Two sites,<br>one backend.</p></div></div>
      <h2 class="sec">Connect. <span>The feed and this console.</span></h2>
      <div class="grid g2">
        <div class="card"><h3>Feed simulator</h3><div class="sub">Paste the address of the feed site, so “Open the feed” works. The link passes this console's address to the feed, so the feed connects by itself.</div>
          <div class="field"><label for="feed-url">Feed site address</label><input id="feed-url" placeholder="https://your-feed.netlify.app" value="${esc(ls.get('feedUrl', '') || (h && h.feed_url) || '')}"></div>
          <div class="actions"><button class="btn sm" id="save-feed">Save</button><a class="btn sm ghost" id="open-feed" href="${esc(feedHref())}" target="_blank" rel="noopener">Open the feed ↗</a></div>
          <div class="note">This console's address (the feed's backend): <span class="mono">${esc(location.origin)}</span></div></div>
        <div class="card"><h3>Environment</h3><div class="sub">Set these in Netlify → Site configuration → Environment variables, then redeploy.</div>
          <dl class="kv"><dt class="mono">GROQ_API_KEY</dt><dd>${prov === 'groq' ? '<b style="color:var(--green)">set</b> (writes the replies)' : prov ? `not set (${esc(h.ai.provider_name)} is used)` : '<b style="color:var(--amber)">not set</b> (templates are used)'}</dd>
            <dt class="mono">GROQ_MODEL</dt><dd>${esc(prov === 'groq' ? h.ai.model : 'openai/gpt-oss-120b (default)')}</dd>
            <dt class="mono">JINA_API_KEY</dt><dd>${h && h.embeddings && h.embeddings.provider === 'jina' ? '<b style="color:var(--green)">set</b> (search vectors)' : 'optional: free search vectors'}</dd>
            <dt class="mono">GEMINI_API_KEY</dt><dd>${prov === 'gemini' ? '<b style="color:var(--green)">set</b> (writes the replies)' : 'optional, used only without a Groq key'}</dd>
            <dt class="mono">OPENAI_API_KEY</dt><dd>${prov === 'openai' ? '<b style="color:var(--green)">set</b> (writes the replies)' : 'optional, used only without Groq or Gemini keys'}</dd>
            <dt class="mono">TEAM_PASSCODE</dt><dd>${h && h.passcode ? 'set' : 'not set (optional)'}</dd>
            <dt class="mono">FEED_URL</dt><dd>${esc((h && h.feed_url) || 'not set (optional)')}</dd></dl></div>
      </div>
      <h2 class="sec">Demo. <span>Start again.</span></h2>
      <div class="grid g2">
        <div class="card"><h3>Reset the demo</h3><div class="sub">Puts back the five posts and their comments, removes posts and comments made on the feed, and drafts the replies again. The data file is kept.</div><div class="actions"><button class="btn sm secondary" id="reset">Reset the demo</button></div></div>
        <div class="card"><h3>This browser</h3><div class="sub">Passcode and preferences are kept in this browser only.</div><div class="actions"><button class="btn sm ghost" id="forget">Forget the passcode</button></div></div>
      </div></section>`;
    $('#save-feed').addEventListener('click', () => {
      const v = $('#feed-url').value.trim().replace(/\/+$/, '');
      if (v && !/^https?:\/\//.test(v)) return toast('The address should start with https://', true);
      ls.set('feedUrl', v);
      $('#open-feed').href = feedHref();
      toast('Saved.');
    });
    $('#reset').addEventListener('click', async () => {
      if (!confirm('Reset the demo to its five posts? Posts and comments made on the feed are removed.')) return;
      try {
        toast('Resetting…');
        await api('/api/reset', { method: 'POST', body: {} });
        S.editing.clear();
        S.seen = null;
        toast('The demo is back to its five posts.');
        await refresh(true);
      } catch (e) {
        toast(e.message, true);
      }
    });
    $('#forget').addEventListener('click', () => {
      ls.set('passcode', '');
      toast('Passcode forgotten in this browser.');
    });
  }

  // ---------- polling ----------
  let refreshing = null;
  async function refresh(force = false) {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const res = await api(`/api/state?view=team${S.version && !force ? `&v=${encodeURIComponent(S.version)}` : ''}`);
        S.error = null;
        S.lastOk = Date.now();
        if (res.now) S.skew = Date.parse(res.now) - Date.now();
        if (!res.unchanged) {
          detectNew(res);
          S.state = res;
          S.version = res.version;
          renderView(false);
        } else if (S.view === 'overview') renderQueue();
        runFallbacks();
      } catch (e) {
        S.error = e.message;
      } finally {
        renderRibbon();
        refreshing = null;
      }
    })();
    return refreshing;
  }

  function detectNew(res) {
    const ids = new Set(res.posts.flatMap((p) => p.comments.map((c) => c.id)));
    if (S.seen) {
      const fresh = [...ids].filter((id) => !S.seen.has(id));
      if (fresh.length) {
        fresh.forEach((id) => S.flash.add(id));
        if (S.sound) ding();
      }
    }
    S.seen = ids;
  }

  // Background functions draft new comments. If one waits too long (or background jobs are not available),
  // this page asks for the draft directly, one at a time.
  async function runFallbacks() {
    if (S.fallback || !S.state) return;
    const now = srvNow();
    const ai = !!(S.health && S.health.ai && S.health.ai.enabled);
    const silent = (b) => now - Date.parse(b.at) > 75000; // jobs write a beat every 20 seconds
    for (const p of S.state.posts) {
      if (p.ctx && p.ctx.status === 'pending' && (p.ctx.via === 'page' || (p.beat ? silent(p.beat) : now - Date.parse(p.ctx.analyzed_at) > (ai ? 75000 : 25000)))) {
        S.fallback = true;
        try {
          await api('/api/post-products', { body: { post_id: p.id, action: 'analyze' } });
        } catch {}
        S.fallback = false;
        return refresh(true);
      }
      for (const c of p.comments) {
        if (c.reply) continue;
        const d = c.draft;
        if (d && d.status !== 'drafting') continue;
        const started = d ? Date.parse(d.started_at || d.created_at) : Date.parse(c.created_at);
        // a job that is still beating keeps its comments (it may be waiting out a rate limit); otherwise wait a little
        const due = d && d.via === 'page' ? true : c.beat ? silent(c.beat) : now - started > (ai ? 75000 : 15000);
        if (due && !S.busy.has(c.id)) {
          S.fallback = true;
          S.busy.add(c.id);
          try {
            await api('/api/draft', { body: { post_id: p.id, comment_id: c.id } });
          } catch {}
          S.busy.delete(c.id);
          S.fallback = false;
          return refresh(true);
        }
      }
    }
  }

  let audio = null;
  function ding() {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(880, audio.currentTime);
      o.frequency.exponentialRampToValueAtTime(1320, audio.currentTime + 0.12);
      g.gain.setValueAtTime(0.0001, audio.currentTime);
      g.gain.exponentialRampToValueAtTime(0.18, audio.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.4);
      o.connect(g).connect(audio.destination);
      o.start();
      o.stop(audio.currentTime + 0.42);
    } catch {}
  }

  // ---------- events ----------
  document.addEventListener('click', (e) => {
    const t = e.target;
    const actBtn = t.closest('[data-act]');
    if (actBtn) {
      e.preventDefault();
      if (!actBtn.disabled) act(actBtn);
      return;
    }
    if (t.closest('[data-menu]')) return openMenu();
    const kpi = t.closest('[data-kpi]');
    if (kpi) {
      S.filter.status = kpi.dataset.kpi === 'drafting' ? 'all' : kpi.dataset.kpi;
      ls.set('f.status', S.filter.status);
      renderOverview(false);
      document.getElementById('the-queue')?.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    if (t.closest('[data-go="data"]')) return (location.hash = '#data');
    if (t.closest('#kpi-next')) return $('#kpis')?.scrollBy({ left: 360, behavior: 'smooth' });
    const rm = t.closest('[data-rm]');
    if (rm) {
      const p = S.state.posts.find((x) => x.id === rm.dataset.p);
      return setPostProducts(rm.dataset.p, ((p.ctx && p.ctx.products) || []).map((x) => x.id).filter((id) => id !== rm.dataset.rm));
    }
    const re = t.closest('[data-reanalyze]');
    if (re) {
      re.disabled = true;
      toast('Analysing the post again…');
      api('/api/post-products', { body: { post_id: re.dataset.reanalyze, action: 'analyze' } })
        .then(() => (toast('Post analysed.'), refresh(true)))
        .catch((err) => toast(err.message, true));
    }
  });
  document.addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-add]');
    if (sel && sel.value) {
      const p = S.state.posts.find((x) => x.id === sel.dataset.add);
      setPostProducts(sel.dataset.add, [...((p.ctx && p.ctx.products) || []).map((x) => x.id), sel.value]);
    }
  });
  document.addEventListener('input', (e) => {
    const ta = e.target.closest('textarea[data-edit]');
    if (ta) S.editing.set(ta.dataset.edit, ta.value);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeMenu();
      $('#search-panel').classList.remove('open');
    }
    const ta = e.target.closest && e.target.closest('textarea[data-edit]');
    if (ta && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      const btn = ta.closest('.draft').querySelector('[data-act="send"]');
      if (btn) act(btn);
    }
  });
  $('#btn-theme').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme !== 'dark';
    document.documentElement.dataset.theme = dark ? 'dark' : '';
    ls.set('theme', dark ? 'dark' : 'light');
  });
  const soundBtn = $('#btn-sound');
  soundBtn.classList.toggle('on', S.sound);
  soundBtn.addEventListener('click', () => {
    S.sound = !S.sound;
    ls.set('sound', S.sound);
    soundBtn.classList.toggle('on', S.sound);
    if (S.sound) ding();
    toast(S.sound ? 'A sound plays when a new comment arrives.' : 'Sound off.');
  });
  $('#btn-search').addEventListener('click', () => {
    const panel = $('#search-panel');
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) {
      if (S.view !== 'overview') location.hash = '#overview';
      $('#search').focus();
    }
  });
  $('#search').addEventListener('input', (e) => {
    S.search = e.target.value.trim();
    if (S.view === 'overview') renderOverview(false);
  });
  window.addEventListener('hashchange', route);

  async function loadHealth() {
    const sig = () => (S.health && S.health.ai ? `${S.health.ai.provider}|${S.health.ai.vision}` : '');
    const before = sig();
    try {
      S.health = await api('/api/health');
    } catch (e) {
      S.error = e.message;
    }
    renderRibbon();
    // pages written once from the health answer (which model, whether it reads images) are redrawn when it first arrives
    if (sig() !== before && (S.view === 'how' || S.view === 'setup')) renderView(true);
  }

  route();
  loadHealth();
  refresh(true);
  setInterval(() => !document.hidden && refresh(false), 3000);
  setInterval(() => !document.hidden && loadHealth(), 60000);
})();

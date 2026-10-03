/* Feed simulator: shows the brand's posts, lets you comment as one of several customers,
   and shows the brand's replies as soon as the team sends them from the team console. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ls = {
    get(k, d) {
      try {
        const v = localStorage.getItem('feed.' + k);
        return v === null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem('feed.' + k, JSON.stringify(v));
      } catch {}
    },
  };
  const ICON = {
    heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M12 20s-7.5-4.6-9.2-9.1C1.6 7.6 3.9 4.5 7.1 4.5c2 0 3.6 1.1 4.9 2.8 1.3-1.7 2.9-2.8 4.9-2.8 3.2 0 5.5 3.1 4.3 6.4C19.5 15.4 12 20 12 20Z"/></svg>',
    comment: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M20.5 12a8.5 8.5 0 0 1-12.6 7.4L3.5 20.5l1.2-4.2A8.5 8.5 0 1 1 20.5 12Z"/></svg>',
    share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M21 3 10 14M21 3l-7 18-4-7-7-4 18-7Z"/></svg>',
    save: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M6 3.5h12v17l-6-4.5-6 4.5z"/></svg>',
    photo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/></svg>',
  };

  // ---------- where the backend lives ----------
  function apiBase() {
    const q = new URLSearchParams(location.search).get('api');
    if (q && /^https?:\/\//.test(q)) {
      ls.set('api', q.replace(/\/+$/, ''));
      history.replaceState(null, '', location.pathname);
    }
    const cfg = (window.FEED_CONFIG && window.FEED_CONFIG.API_BASE) || '';
    return (cfg || ls.get('api', '') || '').replace(/\/+$/, '');
  }
  let API = apiBase();
  const url = (path) => (/^https?:\/\//.test(path) ? path : API + path);

  async function api(path, body) {
    const res = await fetch(url(path), body ? { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(body) } : {});
    let data = null;
    try {
      data = await res.json();
    } catch {}
    if (!res.ok) throw new Error((data && data.error) || `The backend answered ${res.status}.`);
    return data;
  }

  // ---------- state ----------
  const S = { state: null, version: null, as: ls.get('as', ''), expanded: new Set(), liked: new Set(ls.get('liked', [])), mine: new Set(ls.get('mine', [])), seenReplies: null, fresh: new Set(), drafts: new Map(), error: null, failures: 0 };

  let toastT = null;
  function toast(msg, err = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast show${err ? ' err' : ''}`;
    clearTimeout(toastT);
    toastT = setTimeout(() => (t.className = 'toast'), err ? 5000 : 2400);
  }

  const shortAgo = (iso) => {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    if (s < 604800) return `${Math.floor(s / 86400)}d`;
    return `${Math.floor(s / 604800)}w`;
  };
  const longAgo = (iso) => {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return 'just now';
    const n = (v, w) => `${v} ${w}${v === 1 ? '' : 's'} ago`;
    if (s < 3600) return n(Math.floor(s / 60), 'minute');
    if (s < 86400) return n(Math.floor(s / 3600), 'hour');
    return n(Math.floor(s / 86400), 'day');
  };
  const hash = (s) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
  };

  const personas = () => (S.state ? S.state.personas : []);
  function current() {
    const list = personas();
    return list.find((p) => p.id === S.as) || list[0] || null;
  }
  function avatar(p, size = 's32') {
    if (!p) return `<span class="av ${size}"></span>`;
    const parts = String(p.name).trim().split(/\s+/);
    const ini = /[\u0600-\u06ff]/.test(parts[0] || '') ? (parts[0] || '?').charAt(0) : (parts[0] || '?').charAt(0) + (parts[1] ? parts[1].charAt(0) : '');
    return `<span class="av ${size}" style="background:${esc(p.color)}">${esc(ini)}</span>`;
  }
  const brandAvatar = (size = 's32') => `<span class="av ${size}" style="background:#2f4a2b"><img src="${esc(url(S.state.brand.avatar))}" alt=""></span>`;
  const personaById = (id) => personas().find((p) => p.id === id);

  // ---------- render ----------
  function renderStories() {
    const me = current();
    $('#stories').innerHTML = personas()
      .map((p) => `<button class="story${me && p.id === me.id ? ' sel' : ''}" data-as="${esc(p.id)}" title="Comment as ${esc(p.name)}"><span class="ring">${avatar(p, 's56')}</span><span class="nm" dir="auto">${esc(p.name.split(' ')[0])}</span></button>`)
      .join('');
  }

  function renderSide() {
    const me = current();
    if (!me) return;
    const b = S.state.brand;
    $('#side').innerHTML = `<div class="me">${avatar(me, 's56')}<div class="who"><b>${esc(me.handle)}</b><span dir="auto">${esc(me.name)}</span></div><span class="switch">Commenting</span></div>
      <h4>Switch customer</h4>
      ${personas().map((p) => `<button class="person${p.id === me.id ? ' sel' : ''}" data-as="${esc(p.id)}">${avatar(p, 's44')}<span class="who"><b>${esc(p.handle)}</b><span dir="auto">${esc(p.name)}</span></span><span class="use">${p.id === me.id ? 'Selected' : 'Use'}</span></button>`).join('')}
      <div class="about">A demo feed for <b>${esc(b.name)}</b> (${esc(b.name_ar)}), a fictional brand. Comment as any customer; the marketing team sees each comment with a prepared reply and posts it with one click. Use the <b>+</b> button to publish a new post as the brand.</div>`;
  }

  function commentsHtml(post) {
    const all = post.comments;
    const expanded = S.expanded.has(post.id);
    const list = expanded || all.length <= 3 ? all : all.slice(-3);
    const more = all.length > list.length ? `<button class="view-all" data-expand="${esc(post.id)}">View all ${all.length} comments</button>` : '';
    return (
      more +
      list
        .map((c) => {
          const p = personaById(c.persona_id) || { name: c.author_name, color: '#999', handle: c.author_handle };
          const reply = c.reply
            ? `<div class="replies"><div class="reply${S.fresh.has(c.id) ? ' fresh' : ''}">${brandAvatar('s24')}<div class="c-main"><div class="c-line"><b>${esc(S.state.brand.handle)}</b><span class="author">Author</span></div><div class="c-text" dir="auto">${esc(c.reply.text)}</div><div class="c-meta"><span>${esc(shortAgo(c.reply.at))}</span></div></div></div></div>`
            : S.mine.has(c.id)
              ? `<div class="pending-note">The brand's reply shows here as soon as the team sends it.</div>`
              : '';
          return `<div class="c-item">${avatar(p, 's32')}<div class="c-main"><div class="c-line"><b>${esc(c.author_handle)}</b> <span dir="auto">${esc(c.text)}</span></div><div class="c-meta"><span>${esc(shortAgo(c.created_at))}</span><b>Reply</b></div>${reply}</div></div>`;
        })
        .join('')
    );
  }

  function postShell(post) {
    const b = S.state.brand;
    const likes = 120 + (hash(post.id) % 2200);
    const liked = S.liked.has(post.id);
    const me = current();
    return `<div class="p-head">${brandAvatar('s32')}<div><div class="name">${esc(b.handle)}</div><div class="sub">${esc(b.name)} · Amman</div></div><span class="more">···</span></div>
      <div class="p-media" data-like="${esc(post.id)}"><img src="${esc(url(post.image))}" alt="" loading="lazy"><div class="burst">${ICON.heart.replace('fill="none"', 'fill="currentColor"')}</div></div>
      <div class="p-body">
        <div class="p-actions"><button class="ico${liked ? ' liked' : ''}" data-heart="${esc(post.id)}" aria-label="Like">${ICON.heart}</button><button class="ico" data-focus="${esc(post.id)}" aria-label="Comment">${ICON.comment}</button><button class="ico" aria-label="Share">${ICON.share}</button><button class="ico save" aria-label="Save">${ICON.save}</button></div>
        <div class="likes" data-likes="${esc(post.id)}">${(likes + (liked ? 1 : 0)).toLocaleString('en-US')} likes</div>
        <div class="caption clamp" dir="auto" data-cap="${esc(post.id)}"><b>${esc(b.handle)}</b> ${esc(post.caption)}</div>
        ${post.caption.length > 90 || post.caption.split('\n').length > 2 ? `<button class="morebtn" data-more="${esc(post.id)}">more</button>` : ''}
        <div class="comments" data-comments="${esc(post.id)}"></div>
        <div class="when">${esc(longAgo(post.created_at))}</div>
        <form class="add" data-add="${esc(post.id)}">${avatar(me, 's24')}<input name="t" maxlength="300" placeholder="Add a comment as ${esc(me ? me.name.split(' ')[0] : '')}…" autocomplete="off" dir="auto"><button type="submit" disabled>Post</button></form>
      </div>`;
  }

  function render() {
    const box = $('#posts');
    if (!S.state) return;
    renderStories();
    renderSide();
    const keep = new Set();
    let prev = null;
    for (const post of S.state.posts) {
      keep.add(post.id);
      let el = box.querySelector(`:scope > [data-post="${CSS.escape(post.id)}"]`);
      if (!el) {
        el = document.createElement('article');
        el.className = 'post';
        el.dataset.post = post.id;
        el.innerHTML = postShell(post);
        if (S.version && Date.now() - Date.parse(post.created_at) < 60000) el.classList.add('new-post');
      }
      const sig = JSON.stringify([post.comments, S.expanded.has(post.id), [...S.fresh], S.mine.size]);
      const cbox = el.querySelector('[data-comments]');
      if (cbox.dataset.sig !== sig) {
        cbox.innerHTML = commentsHtml(post);
        cbox.dataset.sig = sig;
      }
      const want = prev ? prev.nextSibling : box.firstChild;
      if (want !== el) box.insertBefore(el, want);
      prev = el;
    }
    $$(':scope > *', box).forEach((el) => (!el.dataset.post || !keep.has(el.dataset.post)) && el.remove());
    if (!S.state.posts.length) box.innerHTML = `<div class="setup"><h2>No posts yet</h2><p>Use the + button to publish the first post.</p></div>`;
  }

  // Refresh "Add a comment as …" placeholders and avatars after switching customer, without touching typed text.
  function refreshComposer() {
    const me = current();
    $$('form.add').forEach((f) => {
      f.querySelector('.av').outerHTML = avatar(me, 's24');
      f.querySelector('input').placeholder = `Add a comment as ${me ? me.name.split(' ')[0] : ''}…`;
    });
  }

  function banner(html, err = false) {
    $('#banner').innerHTML = html ? `<div class="banner${err ? ' err' : ''}">${html}</div>` : '';
  }

  function showSetup(message) {
    $('#posts').innerHTML = `<div class="setup"><h2>Connect the feed</h2><p>${esc(message || 'Paste the address of the team console site. It hosts the backend this feed talks to.')}</p>
      <form id="setup-form"><input id="setup-url" placeholder="https://your-team-console.netlify.app" value="${esc(API)}" required><div style="margin-top:12px;display:flex;gap:8px"><button class="btn" type="submit">Connect</button></div></form></div>`;
    $('#setup-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const v = $('#setup-url').value.trim().replace(/\/+$/, '');
      if (!/^https?:\/\//.test(v)) return toast('The address should start with https://', true);
      ls.set('api', v);
      API = v;
      S.version = null;
      $('#posts').innerHTML = loading();
      refresh();
    });
  }
  const loading = () => `<div class="post"><div class="p-head"><span class="av s32"></span><div style="flex:1"><div class="skel" style="width:40%"></div></div></div><div class="p-media"></div><div class="skel" style="width:70%"></div><div class="skel" style="width:45%"></div></div>`;

  // ---------- polling ----------
  let busy = false;
  async function refresh() {
    if (!API) return showSetup();
    if (busy) return;
    busy = true;
    try {
      const res = await api(`/api/state?view=feed${S.version ? `&v=${encodeURIComponent(S.version)}` : ''}`);
      S.failures = 0;
      banner('');
      if (!res.unchanged) {
        const replied = new Set(res.posts.flatMap((p) => p.comments.filter((c) => c.reply).map((c) => c.id)));
        if (S.seenReplies) {
          const fresh = [...replied].filter((id) => !S.seenReplies.has(id));
          fresh.forEach((id) => S.fresh.add(id));
          if (fresh.some((id) => S.mine.has(id))) {
            toast('The brand replied to your comment.');
            $('#activity-dot').hidden = false;
          }
          if (fresh.length) setTimeout(() => (fresh.forEach((id) => S.fresh.delete(id)), render()), 3200);
        }
        S.seenReplies = replied;
        if (!S.state && !S.as && res.personas.length) S.as = res.personas[0].id;
        S.state = res;
        S.version = res.version;
        render();
      }
    } catch (e) {
      S.failures++;
      if (!S.state) showSetup(`Could not reach the backend at ${API}: ${e.message}`);
      else if (S.failures > 1) banner(`Can't reach the backend right now (${esc(e.message)}). Retrying…`, true);
    } finally {
      busy = false;
    }
  }

  // ---------- actions ----------
  async function submitComment(form) {
    const input = form.querySelector('input');
    const btn = form.querySelector('button');
    const text = input.value.trim();
    const me = current();
    if (!text || !me) return;
    btn.disabled = true;
    input.disabled = true;
    try {
      const r = await api('/api/comments', { post_id: form.dataset.add, persona_id: me.id, text });
      S.mine.add(r.comment.id);
      ls.set('mine', [...S.mine].slice(-200));
      S.expanded.add(form.dataset.add);
      input.value = '';
      S.version = null;
      await refresh();
    } catch (e) {
      toast(e.message, true);
    } finally {
      input.disabled = false;
      btn.disabled = !input.value.trim();
      input.focus();
    }
  }

  function like(postId, burst) {
    const on = !S.liked.has(postId);
    if (!on && burst) return;
    on ? S.liked.add(postId) : S.liked.delete(postId);
    ls.set('liked', [...S.liked]);
    const btn = $(`[data-heart="${CSS.escape(postId)}"]`);
    btn && btn.classList.toggle('liked', on);
    const base = 120 + (hash(postId) % 2200);
    const el = $(`[data-likes="${CSS.escape(postId)}"]`);
    if (el) el.textContent = `${(base + (on ? 1 : 0)).toLocaleString('en-US')} likes`;
    if (burst) {
      const b = $(`[data-like="${CSS.escape(postId)}"] .burst`);
      if (b) {
        b.classList.remove('go');
        void b.offsetWidth;
        b.classList.add('go');
      }
    }
  }

  // new post dialog: pick an image, write a caption, publish as the brand
  function openComposer() {
    if (!S.state) return toast('Connect the feed first.', true);
    const b = S.state.brand;
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `<div class="modal" role="dialog" aria-label="Create new post"><div class="modal-head"><button class="cancel" type="button">Cancel</button><span>Create new post</span><button class="share" type="button" disabled>Share</button></div>
      <div class="modal-body"><label class="pick" id="pick">${ICON.photo}<div>Drag a photo here</div><span class="btn">Select from computer</span><input type="file" accept="image/jpeg,image/png,image/webp" hidden></label>
        <div class="compose"><div class="me">${brandAvatar('s32')}<div class="who"><b>${esc(b.handle)}</b><span>Posting as the brand</span></div></div>
          <textarea maxlength="1200" placeholder="Write a caption… (name the product, e.g. طحينة or olive oil)" dir="auto"></textarea><div class="count">0/1200</div>
          <div class="hint">When you share, the team console reads the image and caption once and links the products to the catalog. Comments on this post then know what “it” refers to.</div></div></div></div>`;
    document.body.appendChild(wrap);
    let dataUrl = null;
    const share = $('.share', wrap);
    const ta = $('textarea', wrap);
    const pick = $('#pick', wrap);
    const file = $('input[type=file]', wrap);
    const close = () => wrap.remove();
    const update = () => {
      share.disabled = !dataUrl;
      $('.count', wrap).textContent = `${ta.value.length}/1200`;
    };
    $('.cancel', wrap).addEventListener('click', close);
    wrap.addEventListener('click', (e) => e.target === wrap && close());
    ta.addEventListener('input', update);
    async function take(f) {
      if (!f || !/^image\//.test(f.type)) return toast('Choose a JPEG, PNG or WebP image.', true);
      try {
        dataUrl = await resize(f, 1080, 0.85);
        pick.querySelector('img')?.remove();
        const img = document.createElement('img');
        img.src = dataUrl;
        pick.appendChild(img);
        update();
        ta.focus();
      } catch {
        toast('That image could not be read.', true);
      }
    }
    file.addEventListener('change', () => take(file.files[0]));
    ['dragenter', 'dragover'].forEach((ev) => pick.addEventListener(ev, (e) => (e.preventDefault(), pick.classList.add('over'))));
    ['dragleave', 'drop'].forEach((ev) => pick.addEventListener(ev, (e) => (e.preventDefault(), pick.classList.remove('over'))));
    pick.addEventListener('drop', (e) => take(e.dataTransfer.files[0]));
    share.addEventListener('click', async () => {
      share.disabled = true;
      share.textContent = 'Sharing…';
      try {
        await api('/api/posts', { caption: ta.value.trim(), image: dataUrl });
        close();
        toast('Your post has been shared.');
        S.version = null;
        window.scrollTo({ top: 0, behavior: 'smooth' });
        await refresh();
      } catch (e) {
        toast(e.message, true);
        share.disabled = false;
        share.textContent = 'Share';
      }
    });
  }

  // downscale in the browser so uploads stay small (max side 1080 px, JPEG)
  function resize(f, max, q) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const u = URL.createObjectURL(f);
      img.onload = () => {
        const s = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * s);
        c.height = Math.round(img.height * s);
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(u);
        resolve(c.toDataURL('image/jpeg', q));
      };
      img.onerror = () => (URL.revokeObjectURL(u), reject(new Error('bad image')));
      img.src = u;
    });
  }

  // ---------- events ----------
  document.addEventListener('click', (e) => {
    const t = e.target;
    const as = t.closest('[data-as]');
    if (as) {
      S.as = as.dataset.as;
      ls.set('as', S.as);
      renderStories();
      renderSide();
      refreshComposer();
      const me = current();
      toast(`Commenting as ${me.name}.`);
      return;
    }
    const ex = t.closest('[data-expand]');
    if (ex) {
      S.expanded.add(ex.dataset.expand);
      return render();
    }
    const more = t.closest('[data-more]');
    if (more) {
      $(`[data-cap="${CSS.escape(more.dataset.more)}"]`)?.classList.remove('clamp');
      return more.remove();
    }
    const heart = t.closest('[data-heart]');
    if (heart) return like(heart.dataset.heart, false);
    const focus = t.closest('[data-focus]');
    if (focus) return $(`form[data-add="${CSS.escape(focus.dataset.focus)}"] input`)?.focus();
    if (t.closest('#btn-new')) return openComposer();
    if (t.closest('#btn-activity')) {
      $('#activity-dot').hidden = true;
      return toast('Replies from the brand appear under each comment.');
    }
  });
  document.addEventListener('dblclick', (e) => {
    const m = e.target.closest('[data-like]');
    if (m) like(m.dataset.like, true);
  });
  document.addEventListener('input', (e) => {
    const f = e.target.closest('form.add');
    if (f) f.querySelector('button').disabled = !e.target.value.trim();
  });
  document.addEventListener('submit', (e) => {
    const f = e.target.closest('form.add');
    if (f) {
      e.preventDefault();
      submitComment(f);
    }
  });

  if (!API) showSetup();
  else $('#posts').innerHTML = loading();
  refresh();
  setInterval(() => !document.hidden && refresh(), 3000);
})();

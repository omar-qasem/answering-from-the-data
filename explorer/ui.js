(function () {
  'use strict';
  var X = window.XE;
  var $ = function (s, el) { return (el || document).querySelector(s); };
  var $$ = function (s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); };
  if (!X) { $('#insp-title').textContent = 'The engine did not load. Reload the page.'; return; }

  // ---------- small helpers ----------
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
  var AR = /[؀-ۿ]/;
  function t(s) { return AR.test(String(s)) ? '<bdi class="ar">' + esc(s) + '</bdi>' : '<bdi>' + esc(s) + '</bdi>'; }
  // an English sentence that quotes Arabic words: keep it left to right, each Arabic word in its own run
  function tl(s) { return '<bdi dir="ltr">' + esc(s).replace(/([\u0600-\u06FF][\u0600-\u06FF\s]*[\u0600-\u06FF]|[\u0600-\u06FF])/g, '<bdi class="ar">$1</bdi>') + '</bdi>'; }
  function fx(n, d) { return Number(n).toFixed(d); }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function day(iso) { var p = String(iso).slice(0, 10).split('-'); return +p[2] + ' ' + MON[+p[1] - 1]; }
  var C = X.constants;
  var PROD = ['product', 'category'];
  var PLACE = ['area', 'city', 'region', 'store'];
  var PERS = {};
  X.sample.personas.forEach(function (p) { PERS[p.id] = p; });
  var mem = {
    get: function (k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* storage may be blocked */ } },
  };
  function code(html) { return '<pre class="code">' + html + '</pre>'; }
  function J(v, ind) {
    ind = ind || 0;
    var pad = new Array(ind + 1).join('  '), pad1 = pad + '  ';
    if (v && typeof v === 'object' && v.__c) return '<span class="c">' + esc(v.__c) + '</span>';
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'string') return '<span class="s">"' + esc(v) + '"</span>';
    if (typeof v !== 'object') return esc(String(v));
    if (Array.isArray(v)) {
      if (!v.length) return '[]';
      var flat = v.every(function (x) { return x === null || typeof x !== 'object' || x.__c; });
      if (flat && v.length <= 10) return '[' + v.map(function (x) { return J(x, 0); }).join(', ') + ']';
      return '[\n' + v.map(function (x) { return pad1 + J(x, ind + 1); }).join(',\n') + '\n' + pad + ']';
    }
    var ks = Object.keys(v);
    if (!ks.length) return '{}';
    return '{\n' + ks.map(function (k) { return pad1 + '<span class="k">"' + esc(k) + '"</span>: ' + J(v[k], ind + 1); }).join(',\n') + '\n' + pad + '}';
  }
  function kv(pairs) { return '<dl class="kv">' + pairs.map(function (p) { return '<dt>' + esc(p[0]) + '</dt><dd>' + p[1] + '</dd>'; }).join('') + '</dl>'; }
  function chips(list, cls) { return list.map(function (x) { return '<span class="chip ' + (cls || '') + '">' + t(x) + '</span>'; }).join(' '); }
  var STATUS = { ready: ['ready', 'Ready'], needs_choice: ['choice', 'Needs a choice'], needs_human: ['person', 'Needs a person'], no_reply: ['none', 'No reply needed'], drafting: ['none', 'Drafting'] };
  function statusPill(s) { var x = STATUS[s] || ['none', s]; return '<span class="pill ' + x[0] + '">' + x[1] + '</span>'; }
  var DEC = { match: ['match', 'Match'], ambiguous: ['ask', 'Ask the customer'], none: ['nomatch', 'No match'] };
  function decPill(s) { var x = DEC[s] || ['nomatch', s]; return '<span class="pill ' + x[0] + '">' + x[1] + '</span>'; }
  var STX = { in_stock: 'in stock', low_stock: 'low stock', out_of_stock: 'out of stock' };
  function stPill(s) { return '<span class="st ' + s + '">' + (STX[s] || s) + '</span>'; }
  function typesLabel(types) { return types.indexOf('product') >= 0 ? 'products and categories' : types.length === 1 ? 'shops' : 'areas, cities, regions and shops'; }
  function bars(counts, order) {
    var max = Math.max.apply(null, order.map(function (o) { return counts[o[0]] || 0; })) || 1;
    return '<div class="typebars">' + order.map(function (o) {
      var n = counts[o[0]] || 0;
      return '<div class="typebar"><span>' + o[1] + '</span><span class="bar"><i style="width:' + fx((100 * n) / max, 1) + '%"></i></span><span class="num">' + n + '</span></div>';
    }).join('') + '</div>';
  }
  function avatar(p) { return '<span class="avatar" style="background:' + esc(p.color) + '">' + esc((p.name || '?').trim().charAt(0)) + '</span>'; }
  function bubble(p, text, cls) { return '<div class="comment ' + (cls || '') + '">' + avatar(p) + '<div class="bubble"><p class="who">' + t(p.name) + '</p><p class="txt" dir="auto">' + esc(text) + '</p></div></div>'; }
  var BRAND = { name: 'بيت المونة · Bayt Al Mouneh', color: '#4C3FD1' };

  // ---------- header facts ----------
  var S = X.stats;
  $('#facts').innerHTML = [
    '<span class="fact"><b>' + S.rows + '</b> shelf visits</span>',
    '<span class="fact"><b>' + S.entries + '</b> catalog entries</span>',
    '<span class="fact"><b>' + S.docs + '</b> names indexed</span>',
    '<span class="fact">visits <b>' + day(S.dateMin) + ' – ' + day(S.dateMax) + ' ' + S.dateMax.slice(0, 4) + '</b></span>',
  ].join('');

  // ---------- tabs ----------
  var TABS = ['paths', 'graph', 'search', 'models'];
  var current = 'paths';
  function showTab(id, focus) {
    if (TABS.indexOf(id) < 0) id = 'paths';
    current = id;
    TABS.forEach(function (x) {
      var on = x === id;
      var b = $('#tab-' + x);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      $('#view-' + x).hidden = !on;
    });
    if (focus) $('#tab-' + id).focus();
    mem.set('ape-tab', id);
    try { history.replaceState(null, '', '#' + id); } catch (e) { /* not allowed in some frames */ }
    stopPlay();
    if (id === 'graph') renderGraphView();
    if (id === 'search' && !LR) runLab();
  }
  TABS.forEach(function (x) { $('#tab-' + x).addEventListener('click', function () { showTab(x); }); });
  $('.tabs').addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    var i = TABS.indexOf(current);
    showTab(TABS[(i + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length], true);
    e.preventDefault();
  });

  // ---------- the sequence drawing ----------
  var LANES = [
    { id: 'feed', b: 'Feed', s: 'customer · brand' },
    { id: 'console', b: 'Console', s: 'the team' },
    { id: 'api', b: 'API', s: 'Netlify Functions' },
    { id: 'job', b: 'Job', s: 'background' },
    { id: 'graph', b: 'LangGraph', s: 'post · ask graphs' },
    { id: 'code', b: 'Search · table', s: 'code, no model' },
    { id: 'models', b: 'Groq · Jina', s: 'AI models' },
    { id: 'blobs', b: 'Blobs', s: 'storage' },
  ];
  var LI = {};
  LANES.forEach(function (l, i) { LI[l.id] = i; });
  var PATH = 'data', STEPS = [], CUR = 0, TIMER = null;

  function renderSeq(steps) {
    var h = '<div class="lifelines">' + LANES.map(function (l, i) { return '<i data-l="' + i + '"></i>'; }).join('') + '</div>';
    h += LANES.map(function (l, i) { return '<div class="lane" data-l="' + i + '" style="grid-row:1;grid-column:' + (i + 1) + '"><b>' + l.b + '</b><span>' + l.s + '</span></div>'; }).join('');
    steps.forEach(function (st, k) {
      var r = k + 2, a = LI[st.from], b = LI[st.to];
      h += '<div class="rowbg" data-k="' + k + '" style="grid-row:' + r + '"></div>';
      var aria = ' aria-label="Step ' + (k + 1) + ': ' + esc(st.title) + '"';
      if (a === b) {
        var c0 = a - 1 < 0 || a + 1 >= LANES.length ? a : a - 1;
        var c1 = a - 1 < 0 || a + 1 >= LANES.length ? a : a + 1;
        h += '<button type="button" class="msg self" data-k="' + k + '"' + aria + ' style="grid-row:' + r + ';grid-column:' + (c0 + 1) + ' / ' + (c1 + 2) + '"><span class="box"><span class="nb">' + (k + 1) + '</span>' + st.label + '</span></button>';
      } else {
        var lo = Math.min(a, b), hi = Math.max(a, b);
        h += '<button type="button" class="msg ' + (b > a ? 'right' : 'left') + '" data-k="' + k + '"' + aria + ' style="grid-row:' + r + ';grid-column:' + (lo + 1) + ' / ' + (hi + 2) + ';--span:' + (hi - lo + 1) + '"><span class="lbl"><span class="tx"><span class="nb">' + (k + 1) + '</span>' + st.label + '</span></span><span class="ln"><span class="dot"></span></span></button>';
      }
    });
    $('#seq').innerHTML = h;
  }
  $('#seq').addEventListener('click', function (e) {
    var m = e.target.closest('.msg');
    if (!m) return;
    stopPlay();
    setStep(+m.getAttribute('data-k'));
  });

  function setStep(k) {
    if (!STEPS.length) return;
    CUR = Math.max(0, Math.min(STEPS.length - 1, k));
    $$('#seq .msg').forEach(function (m, i) { m.classList.toggle('past', i < CUR); m.classList.toggle('on', i === CUR); });
    $$('#seq .rowbg').forEach(function (m, i) { m.classList.toggle('on', i === CUR); });
    var on = $('#seq .msg[data-k="' + CUR + '"] .dot');
    if (on) { on.style.animation = 'none'; void on.offsetWidth; on.style.animation = ''; }
    var st = STEPS[CUR];
    var hot = [LI[st.from], LI[st.to]];
    $$('#seq .lane').forEach(function (l) { l.classList.toggle('hot', hot.indexOf(+l.getAttribute('data-l')) >= 0); });
    $$('#seq .lifelines i').forEach(function (l) { l.classList.toggle('hot', hot.indexOf(+l.getAttribute('data-l')) >= 0); });
    $('#insp-step').textContent = 'Step ' + (CUR + 1) + ' of ' + STEPS.length;
    $('#insp-title').innerHTML = st.title;
    $('#insp-where').innerHTML = (st.where || []).join('');
    $('#insp-text').innerHTML = st.text || '';
    var live = '';
    try { live = st.live ? st.live() : ''; } catch (err) { live = '<p class="note">This step could not be shown: ' + esc(err.message) + '</p>'; }
    $('#insp-live').innerHTML = live;
    $('#b-prev').disabled = CUR === 0;
    $('#b-next').disabled = CUR === STEPS.length - 1;
    mem.set('ape-step-' + PATH, String(CUR));
  }
  function where(fromTo, extra, prod) {
    var out = ['<span class="chip mono">' + esc(fromTo) + '</span>'];
    (extra || []).forEach(function (x) { out.push('<span class="chip mono ghost">' + esc(x) + '</span>'); });
    if (prod) out.push('<span class="prod">' + esc(prod) + '</span>');
    return out;
  }
  function stopPlay() { if (TIMER) { clearInterval(TIMER); TIMER = null; } $('#b-play').textContent = 'Play'; }
  function play() {
    if (TIMER) { stopPlay(); return; }
    if (CUR >= STEPS.length - 1) setStep(0);
    $('#b-play').textContent = 'Pause';
    TIMER = setInterval(function () { if (CUR >= STEPS.length - 1) { stopPlay(); return; } setStep(CUR + 1); }, 3200);
  }
  $('#b-prev').addEventListener('click', function () { stopPlay(); setStep(CUR - 1); });
  $('#b-next').addEventListener('click', function () { stopPlay(); setStep(CUR + 1); });
  $('#b-play').addEventListener('click', play);
  document.addEventListener('keydown', function (e) {
    if (current !== 'paths' || e.altKey || e.ctrlKey || e.metaKey) return;
    var tag = (e.target && e.target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag) || (e.target && e.target.getAttribute && e.target.getAttribute('role') === 'tab')) return;
    if (e.key === 'ArrowRight') { stopPlay(); setStep(CUR + 1); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { stopPlay(); setStep(CUR - 1); e.preventDefault(); }
  });

  // ---------- path 1: the data ----------
  var D = X.dataInfo();
  var rawOf = function (col) { var x = D.sampleRaw.filter(function (r) { return r.column === col; })[0]; return x ? x.value : ''; };
  var SYN = {
    store_id: 'shop_id, outlet_id, pos_id', store_name: 'store, shop, outlet, pos', store_type: 'channel, outlet_type', area: 'district, neighborhood, zone', city: 'governorate, town', region: 'region',
    sku: 'item_code, barcode', product_name: 'product, item, item_name', category: 'product_category, family', pack_size: 'size, pack, weight', qty: 'quantity, qty, units', status: 'status, availability, in_stock',
    price: 'price, shelf_price, unit_price', date: 'date, visit_date, updated_at', rep: 'rep, salesman, merchandiser',
  };
  var REQUIRED = { store_name: 1, product_name: 1, area: 1, city: 1, date: 1, status: 1, qty: 1 };
  var TYPE_ORDER = [['product', 'products'], ['store', 'shops'], ['area', 'areas'], ['city', 'cities'], ['category', 'categories'], ['region', 'regions']];

  function charStrip(vec, w, h, color) {
    var cols = 32, cell = w / cols, rows = 16, s = '';
    var max = Math.max.apply(null, vec) || 1;
    for (var i = 0; i < 512; i++) {
      var x = (i % cols) * cell, y = Math.floor(i / cols) * (h / rows);
      var v = vec[i];
      s += '<rect x="' + fx(x + 0.6, 1) + '" y="' + fx(y + 0.6, 1) + '" width="' + fx(cell - 1.2, 1) + '" height="' + fx(h / rows - 1.2, 1) + '" rx="1.5" fill="' + (v > 0 ? color : 'var(--band)') + '"' + (v > 0 ? ' opacity="' + fx(0.35 + (0.65 * v) / max, 2) + '"' : '') + '/>';
    }
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" style="max-width:' + w + 'px;display:block" role="img" aria-label="512 slots; the coloured ones are used">' + s + '</svg>';
  }

  function dataSteps() {
    var range = day(D.meta.date_min) + ' – ' + day(D.meta.date_max) + ' ' + D.meta.date_max.slice(0, 4);
    return [
      {
        from: 'console', to: 'api', label: '<span class="k">POST /api/data</span>', title: "Upload the reps' file",
        where: where('Console → API', ['POST /api/data']),
        text: "Someone on the team uploads the CSV on the console's Data page. Until then the site uses the sample file from the brief, which is what this page loaded.",
        live: function () {
          return '<div class="mini"><div class="row"><span class="chip mono accent">' + esc(D.fileName) + '</span><span class="small muted">' + D.rawRows + ' rows · ' + D.headers.length + ' columns</span></div><div class="presets">' + D.headers.map(function (h) { return '<span class="chip mono ghost">' + esc(h) + '</span>'; }).join('') + '</div></div>' +
            kv([['shops', String(D.meta.stores)], ['products', D.meta.products + ' (' + D.meta.skus + ' SKUs)'], ['areas · cities', D.meta.areas + ' · ' + D.meta.cities], ['visits', range]]);
        },
      },
      {
        from: 'api', to: 'api', label: 'find the columns', title: 'Find the columns',
        where: where('API', ['ingest.ts · mapHeaders']),
        text: 'Each column is matched by its name or a known synonym, so a file that says shop or outlet instead of store_name still works. A file needs a shop, a product, an area or city, a visit date, and a status or a quantity.',
        live: function () {
          var fields = ['store_name', 'product_name', 'area', 'city', 'date', 'status', 'qty', 'price', 'pack_size', 'sku', 'category', 'region', 'store_id', 'store_type', 'rep'];
          return '<div class="tbl-wrap"><table class="t"><tr><th>Field</th><th>Column in this file</th><th>Also accepted</th></tr>' + fields.map(function (f) {
            var i = D.headerMap[f];
            return '<tr><td class="mono">' + f + (REQUIRED[f] ? ' <span class="muted">*</span>' : '') + '</td><td class="mono">' + (i === undefined ? '<span class="muted">none</span>' : esc(D.headers[i])) + '</td><td class="small muted">' + esc(SYN[f] || '') + '</td></tr>';
          }).join('') + '</table></div><p class="small muted">* needed: area or city, and status or quantity.</p>';
        },
      },
      {
        from: 'api', to: 'api', label: 'clean every row', title: 'Clean every row',
        where: where('API', ['ingest.ts · parseDate, parseStatus']),
        text: 'Dates are read day first, as they are written in Jordan. The status comes from the availability column, or from the quantity when it is missing (0 is out, 1 to 5 is low). Names get normalized keys, so different spellings meet.',
        live: function () {
          var c = D.sampleClean;
          var rows = [
            ['last_updated', rawOf('last_updated'), 'date', c.date],
            ['availability_status', rawOf('availability_status'), 'status', c.status],
            ['quantity_on_shelf', rawOf('quantity_on_shelf'), 'qty', String(c.qty)],
            ['shelf_price_jod', rawOf('shelf_price_jod'), 'price', String(c.price)],
            ['store_id', rawOf('store_id'), 'store_key', c.store_key],
            ['area', rawOf('area'), 'area_key', c.area_key],
            ['product_name', rawOf('product_name'), 'product_key', c.product_key],
          ];
          return '<p class="small muted">One real row: ' + esc(c.store_name) + ', ' + esc(c.product_name) + '.</p><div class="tbl-wrap"><table class="t"><tr><th>Column</th><th>In the file</th><th>Field</th><th>Clean value</th></tr>' +
            rows.map(function (r) { return '<tr><td class="mono small">' + r[0] + '</td><td class="mono">' + esc(r[1]) + '</td><td class="mono small">' + r[2] + '</td><td class="mono">' + esc(r[3]) + '</td></tr>'; }).join('') + '</table></div>';
        },
      },
      {
        from: 'api', to: 'api', label: 'keep the latest visit', title: 'Keep the latest visit',
        where: where('API', ['ingest.ts · buildDataset']),
        text: "If a shop and SKU appear more than once, only the newest visit is kept, so an old in-stock row never outlives a newer out-of-stock one.",
        live: function () {
          return '<div class="split"><div class="mini"><span class="label">rows read</span><h4 class="num">' + D.rawRows + '</h4></div><div class="mini"><span class="label">shop + SKU seen twice</span><h4 class="num">' + D.repeatedKeys + '</h4></div><div class="mini"><span class="label">rows kept</span><h4 class="num">' + D.kept + '</h4></div></div>' +
            '<div class="formula">key = store_key | sku   →   keep the row with the latest date</div>' +
            '<p class="note plain">In the sample every shop and SKU appears once, so all ' + D.kept + ' rows are kept. A later upload with newer visits replaces the older rows.</p>';
        },
      },
      {
        from: 'api', to: 'api', label: 'build the catalog · ' + S.entries + ' entries', title: 'Build the catalog',
        where: where('API', ['ingest.ts · buildEntries', 'aliases.ts']),
        text: 'From the clean table comes one catalog entry per product, shop, area, city, category and region. Each carries its English name, an Arabic name and the other ways people write it. These entries are what search can match.',
        live: function () {
          var o = D.olive;
          return bars(D.byType, TYPE_ORDER) + '<p class="small muted">' + S.entries + ' entries. One of them:</p>' + code(J({ id: o.id, name: o.name, name_ar: o.name_ar, aliases: o.aliases, meta: { category: o.meta.category, packs: o.meta.packs } }));
        },
      },
      {
        from: 'api', to: 'code', label: 'write every name · ' + S.docs, title: 'Write every name',
        where: where('API → Search', ['search.ts · buildAliasDocs']),
        text: 'Every name and alias becomes a small document, ' + S.docs + ' in all. Each is normalized (hamza forms, taa marbuta, diacritics) and loses filler words such as وين or متوفر.',
        live: function () {
          return bars(D.docsByType, TYPE_ORDER) + '<p class="small muted">The ' + D.oliveDocs.length + ' documents of ' + esc(D.olive.name) + ':</p><div class="tbl-wrap"><table class="t"><tr><th>Name</th><th>Normalized</th><th>Words kept</th></tr>' +
            D.oliveDocs.map(function (d) { return '<tr><td>' + t(d.text) + '</td><td>' + t(d.norm) + '</td><td>' + d.toks.map(function (x) { return '<span class="chip mono">' + t(x) + '</span>'; }).join(' ') + '</td></tr>'; }).join('') + '</table></div>';
        },
      },
      {
        from: 'code', to: 'models', label: 'index three ways · Jina: ' + S.docs + ' names in 1 call', title: 'Index each name three ways',
        where: where('Search → Jina', ['BM25', 'character vectors', 'jina-embeddings-v5-text-small']),
        text: 'BM25 counts shared words and weighs rare ones higher. A character vector hashes 2 to 4-letter pieces into 512 slots, so a typo stays close. Jina turns each name into 256 numbers that carry meaning, so olive oil and زيت زيتون meet. All ' + S.docs + ' names go to Jina in one call.',
        live: function () {
          var b = D.bm25, ce = D.charExample;
          var pieces = [];
          ce.words.forEach(function (w) { w.pieces.forEach(function (p) { pieces.push(p); }); });
          return '<div class="mini"><h4>1 · BM25 on the words</h4><p class="small body">' + b.N + ' names, ' + fx(b.avgLen, 2) + ' words on average. A word found in fewer names weighs more:</p><div class="tbl-wrap"><table class="t"><tr><th>Word</th><th class="r">In names</th><th class="r">Weight (idf)</th></tr>' +
            b.examples.map(function (e) { return '<tr><td>' + t(e.term) + '</td><td class="r">' + e.df + '</td><td class="r">' + fx(e.idf, 2) + '</td></tr>'; }).join('') + '</table></div><div class="formula">idf = ln(1 + (N − df + 0.5) / (df + 0.5))</div></div>' +
            '<div class="mini"><h4>2 · Character vector of ' + t('زيت زيتون') + '</h4><p class="small body">' + ce.words.map(function (w) { return '<span class="chip mono">' + t(w.padded) + '</span>'; }).join(' ') + ' → ' + pieces.length + ' pieces → ' + ce.nonzero + ' of 512 slots used</p>' +
            '<div class="presets">' + pieces.slice(0, 12).map(function (p) { return '<span class="chip mono ghost">' + t(p.p) + ' → ' + p.slot + '</span>'; }).join('') + '<span class="small muted">…</span></div>' + charStrip(ce.vec, 352, 176, 'var(--accent)') + '</div>' +
            '<div class="mini"><h4>3 · Jina vector</h4><p class="small body">Not run on this page (it needs the API key). On Netlify, one request sends all ' + S.docs + ' names; each comes back as 1,024 numbers, the first 256 are kept and normalized, and they are stored with the index (' + Math.round(D.sizes.vectorBytes / 1024) + ' KB as Float32, about ' + Math.round(D.sizes.vectorBase64 / 1024) + ' KB as base64).</p></div>';
        },
      },
      {
        from: 'api', to: 'blobs', label: 'save rows, catalog and index', title: 'Save it in Netlify Blobs',
        where: where('API → Blobs', ['catalog store · key "dataset"']),
        text: 'The clean table, the catalog and the index are saved as one object. This is the vector store: at ' + S.docs + ' names, one object in Blobs is enough, loaded into memory when a function starts. BM25 statistics and character vectors are rebuilt on load; only the Jina vectors are stored.',
        live: function () {
          var m = D.meta;
          return code(J({
            meta: { file_name: m.file_name, row_count: m.row_count, stores: m.stores, products: m.products, date_min: m.date_min, date_max: m.date_max },
            rows: [{ __c: '… ' + D.sizes.rows + ' clean rows' }],
            entries: [{ __c: '… ' + D.sizes.entries + ' catalog entries' }],
            index: { version: 1, docs: [{ __c: '… ' + D.sizes.docs + ' names: entryId, type, text, norm, toks' }], semantic: { model: 'jina-embeddings-v5-text-small', dims: 256, vecs: [{ __c: '… ' + D.sizes.docs + ' base64 Float32 vectors' }] } },
          })) + '<p class="note plain">The same store also keeps the uploaded CSV and its summary. With hundreds of thousands of names, this object would move to a vector database such as Postgres with pgvector, with the same hybrid search.</p>';
        },
      },
    ];
  }

  // ---------- path 2: a post ----------
  var PR = null;
  var postSel = $('#post-seed'), capBox = $('#post-caption');
  postSel.innerHTML = X.sample.posts.map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.summary) + '</option>'; }).join('');
  postSel.value = 'post-tahini-halawa';
  function seedPost(id) { return X.sample.posts.filter(function (p) { return p.id === id; })[0]; }
  capBox.value = seedPost('post-tahini-halawa').caption;
  postSel.addEventListener('change', function () { var p = seedPost(postSel.value); if (p) capBox.value = p.caption; });
  $('#run-post').addEventListener('submit', function (e) { e.preventDefault(); runPostNow().then(function () { refreshCommentPosts(); setPath('post', { step: 4 }); }); });
  function runPostNow() {
    var cap = capBox.value.trim() || seedPost('post-tahini-halawa').caption;
    return X.runPost(cap).then(function (r) { PR = r; if (current === 'graph') renderGraphView(); });
  }
  function upd(R, node) { return R.updates.filter(function (u) { return u.node === node; })[0]; }
  function callsOf(R, node) { return R.calls.filter(function (c) { return c.node === node; }); }

  function callBlock(c) {
    var rows = c.matches.slice(0, 3).map(function (m) {
      return '<tr><td>' + t(m.alias) + '</td><td>' + esc(m.entry.name) + ' <span class="muted small">' + esc(m.entry.type) + '</span></td><td class="r num">' + fx(m.conf, 2) + '</td></tr>';
    }).join('');
    return '<div class="mini"><div class="row" style="justify-content:space-between"><span>' + t(c.mention) + ' <span class="small muted">among ' + typesLabel(c.types) + '</span></span>' + decPill(c.status) + '</div>' +
      '<div class="tbl-wrap"><table class="t"><tr><th>Closest name</th><th>Catalog entry</th><th class="r">Conf.</th></tr>' + (rows || '<tr><td colspan="3" class="muted">No name close enough</td></tr>') + '</table></div>' +
      '<div><button type="button" class="btn" data-lab="' + esc(c.mention) + '" data-scope="' + (c.types.indexOf('product') >= 0 ? 'prod' : 'place') + '">See every number in the search lab</button></div></div>';
  }

  function postSteps(R) {
    var spot = upd(R, 'spot_products'), link = upd(R, 'link_catalog'), save = upd(R, 'save_context'), read = upd(R, 'read_post');
    var ctx = R.ctx || { products: [] };
    return [
      {
        from: 'feed', to: 'api', label: '<span class="k">POST /api/posts</span> · image + caption', title: 'The brand publishes a post',
        where: where('Feed → API', ['POST /api/posts']),
        text: 'A post is an image and a caption. Most comments under it will not name the product, so the post is read once, now.',
        live: function () { return '<div class="comment">' + avatar(BRAND) + '<div class="bubble"><p class="who">' + t(BRAND.name) + '</p><p class="txt" dir="auto">' + esc(R.post.caption) + '</p></div></div>'; },
      },
      {
        from: 'api', to: 'blobs', label: 'image · post · context pending', title: 'Saved, with its context pending',
        where: where('API → Blobs', ['media: img/<id>', 'social: posts/<id>', 'social: postctx/<id>']),
        text: 'The image goes to the media store and the post to the social store. A context record starts as pending, so a comment that arrives early waits briefly for it.',
        live: function () { return code(J({ 'posts/post-…': { id: 'post-…', caption: R.post.caption.slice(0, 48) + '…', image: '/api/media/post-…' }, 'postctx/post-…': { status: 'pending', products: [] } })); },
      },
      {
        from: 'api', to: 'job', label: 'start analyze-post · <span class="k">202</span>', title: 'A background job starts',
        where: where('API → Job', ['analyze-post-background']),
        text: 'The API answers 202 at once and a background function does the work, for up to 15 minutes. Nobody waits on the model.',
        live: function () { return '<ol class="steps-ol"><li>The feed gets 202 Accepted and shows the post.</li><li>analyze-post-background compiles the post graph and runs it.</li><li>If it fails, the context is marked failed and the team can relink the products by hand.</li></ol>'; },
      },
      {
        from: 'job', to: 'graph', label: '<span class="k">read_post</span>', title: 'read_post · load the caption',
        where: where('Job → LangGraph', ['post graph · node 1']),
        text: 'The first node loads the post. The image is sent only to a model that can see images; gpt-oss-120b reads text only, so on Groq it is the caption.',
        live: function () { return '<p class="note">' + esc(read ? read.out.note : '') + '</p>'; },
      },
      {
        from: 'graph', to: 'models', label: '<span class="k">spot_products</span> · Groq', title: 'spot_products · which products are in it?',
        where: where('LangGraph → Groq', ['POST_SCHEMA'], 'on this page: rules'),
        text: 'On Netlify, Groq lists the products and pack sizes as JSON that must fit a schema. Here the backend\'s rules read the caption instead: they look up windows of 3, 2 and 1 words with the hybrid search and keep confident, non-overlapping hits.',
        live: function () {
          var sp = spot ? spot.out.spotted || [] : [];
          return '<div class="mini"><span class="label">Found in the caption</span><div class="presets">' + (sp.length ? sp.map(function (s) { return '<span class="chip accent">' + esc(s.name) + '</span>'; }).join('') : '<span class="muted">No known product</span>') + '</div><p class="small muted">' + callsOf(R, 'spot_products').length + ' word windows were looked up.</p></div>' +
            '<details><summary class="small">The JSON schema Groq must follow</summary>' + code(J(X.schemas.POST_SCHEMA)) + '</details>';
        },
      },
      {
        from: 'graph', to: 'code', label: '<span class="k">link_catalog</span> · hybrid search', title: 'link_catalog · tie each name to the catalog',
        where: where('LangGraph → Search', ['products only', 'keep at ≥ ' + C.ACCEPT]),
        text: 'Each spotted name goes through the same hybrid search, over the 27 products only. A link is kept only at confidence ' + C.ACCEPT + ' or more.',
        live: function () { var cs = callsOf(R, 'link_catalog'); return cs.length ? cs.map(callBlock).join('') : '<p class="muted">Nothing to link.</p>'; },
      },
      {
        from: 'graph', to: 'blobs', label: '<span class="k">save_context</span>', title: 'save_context · store the links with the post',
        where: where('LangGraph → Blobs', ['social: postctx/<id>']),
        text: 'The links are saved with the post. The team can correct them on the console\'s Posts page.',
        live: function () { return code(J({ status: 'done', products: ctx.products.map(function (p) { return { id: p.id, name: p.name, name_ar: p.name_ar, pack: p.pack, source: p.source, conf: p.conf }; }), by: ctx.by })) + '<p class="note">' + esc(save ? save.out.note : '') + '</p>'; },
      },
      {
        from: 'blobs', to: 'graph', label: 'later: comments read the links', title: 'Comments under the post use it',
        where: where('Blobs → LangGraph', ['ask graph · load_context']),
        text: 'When a comment arrives, load_context reads these links, so “وين بلاقيه؟” means this post\'s product. The post text is not put in the index; the post only points to catalog entries.',
        live: function () { return '<div><button type="button" class="btn primary" id="ask-under">Ask “وين بلاقيه؟” under this post</button></div>'; },
      },
    ];
  }

  // ---------- path 3: a comment ----------
  var AR_ = null;
  var cPost = $('#c-post'), cText = $('#c-text'), cPresets = $('#c-presets');
  var cPersona = 'ahmad', cChoice = null;
  function refreshCommentPosts() {
    var keep = cPost.value || 'post-olive-oil';
    var opts = X.sample.posts.map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.summary) + '</option>'; });
    if (PR) opts.push('<option value="post-explorer">Your post from path 2</option>');
    cPost.innerHTML = opts.join('');
    cPost.value = keep;
    if (!cPost.value) cPost.value = 'post-olive-oil';
    renderPresets();
  }
  function renderPresets() {
    var p = seedPost(cPost.value);
    var list = p ? p.comments : [];
    cPresets.innerHTML = '<span class="label">Comments from the demo</span>' + list.map(function (c) { return '<button type="button" class="chip" data-text="' + esc(c.text) + '" data-persona="' + esc(c.persona) + '" dir="auto">' + esc(c.text) + '</button>'; }).join('') +
      (list.length ? '' : '<button type="button" class="chip" data-text="وين بلاقيه؟" data-persona="sara" dir="auto">وين بلاقيه؟</button>');
  }
  cPost.addEventListener('change', renderPresets);
  cPresets.addEventListener('click', function (e) {
    var b = e.target.closest('[data-text]');
    if (!b) return;
    cText.value = b.getAttribute('data-text');
    cPersona = b.getAttribute('data-persona') || 'ahmad';
    cChoice = null;
    runCommentNow().then(function () { setPath('comment', { step: 0 }); });
  });
  cText.addEventListener('input', function () { cPersona = 'ahmad'; cChoice = null; });
  $('#run-comment').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!cText.value.trim()) { cText.focus(); return; }
    cChoice = null;
    runCommentNow().then(function () { setPath('comment', { step: 0 }); });
  });
  function runCommentNow() {
    var input = { postId: cPost.value || 'post-olive-oil', text: cText.value.trim() || 'وين بلاقيه؟', personaId: cPersona, choice: cChoice };
    return X.runAsk(input).then(function (r) {
      AR_ = r;
      AR_.choice = cChoice;
      AR_.prompts = X.promptsOf(r);
      if (current === 'graph') renderGraphView();
    });
  }

  function answerBlock(a) {
    var steps = a.steps.map(function (s) {
      return '<span class="chip">' + (s.place ? esc(s.place.name) + ' <span class="muted small">' + esc(s.place.type) + '</span>' : 'Jordan <span class="muted small">whole country</span>') + ' · ' + s.available + ' of ' + s.stores + ' on the shelf</span>';
    }).join(' <span class="muted">→</span> ');
    var named = a.requested || a.available.length <= 3 ? a.available.slice(0, 3) : [];
    var shops = named.map(function (l) {
      return '<tr><td>' + t(l.store_name_ar) + '<br><span class="small muted">' + esc(l.store_name) + ' · ' + esc(l.area) + '</span></td><td>' + stPill(l.best) + '</td><td class="num">' + day(l.date) + '</td></tr>';
    }).join('');
    var cities = !a.requested && a.available.length > 3 ? '<p class="small body">No place given and ' + a.available.length + ' shops have it, so the reply gives the top cities and asks for the area: ' + a.by_city.slice(0, 3).map(function (c) { return esc(c.city) + ' (' + c.stores + ')'; }).join(', ') + '.</p>' : '';
    var pack = a.pack_asked ? '<p class="small body">Size asked: ' + t(a.pack_asked) + (a.pack ? ' → ' + esc(a.pack.pack) : a.pack_missing ? ' → not a size we make' : '') + '</p>' : '';
    return '<div class="mini"><h4>' + esc(a.product.name) + ' · ' + t(a.product.name_ar) + '</h4><div class="row">' + steps + '</div>' +
      (a.widened ? '<p class="small body">Nothing on the shelf in ' + esc(a.requested.name) + ' at the last visit, so the scope widened to ' + (a.used ? esc(a.used.name) : 'the whole country') + '.</p>' : '') + pack + cities +
      (shops ? '<div class="tbl-wrap"><table class="t"><tr><th>Shop named in the reply</th><th>Status</th><th>Visit</th></tr>' + shops + '</table></div>' : '') +
      (named.length && a.available.length > named.length ? '<p class="small muted">+ ' + (a.available.length - named.length) + ' more shop(s) with it on the shelf</p>' : '') + '</div>';
  }

  function draftCard(R, withActions) {
    var d = R.draft;
    var acts = '';
    if (withActions) {
      if (d.status === 'needs_choice' && d.options && d.options.items.length) acts = '<span class="small muted">Pick one:</span>' + d.options.items.map(function (o) { return '<button type="button" class="btn" data-choice="' + esc(o.id) + '" data-slot="' + esc(d.options.slot) + '">' + esc(o.label) + ' · ' + t(o.label_ar) + '</button>'; }).join('');
      else if (d.status === 'no_reply') acts = '<span class="btn" aria-disabled="true">Dismiss</span>';
      else if (d.status === 'needs_human') acts = '<span class="btn" aria-disabled="true">Assign to a colleague</span><span class="btn" aria-disabled="true">Edit</span>';
      else acts = '<span class="btn primary" aria-disabled="true">Reply now</span><span class="btn" aria-disabled="true">Edit</span>';
    }
    return '<div class="mini">' + bubble(R.persona, R.comment.text) + '<div class="row" style="justify-content:space-between"><span class="label">Draft</span>' + statusPill(d.status) + '</div>' +
      '<p class="txt" dir="auto" style="white-space:pre-wrap">' + (d.text ? esc(d.text) : '<span class="muted">Nothing to send.</span>') + '</p>' + (acts ? '<div class="row">' + acts + '</div>' : '') + '</div>';
  }

  var NODE_LANE = { load_context: 'blobs', understand_comment: 'models', find_entities: 'code', check_shelves: 'code', write_answer: 'models' };
  var NODE_LABEL = {
    load_context: 'comment, post, post products', understand_comment: 'read it · Groq', find_entities: 'hybrid search', check_shelves: 'filter the table',
    write_answer: 'write from facts · Groq', fact_check: 'check every fact', ask_clarify: 'ask which one', write_courtesy: 'a short thanks', hand_off: 'holding reply', no_reply: 'nothing to answer', assemble_draft: 'build the draft',
  };

  function nodeStep(u, R) {
    var s = R.state, n = u.node, o = u.out;
    var base = { from: 'graph', to: NODE_LANE[n] || 'graph', label: '<span class="k">' + n + '</span> · ' + NODE_LABEL[n] };
    if (n === 'load_context') return Object.assign(base, {
      title: 'load_context · what is this about?', where: where('LangGraph → Blobs', ['social: comments, posts, postctx']),
      text: 'Loads the comment, its post, and the products the post graph linked when the post was published. That is how “وين بلاقيه؟” gets a product.',
      live: function () { var ps = (R.ctx && R.ctx.products) || []; return '<div class="mini"><span class="label">Products linked to the post</span><div class="presets">' + (ps.length ? ps.map(function (p) { return '<span class="chip accent">' + esc(p.name) + ' · ' + t(p.name_ar) + '</span>'; }).join('') : '<span class="muted">none</span>') + '</div></div>'; },
    });
    if (n === 'understand_comment') return Object.assign(base, {
      title: 'understand_comment · what does the customer want?', where: where('LangGraph → Groq', ['UNDERSTAND_SCHEMA'], 'on this page: rules'),
      text: 'On Netlify, Groq reads the comment with the post\'s caption and products and the known product and place names, and must answer with JSON that fits a strict schema. Here the backend\'s rules read it: intent words first, then the same word-window lookup as for posts.',
      live: function () {
        var x = s.understanding || {};
        var typo = /زيتوون/.test(R.comment.text) ? '<p class="note">Groq\'s instructions include fixing this exact typo (' + t('زيتوون') + ' → ' + t('زيتون') + '), so it would send ' + t('زيت زيتون') + ', an exact name. The rules matched the word ' + t('زيت') + ', the oil category; the next node turns that into the post\'s olive oil.</p>' : '';
        return kv([
          ['intent', '<b>' + esc(x.intent) + '</b>' + (x.wants_price ? ' · asks the price' : '')],
          ['products', x.products && x.products.length ? chips(x.products, 'accent') : '<span class="muted">none named</span>'],
          ['places', x.locations && x.locations.length ? chips(x.locations, 'accent') : '<span class="muted">none</span>'],
          ['shops', x.stores && x.stores.length ? chips(x.stores, 'accent') : '<span class="muted">none</span>'],
          ['read by', esc(x.by === 'ai' ? 'Groq' : 'rules') + ' · ' + esc(x.reason || '')],
        ]) + typo + '<p class="small muted">The rules looked up ' + callsOf(R, 'understand_comment').length + ' word windows.</p>' +
          '<details><summary class="small">The prompt Groq gets for this comment</summary>' + code(esc(R.prompts.understand.system) + '\n\n' + esc(R.prompts.understand.user)) + '</details>' +
          '<details><summary class="small">The JSON schema its answer must fit</summary>' + code(J(X.schemas.UNDERSTAND_SCHEMA)) + '</details>';
      },
    });
    if (n === 'find_entities') return Object.assign(base, {
      title: 'find_entities · which product, which place?', where: where('LangGraph → Search', ['BM25 + characters + Jina', 'decide()']),
      text: 'Each product word and place word goes through the hybrid search, and decide() says: a clear match, a choice to ask, or nothing. A category such as زيت takes the post\'s product; a shop beats an area, and an area beats a city. On Netlify the words are also embedded by Jina for the third ranking.',
      live: function () {
        var cs = callsOf(R, 'find_entities');
        var res = '<div class="mini"><span class="label">Result</span>' + kv([
          ['products', s.products && s.products.length ? s.products.map(function (p) { return '<span class="chip accent">' + esc(p.name) + '</span>'; }).join(' ') : '<span class="muted">none</span>'],
          ['place', s.place ? esc(s.place.name) + ' <span class="muted small">' + esc(s.place.type) + '</span>' : '<span class="muted">none given</span>'],
          ['choice needed', s.clarify ? 'yes · ' + esc(s.clarify.slot) + ': ' + (s.clarify.options.map(function (x) { return esc(x.label); }).join(' / ') || 'open question') : 'no'],
        ]) + '</div>';
        var notes = (o.notes || []).length ? '<ul class="steps-ol">' + o.notes.map(function (x) { return '<li>' + tl(x) + '</li>'; }).join('') + '</ul>' : '';
        return (cs.length ? cs.map(callBlock).join('') : '<p class="muted small">No search was needed.</p>') + res + notes;
      },
    });
    if (n === 'check_shelves') return Object.assign(base, {
      title: 'check_shelves · where is it on the shelf?', where: where('LangGraph → table', ['query.ts · productAnswer', 'no model']),
      text: 'A plain filter on the clean table: each shop\'s latest visit for this product, in the place asked. If none has it on the shelf, the scope widens: area, then city, then region, then the whole country. Shops are sorted by nearness, status, newest visit and quantity.',
      live: function () { return (s.answers || []).map(answerBlock).join('') || '<p class="muted">No product to check.</p>'; },
    });
    if (n === 'write_answer') return Object.assign(base, {
      title: 'write_answer · the reply, from the facts only', where: where('LangGraph → Groq', ['COMPOSE_SCHEMA'], 'on this page: template'),
      text: 'On Netlify, Groq gets the comment and a small JSON of facts: the shops, their visit dates, and prices if asked. It writes in Jordanian Arabic or English and never sees the sheet. Here the template wrote the reply.',
      live: function () {
        return '<div class="mini"><span class="label">Reply (template)</span><p class="txt" dir="auto" style="white-space:pre-wrap">' + esc(o.reply || s.reply) + '</p></div>' +
          (R.prompts.facts ? '<details open><summary class="small">The facts Groq would get, and nothing else</summary>' + code(J(R.prompts.facts)) + '</details>' : '') +
          (R.prompts.compose ? '<details><summary class="small">Its writing instructions</summary>' + code(esc(R.prompts.compose.system)) + '</details>' : '');
      },
    });
    if (n === 'fact_check') return Object.assign(base, {
      title: 'fact_check · every shop, date and price must be in the facts', where: where('LangGraph', ['reply.ts · checkReply']),
      text: 'The reply is checked against the facts: no shop outside them, no date that is not a visit date, no price unless asked, and a visit date must be given. A failed AI reply is replaced by the template.',
      live: function () {
        var ok = !(o.checks && o.checks.length);
        return '<div class="mini"><div class="row"><span class="' + (ok ? 'ok-y' : 'ok-n') + '">' + (ok ? 'Passed' : 'Problems found') + '</span><span class="small muted">' + esc(o.note || '') + '</span></div>' +
          (ok ? '' : '<ul class="steps-ol">' + o.checks.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>') + '</div>' +
          '<ol class="steps-ol"><li>Every shop named must be one of the shops in the facts.</li><li>Every date must be a visit date from the facts.</li><li>A reply that names shops must say when the shelf was checked.</li><li>Numbers that look like prices must be shelf prices, and only when asked.</li></ol>';
      },
    });
    if (n === 'ask_clarify') return Object.assign(base, {
      title: 'ask_clarify · ask which one', where: where('LangGraph', ['template']),
      text: 'The search could not choose, so the reply asks, and the options reach the team as buttons. A pick runs the graph again with that choice.',
      live: function () { return '<div class="mini"><span class="label">Options for the team</span><div class="presets">' + ((s.clarify && s.clarify.options) || []).map(function (x) { return '<span class="chip accent">' + esc(x.label) + ' · ' + t(x.label_ar) + '</span>'; }).join('') + '</div></div><div class="mini"><span class="label">Reply</span><p class="txt" dir="auto">' + esc(o.reply) + '</p></div>'; },
    });
    if (n === 'write_courtesy' || n === 'hand_off' || n === 'no_reply') return Object.assign(base, {
      title: n === 'write_courtesy' ? 'write_courtesy · a short thanks' : n === 'hand_off' ? 'hand_off · a person should answer' : 'no_reply · nothing to answer',
      where: where('LangGraph', [n === 'no_reply' ? 'no text' : 'template, or the model\'s short text']),
      text: n === 'write_courtesy' ? 'A compliment needs no facts. On Netlify the model\'s own short reply is used if it has no numbers, so it cannot promise a price or a date; otherwise the template.' :
        n === 'hand_off' ? 'Complaints and questions the data cannot answer get a holding reply, and the comment is flagged Needs a person.' : 'Tags, emojis and spam need no reply.',
      live: function () { return '<div class="mini"><span class="label">Why</span><p class="body">' + esc((s.understanding && s.understanding.reason) || '') + '</p></div>' + (o.reply ? '<div class="mini"><span class="label">Reply</span><p class="txt" dir="auto">' + esc(o.reply) + '</p></div>' : ''); },
    });
    if (n === 'assemble_draft') return Object.assign(base, {
      title: 'assemble_draft · one record for the console', where: where('LangGraph', ['DraftRec']),
      text: 'Builds the draft the console shows: the text, its status, the products and place, the shops and dates it relied on, the checks, the notes and the trace of every node.',
      live: function () {
        var d = R.draft;
        var basis = (d.basis || []).filter(function (b) { return b.role === 'named'; }).slice(0, 6);
        return '<div class="row"><span class="label">Status</span>' + statusPill(d.status) + '</div>' + kv([
          ['kind', esc(d.kind)], ['understood by', esc(d.understood_by || '')], ['written by', esc(d.written_by || 'nobody')], ['products', esc(d.products.map(function (p) { return p.name; }).join(', ') || 'none')], ['place', d.place ? esc(d.place.name) : 'none'], ['scope', esc(d.scope_note || '')],
        ]) + (basis.length ? '<div class="tbl-wrap"><table class="t"><tr><th>Based on</th><th>Pack</th><th>Status</th><th>Visit</th></tr>' + basis.map(function (b) { return '<tr><td>' + esc(b.store_name) + '</td><td class="mono small">' + esc(b.pack) + '</td><td>' + stPill(b.status) + '</td><td class="num">' + day(b.date) + '</td></tr>'; }).join('') + '</table></div>' : '');
      },
    });
    return Object.assign(base, { title: n, text: '', live: function () { return ''; } });
  }

  function commentSteps(R) {
    var d = R.draft, P = R.persona, postLabel = R.post ? (seedPost(R.post.id) ? seedPost(R.post.id).summary : 'your post') : 'the post';
    var steps = [
      {
        from: 'feed', to: 'api', label: '<span class="k">POST /api/comments</span>', title: 'The customer comments',
        where: where('Feed → API', ['POST /api/comments']),
        text: 'A customer writes under a post. The feed calls the API, the way Meta\'s webhook would on a real page.' + (R.choice ? ' The team then picked an option, so this run has that choice.' : ''),
        live: function () { return bubble(P, R.comment.text) + '<p class="small muted">Under: ' + esc(postLabel) + '</p>'; },
      },
      {
        from: 'api', to: 'blobs', label: 'save comment + empty draft', title: 'Saved, with an empty draft',
        where: where('API → Blobs', ['social: comments/<post>/<id>', 'social: drafts/<id>']),
        text: 'The comment and a placeholder draft are written at once, so the console shows the comment straight away as being drafted.',
        live: function () { return code(J({ 'comments/…': { post_id: R.comment.post_id, author_name: P.name, text: R.comment.text }, 'drafts/…': { status: 'drafting', text: '' } })); },
      },
      {
        from: 'api', to: 'job', label: 'start draft job · <span class="k">202</span>', title: 'A background job starts',
        where: where('API → Job', ['draft-background', 'beats/<job> every 20 s']),
        text: 'The API answers 202 and a background function drafts, for up to 15 minutes. It drafts one comment at a time, waits out Groq\'s per-minute limit when it must, and writes a heartbeat every 20 seconds so the console knows it is alive.',
        live: function () { return '<ol class="steps-ol"><li>0 s · the feed gets 202 Accepted.</li><li>Every 20 s · beats/&lt;job&gt; lists the comments running and queued, and any wait.</li><li>A 429 from Groq · the job waits the time Groq gives, then goes on.</li><li>No heartbeat for 75 s · the console drafts the comment itself.</li></ol>'; },
      },
      {
        from: 'job', to: 'graph', label: 'invoke the ask graph', title: 'The ask graph starts',
        where: where('Job → LangGraph', ['graphs/ask.ts · runAsk']),
        text: 'The job compiles the ask graph and invokes it with the comment\'s ids. Each node reads the shared state and returns only what it changes; notes and the trace are appended.',
        live: function () { return code(J({ post_id: R.comment.post_id, comment_id: R.comment.id, choice: R.choice || null })) + '<p class="small muted">Engine on this page: ' + esc(R.engine) + ' runner (the same definition LangGraph compiles on Netlify). Whole run: ' + fx(R.ms, 1) + ' ms.</p>'; },
      },
    ];
    R.updates.forEach(function (u) { steps.push(nodeStep(u, R)); });
    steps.push({
      from: 'job', to: 'blobs', label: 'save the draft', title: 'The draft is saved',
      where: where('Job → Blobs', ['social: drafts/<id>']),
      text: 'The job writes the finished draft over the placeholder. Its trace and notes travel with it.',
      live: function () { return code(J({ status: d.status, kind: d.kind, text: d.text ? d.text.slice(0, 60) + (d.text.length > 60 ? '…' : '') : '', products: d.products.map(function (p) { return p.name; }), place: d.place ? d.place.name : null, basis: [{ __c: '… ' + d.basis.length + ' shop/pack lines' }], trace: d.trace.map(function (x) { return x.node; }) })); },
    });
    steps.push({
      from: 'console', to: 'api', label: '<span class="k">GET /api/state</span> every 3 s', title: 'The team sees it',
      where: where('Console → API', ['GET /api/state']),
      text: 'The console asks for changes every 3 seconds, so the draft appears within seconds, with “How this draft was made” underneath.',
      live: function () { return draftCard(R, false) + '<details><summary class="small">How this draft was made</summary><ul class="steps-ol">' + d.trace.map(function (x) { return '<li><span class="mono small">' + esc(x.node) + '</span> · ' + tl(x.note || '') + '</li>'; }).join('') + '</ul></details>'; },
    });
    steps.push({
      from: 'console', to: 'console', label: 'a person decides', title: 'A person decides',
      where: where('Console', ['Reply now · Edit · pick · assign']),
      text: d.status === 'needs_choice' ? 'The team picks one option and the graph runs again with that choice. Try it below.' : d.status === 'needs_human' ? 'A colleague takes this one over. The draft is a holding reply they can send or rewrite.' : d.status === 'no_reply' ? 'Nothing to send; the team can dismiss it.' : 'Reply now sends the draft as it is; Edit changes it first. Nothing is posted without a person.',
      live: function () { return draftCard(R, true); },
    });
    if (d.status !== 'no_reply' && d.text) {
      steps.push({
        from: 'console', to: 'api', label: '<span class="k">POST /api/reply</span>', title: 'The reply is saved',
        where: where('Console → API → Blobs', ['social: replies/<id>']),
        text: 'The reply is written to the social store, marked as edited or not, so the share of drafts sent unchanged can be measured.',
        live: function () { return code(J({ comment_id: R.comment.id, text: d.text.slice(0, 60) + (d.text.length > 60 ? '…' : ''), by: 'team', edited: false })); },
      });
      steps.push({
        from: 'api', to: 'feed', label: 'reply shown under the comment', title: 'The reply appears on the feed',
        where: where('API → Feed', ['GET /api/state?view=feed']),
        text: 'The feed reads the replies and shows this one under the comment, in the brand\'s name.',
        live: function () { return bubble(P, R.comment.text) + '<div style="padding-left:44px">' + bubble(BRAND, d.text, 'reply') + '</div>'; },
      });
    }
    return steps;
  }

  // clicks inside the inspector: open the lab, pick an option, ask under a post
  $('#insp-live').addEventListener('click', function (e) {
    var lab = e.target.closest('[data-lab]');
    if (lab) { openLab(lab.getAttribute('data-lab'), lab.getAttribute('data-scope')); return; }
    var ch = e.target.closest('[data-choice]');
    if (ch) {
      cChoice = { slot: ch.getAttribute('data-slot'), id: ch.getAttribute('data-choice') };
      runCommentNow().then(function () { setPath('comment', { step: 4 }); });
      return;
    }
    if (e.target.closest('#ask-under')) {
      refreshCommentPosts();
      cPost.value = 'post-explorer';
      renderPresets();
      cText.value = 'وين بلاقيه؟';
      cPersona = 'sara';
      cChoice = null;
      runCommentNow().then(function () { setPath('comment', { step: 0 }); });
    }
  });

  function setPath(p, opts) {
    PATH = p;
    stopPlay();
    $$('.pp').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-path') === p ? 'true' : 'false'); });
    $('#run-post').hidden = p !== 'post';
    $('#run-comment').hidden = p !== 'comment';
    STEPS = p === 'data' ? dataSteps() : p === 'post' ? postSteps(PR) : commentSteps(AR_);
    renderSeq(STEPS);
    var k = opts && opts.step != null ? opts.step : +(mem.get('ape-step-' + p) || 0);
    setStep(Math.min(k, STEPS.length - 1));
    mem.set('ape-path', p);
  }
  $$('.pp').forEach(function (b) { b.addEventListener('click', function () { setPath(b.getAttribute('data-path'), { step: 0 }); }); });

  // ---------- LangGraph view ----------
  var GRAPH = 'ask', GSEL = null, GTIMER = null;
  var NODE_INFO = {
    load_context: { sub: 'no model', does: 'Loads the comment, its post and the products the post graph linked to it.', reads: ['post_id', 'comment_id'], writes: ['comment', 'post', 'post_ctx'], model: 'None' },
    understand_comment: { sub: 'Groq, or rules', ai: 1, does: 'Reads what the customer wants: the intent, product words, places, shops, a pack size, and whether they ask the price. Groq answers with JSON that must fit a schema; rules take over without a key or when the call fails.', reads: ['comment', 'post', 'post_ctx'], writes: ['understanding', 'model', 'notes'], model: 'Groq · openai/gpt-oss-120b, fallback: rules' },
    find_entities: { sub: 'BM25 · letters · Jina', ai: 1, does: 'Turns each product word and place word into a catalog entry with the hybrid search, then decides: a clear match, a choice to ask, or nothing. A category takes the post\'s product; a shop beats an area, an area beats a city.', reads: ['understanding', 'post_ctx', 'choice', 'comment'], writes: ['products', 'place', 'clarify', 'pack_text', 'notes'], model: 'Jina embeddings + BM25 + character vectors' },
    check_shelves: { sub: 'table filter', does: 'Filters the availability table for each product in the place asked, widening to the city, the region and the whole country only when nothing is on the shelf.', reads: ['products', 'place', 'pack_text'], writes: ['answers'], model: 'None (a filter on the data)' },
    write_answer: { sub: 'Groq, or a template', ai: 1, does: 'Writes the reply from a small JSON of facts (shops, visit dates, prices if asked), never from the sheet. Without a key, a template writes it.', reads: ['understanding', 'answers', 'comment'], writes: ['reply', 'written_by', 'model'], model: 'Groq · openai/gpt-oss-120b, fallback: template' },
    fact_check: { sub: 'rules', does: 'Every shop, date and price in the reply must be in the facts, and a visit date must be given. An AI reply that fails is replaced by the template.', reads: ['reply', 'answers', 'written_by', 'understanding'], writes: ['checks', 'reply', 'written_by'], model: 'None (rules)' },
    ask_clarify: { sub: 'template', does: 'Asks which product or place was meant and puts the options in front of the team.', reads: ['clarify', 'understanding', 'comment'], writes: ['reply', 'written_by', 'kind'], model: 'None (template)' },
    write_courtesy: { sub: 'a short thanks', does: 'A short thank-you. The model\'s own short reply is used only if it holds no numbers.', reads: ['understanding'], writes: ['reply', 'written_by', 'kind'], model: 'The text from understand_comment, or a template' },
    hand_off: { sub: 'needs a person', does: 'A holding reply for complaints and questions the data cannot answer; the comment is flagged for a person.', reads: ['understanding'], writes: ['reply', 'written_by', 'kind'], model: 'The text from understand_comment, or a template' },
    no_reply: { sub: 'nothing to send', does: 'Tags, emojis and spam: nothing to send.', reads: [], writes: ['reply', 'written_by', 'kind'], model: 'None' },
    assemble_draft: { sub: 'the draft record', does: 'Builds the one draft record the console shows: text, status, products, place, the shops and dates used, checks, notes and the trace.', reads: ['every channel'], writes: ['draft', 'kind'], model: 'None' },
    read_post: { sub: 'loads the caption', does: 'Loads the post; sends the image only to a model that can see images. On Groq, the caption.', reads: ['post_id'], writes: ['post', 'image'], model: 'None' },
    spot_products: { sub: 'Groq, or rules', ai: 1, does: 'Lists the products and pack sizes in the post as JSON that fits a schema; rules read the caption without a key or when the call fails.', reads: ['post', 'image'], writes: ['spotted', 'summary', 'by'], model: 'Groq · openai/gpt-oss-120b, fallback: rules' },
    link_catalog: { sub: 'hybrid search · ≥ ' + C.ACCEPT, ai: 1, does: 'Runs each spotted name through the hybrid search over the products and keeps a link at confidence ' + C.ACCEPT + ' or more.', reads: ['spotted', 'by'], writes: ['linked', 'notes'], model: 'Jina embeddings + BM25 + character vectors' },
    save_context: { sub: 'postctx in Blobs', does: 'Saves the links with the post so every comment under it knows what “it” is.', reads: ['linked', 'summary', 'by'], writes: ['ctx'], model: 'None' },
  };
  var ROUTER = {
    load_context: { code: "s.comment ? 'found' : 'missing'", text: 'Is there a comment to answer?' },
    understand_comment: { code: "availability | price → 'find'\npraise → 'thanks'\ncomplaint | other_question → 'person'\ntag_or_chat | spam → 'skip'", text: 'The intent decides the branch.' },
    find_entities: { code: "s.clarify ? 'clarify' : 'answer'", text: 'Did the search leave a choice to ask?' },
    read_post: { code: "s.post ? 'ok' : 'missing'", text: 'Is the post there?' },
  };
  var LAYOUT = {
    ask: {
      vb: [1260, 660],
      nodes: {
        START: [65, 22, 120, 34], load_context: [30, 100, 190, 64], understand_comment: [280, 100, 230, 64], find_entities: [570, 100, 200, 64], check_shelves: [830, 100, 180, 64], write_answer: [1060, 100, 170, 64],
        END_missing: [65, 240, 120, 34], write_courtesy: [310, 236, 200, 52], hand_off: [310, 320, 200, 52], no_reply: [310, 404, 200, 52], ask_clarify: [570, 236, 200, 52], fact_check: [1060, 236, 170, 52],
        assemble_draft: [570, 520, 200, 64], END: [620, 614, 100, 32],
      },
      edges: [
        { from: 'START', to: 'load_context', d: 'M125 56 V100' },
        { from: 'load_context', to: 'understand_comment', key: 'found', d: 'M220 132 H280', lab: [250, 132] },
        { from: 'load_context', to: 'END_missing', key: 'missing', d: 'M125 164 V240', lab: [125, 202] },
        { from: 'understand_comment', to: 'find_entities', key: 'find', d: 'M510 132 H570', lab: [540, 132] },
        { from: 'understand_comment', to: 'write_courtesy', key: 'thanks', d: 'M292 164 V262 H310', lab: [292, 212] },
        { from: 'understand_comment', to: 'hand_off', key: 'person', d: 'M292 164 V346 H310', lab: [292, 304] },
        { from: 'understand_comment', to: 'no_reply', key: 'skip', d: 'M292 164 V430 H310', lab: [292, 388] },
        { from: 'find_entities', to: 'ask_clarify', key: 'clarify', d: 'M670 164 V236', lab: [670, 200] },
        { from: 'find_entities', to: 'check_shelves', key: 'answer', d: 'M770 132 H830', lab: [800, 132] },
        { from: 'check_shelves', to: 'write_answer', d: 'M1010 132 H1060' },
        { from: 'write_answer', to: 'fact_check', d: 'M1145 164 V236' },
        { from: 'fact_check', to: 'assemble_draft', d: 'M1145 288 V552 H770' },
        { from: 'ask_clarify', to: 'assemble_draft', d: 'M670 288 V520' },
        { from: 'write_courtesy', to: 'assemble_draft', d: 'M510 262 H556 V530 H570' },
        { from: 'hand_off', to: 'assemble_draft', d: 'M510 346 H546 V546 H570' },
        { from: 'no_reply', to: 'assemble_draft', d: 'M510 430 H536 V562 H570' },
        { from: 'assemble_draft', to: 'END', d: 'M670 584 V614' },
      ],
    },
    post: {
      vb: [1220, 290],
      nodes: { START: [30, 115, 110, 34], read_post: [190, 100, 200, 64], spot_products: [450, 100, 220, 64], link_catalog: [730, 100, 200, 64], save_context: [990, 100, 190, 64], END_missing: [240, 230, 100, 32], END: [1035, 230, 100, 32] },
      edges: [
        { from: 'START', to: 'read_post', d: 'M140 132 H190' },
        { from: 'read_post', to: 'spot_products', key: 'ok', d: 'M390 132 H450', lab: [420, 132] },
        { from: 'read_post', to: 'END_missing', key: 'missing', d: 'M290 164 V230', lab: [290, 197] },
        { from: 'spot_products', to: 'link_catalog', d: 'M670 132 H730' },
        { from: 'link_catalog', to: 'save_context', d: 'M930 132 H990' },
        { from: 'save_context', to: 'END', d: 'M1085 164 V230' },
      ],
    },
  };
  var SHAPES = X.graphShapes();

  // every edge in the code must be in the drawing (and nothing else)
  (function checkDrawing() {
    ['ask', 'post'].forEach(function (g) {
      var sh = SHAPES[g], L = LAYOUT[g], want = [];
      want.push('START>' + sh.start);
      sh.edges.forEach(function (e) { want.push(e[0] + '>' + (e[1] === 'END' ? 'END' : e[1])); });
      sh.branches.forEach(function (b) { Object.keys(b.map).forEach(function (k) { want.push(b.from + '>' + (b.map[k] === 'END' ? 'END_missing' : b.map[k])); }); });
      var drawn = L.edges.map(function (e) { return e.from + '>' + e.to; });
      var miss = want.filter(function (w) { return drawn.indexOf(w) < 0; }), extra = drawn.filter(function (w) { return want.indexOf(w) < 0; });
      sh.nodes.forEach(function (n) { if (!L.nodes[n]) miss.push('node ' + n); });
      if (miss.length || extra.length) console.warn('Graph drawing differs from the code', g, miss, extra);
    });
  })();

  function edgeId(e) { return e.from + '>' + e.to; }
  function arrowHead(d) {
    var m = d.match(/([MHV])\s*([\d.]+)(?:\s+([\d.]+))?/g), x = 0, y = 0, px = 0, py = 0;
    m.forEach(function (seg) {
      var c = seg[0], nums = seg.slice(1).trim().split(/\s+/).map(Number);
      px = x; py = y;
      if (c === 'M') { x = nums[0]; y = nums[1]; } else if (c === 'H') { x = nums[0]; } else { y = nums[0]; }
    });
    var dx = Math.sign(x - px), dy = Math.sign(y - py), s = 9, w = 5.5;
    if (dx) return 'M' + x + ' ' + y + ' L' + (x - dx * s) + ' ' + (y - w) + ' L' + (x - dx * s) + ' ' + (y + w) + ' Z';
    return 'M' + x + ' ' + y + ' L' + (x - w) + ' ' + (y - dy * s) + ' L' + (x + w) + ' ' + (y - dy * s) + ' Z';
  }
  function runOf(g) { return g === 'ask' ? AR_ : PR; }
  function routeOf(g) {
    var R = runOf(g);
    if (!R) return { nodes: [], edges: [] };
    var nodes = R.updates.map(function (u) { return u.node; });
    var L = LAYOUT[g], edges = [];
    var seq = ['START'].concat(nodes);
    var last = nodes[nodes.length - 1];
    seq.push(last === 'load_context' || (last === 'read_post' && nodes.length === 1) ? 'END_missing' : 'END');
    for (var i = 1; i < seq.length; i++) {
      var e = L.edges.filter(function (x) { return x.from === seq[i - 1] && x.to === seq[i]; })[0];
      if (e) edges.push(edgeId(e));
    }
    return { nodes: nodes, edges: edges };
  }

  function drawGraph(g) {
    var L = LAYOUT[g], route = routeOf(g), h = '';
    L.edges.forEach(function (e) {
      var id = edgeId(e), taken = route.edges.indexOf(id) >= 0, cond = !!e.key;
      h += '<g class="edge' + (cond ? ' cond' : '') + (taken ? ' taken' : '') + (GSEL === 'e:' + id ? ' sel' : '') + '" data-e="' + esc(id) + '" tabindex="0" role="button" aria-label="Edge ' + esc(e.from + ' to ' + e.to + (e.key ? ' when ' + e.key : '')) + '"><path class="hit" d="' + e.d + '"/><path class="v" d="' + e.d + '"/><path class="ah" d="' + arrowHead(e.d) + '"/></g>';
    });
    Object.keys(L.nodes).forEach(function (n) {
      var r = L.nodes[n], x = r[0], y = r[1], w = r[2], hh = r[3];
      var term = /^(START|END)/.test(n);
      var info = NODE_INFO[n] || {};
      var hitAt = route.nodes.indexOf(n);
      var cls = 'node' + (term ? ' term' : '') + (info.ai ? ' ai' : '') + (hitAt >= 0 ? ' hit' : '') + (GSEL === 'n:' + n ? ' sel' : '');
      h += '<g class="' + cls + '" data-n="' + n + '"' + (term ? '' : ' tabindex="0" role="button" aria-label="Node ' + n + '"') + '><rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + hh + '" rx="' + (term ? hh / 2 : 12) + '"/>';
      if (term) h += '<text x="' + (x + w / 2) + '" y="' + (y + hh / 2 + 4.5) + '" text-anchor="middle">' + (n === 'START' ? 'START' : 'END') + '</text>';
      else {
        h += '<text x="' + (x + w / 2) + '" y="' + (y + (hh > 56 ? 28 : 24)) + '" text-anchor="middle">' + n + '</text>';
        h += '<text class="sub" x="' + (x + w / 2) + '" y="' + (y + (hh > 56 ? 48 : 41)) + '" text-anchor="middle">' + esc(info.sub || '') + '</text>';
      }
      if (hitAt >= 0) h += '<g class="badge"><circle cx="' + (x + w - 2) + '" cy="' + (y + 2) + '" r="11"/><text x="' + (x + w - 2) + '" y="' + (y + 6) + '" text-anchor="middle">' + (hitAt + 1) + '</text></g>';
      h += '</g>';
    });
    L.edges.forEach(function (e) {
      if (!e.key) return;
      var id = edgeId(e), taken = route.edges.indexOf(id) >= 0, w = e.key.length * 7.2 + 14;
      h += '<g class="elabel' + (taken ? ' taken' : '') + (GSEL === 'e:' + id ? ' sel' : '') + '" data-e="' + esc(id) + '"><rect x="' + fx(e.lab[0] - w / 2, 1) + '" y="' + (e.lab[1] - 10) + '" width="' + fx(w, 1) + '" height="20" rx="10"/><text x="' + e.lab[0] + '" y="' + (e.lab[1] + 4) + '" text-anchor="middle">' + e.key + '</text></g>';
    });
    $('#gwrap').innerHTML = '<svg class="g" id="gsvg" viewBox="0 0 ' + L.vb[0] + ' ' + L.vb[1] + '" role="group" aria-label="' + (g === 'ask' ? 'The ask graph' : 'The post graph') + '">' + h + '</svg>';
  }

  function summarize(k, v) {
    if (v === null || v === undefined) return '<span class="muted">null</span>';
    if (k === 'comment') return t(v.text);
    if (k === 'post') return esc(v.id);
    if (k === 'post_ctx' || k === 'ctx') return esc((v.products || []).map(function (p) { return p.name; }).join(', ') || 'no products');
    if (k === 'understanding') return esc(v.intent) + ' · ' + (v.products.length ? t(v.products.join(', ')) : 'no product') + (v.locations.length ? ' · ' + t(v.locations.join(', ')) : '');
    if (k === 'products') return esc(v.map(function (p) { return p.name; }).join(', ') || '[]');
    if (k === 'place') return esc(v.name + ' (' + v.type + ')');
    if (k === 'clarify') return esc(v.slot + ': ' + v.options.map(function (o) { return o.label; }).join(' / '));
    if (k === 'answers') return v.length ? esc(v.map(function (a) { return a.product.name + ': ' + a.available.length + ' on the shelf'; }).join(' · ')) : '[]';
    if (k === 'draft') return esc(v.status + ' · ' + v.kind);
    if (k === 'notes' || k === 'trace' || k === 'checks') return v.length + ' item' + (v.length === 1 ? '' : 's');
    if (k === 'spotted') return esc(v.map(function (s) { return s.name; }).join(', ') || '[]');
    if (k === 'linked') return esc(v.map(function (s) { return s.name + ' ' + s.conf; }).join(', ') || '[]');
    if (k === 'choice') return esc(v.slot + ' → ' + v.id);
    if (typeof v === 'string') return v ? t(v.length > 70 ? v.slice(0, 70) + '…' : v) : '<span class="muted">""</span>';
    if (typeof v === 'object') return '<span class="muted">' + (Array.isArray(v) ? v.length + ' items' : 'object') + '</span>';
    return esc(String(v));
  }

  function gInspector() {
    var g = GRAPH, R = runOf(g), route = routeOf(g), L = LAYOUT[g];
    var box = $('#g-insp');
    if (!GSEL) { GSEL = 'n:' + (g === 'ask' ? 'find_entities' : 'link_catalog'); }
    var kind = GSEL.slice(0, 1), id = GSEL.slice(2);
    if (kind === 'n') {
      var info = NODE_INFO[id] || { does: id === 'START' ? 'Where every run begins.' : 'Where the run ends.', reads: [], writes: [], model: 'None' };
      var u = R && R.updates.filter(function (x) { return x.node === id; })[0];
      var outs = L.edges.filter(function (e) { return e.from === id; });
      var h = '<p class="eyebrow">' + (g === 'ask' ? 'Ask graph' : 'Post graph') + ' · node</p><h3 class="mono" style="font-family:var(--font-mono);font-size:21px">' + esc(id) + '</h3><p class="body">' + esc(info.does) + '</p>' +
        kv([['model', esc(info.model || 'None')], ['reads', info.reads.length ? info.reads.map(function (x) { return '<span class="chip mono">' + esc(x) + '</span>'; }).join(' ') : '<span class="muted">nothing</span>'], ['writes', info.writes.length ? info.writes.map(function (x) { return '<span class="chip mono accent">' + esc(x) + '</span>'; }).join(' ') : '<span class="muted">nothing</span>'],
          ['next', outs.length ? outs.map(function (e) { return '<button type="button" class="chip" data-gsel="e:' + esc(edgeId(e)) + '">' + (e.key ? esc(e.key) + ' → ' : '→ ') + esc(e.to.replace('_missing', '')) + '</button>'; }).join(' ') : '<span class="muted">none</span>']]);
      if (ROUTER[id]) h += '<div class="stack"><span class="label">Router on its edges</span>' + code(esc(ROUTER[id].code)) + '</div>';
      if (u) h += '<div class="mini"><span class="label">In this run · step ' + (route.nodes.indexOf(id) + 1) + ' · ' + fx(u.ms, 1) + ' ms</span><p>' + tl(u.out.note || '') + '</p>' + kv(Object.keys(u.out).filter(function (k) { return k !== 'note'; }).map(function (k) { return [k, summarize(k, u.out[k])]; })) + '</div>';
      else if (!/^(START|END)/.test(id)) h += '<p class="note plain">Not on this ' + (g === 'ask' ? 'comment' : 'post') + '\'s route.</p>';
      box.innerHTML = h;
    } else {
      var e = L.edges.filter(function (x) { return edgeId(x) === id; })[0];
      var taken = route.edges.indexOf(id) >= 0;
      var r = ROUTER[e.from];
      box.innerHTML = '<p class="eyebrow">' + (g === 'ask' ? 'Ask graph' : 'Post graph') + ' · ' + (e.key ? 'conditional edge' : 'fixed edge') + '</p><h3 style="font-family:var(--font-mono);font-size:19px">' + esc(e.from) + ' → ' + esc(e.to.replace('_missing', '')) + '</h3>' +
        (e.key ? '<p class="body">Taken when the router after ' + esc(e.from) + ' returns <b class="mono">' + esc(e.key) + '</b>. ' + esc(r ? r.text : '') + '</p>' + code(esc(r ? r.code : '')) : '<p class="body">Always taken after ' + esc(e.from) + ' finishes' + (e.from === 'START' ? ' (the graph\'s entry point)' : '') + '.</p>') +
        '<p class="' + (taken ? 'note' : 'note plain') + '">' + (taken ? 'Taken in this run.' : 'Not taken in this run.') + '</p>';
    }
  }

  function gSide() {
    var g = GRAPH, R = runOf(g), sh = SHAPES[g];
    var label = g === 'ask' ? (R ? 'Comment: ' + R.comment.text : '') : (R ? 'Post: ' + R.post.caption.split('\n')[0] : '');
    $('#g-run-label').innerHTML = R ? t(label.length > 60 ? label.slice(0, 60) + '…' : label) : '';
    if (!R) { $('#g-side').innerHTML = '<p class="muted">Run a ' + (g === 'ask' ? 'comment' : 'post') + ' in the paths view first.</p>'; return; }
    var written = {};
    R.updates.forEach(function (u) { Object.keys(u.out).forEach(function (k) { if (k !== 'note') (written[k] = written[k] || []).push(u.node); }); });
    var state = R.state;
    var rows = Object.keys(sh.channels).map(function (k) {
      return '<tr><td class="mono small">' + esc(k) + '</td><td class="small muted">' + esc(sh.channels[k]) + '</td><td class="small">' + esc((written[k] || ((k === 'post_id' || k === 'comment_id' || k === 'choice') ? ['input'] : [])).join(', ')) + '</td><td class="small">' + summarize(k, state[k === 'trace' ? 'trace' : k]) + '</td></tr>';
    }).join('');
    $('#g-side').innerHTML = '<p class="eyebrow">This run</p><h3>' + (g === 'ask' ? 'The route this comment took' : 'The route this post took') + '</h3><div class="trace">' + R.updates.map(function (u, i) {
      return '<button type="button" class="trace-item" data-gsel="n:' + esc(u.node) + '"><span class="n">' + (i + 1) + '</span><span><b>' + esc(u.node) + '</b><p>' + tl(u.out.note || '') + '</p></span><span class="ms">' + fx(u.ms, 1) + ' ms</span></button>';
    }).join('') + '</div><h3 style="margin-top:8px">Shared state after the run · ' + Object.keys(sh.channels).length + ' channels</h3><p class="small muted">“last” keeps the newest value; “append” adds to a list. A node returns only the channels it changes.</p><div class="tbl-wrap"><table class="t"><tr><th>Channel</th><th>Reducer</th><th>Written by</th><th>Value</th></tr>' + rows + '</table></div>';
  }

  function renderGraphView() {
    $$('.seg2 [data-g]').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-g') === GRAPH ? 'true' : 'false'); });
    if (GSEL && GSEL.slice(0, 2) === 'n:' && !LAYOUT[GRAPH].nodes[GSEL.slice(2)]) GSEL = null;
    if (GSEL && GSEL.slice(0, 2) === 'e:' && !LAYOUT[GRAPH].edges.some(function (e) { return 'e:' + edgeId(e) === GSEL; })) GSEL = null;
    drawGraph(GRAPH);
    gInspector();
    gSide();
  }
  $$('.seg2 [data-g]').forEach(function (b) { b.addEventListener('click', function () { GRAPH = b.getAttribute('data-g'); GSEL = null; stopReplay(); renderGraphView(); }); });
  function gPick(sel) { GSEL = sel; stopReplay(); drawGraph(GRAPH); gInspector(); }
  $('#gwrap').addEventListener('click', function (e) {
    var n = e.target.closest('[data-n]'), ed = e.target.closest('[data-e]');
    if (ed) gPick('e:' + ed.getAttribute('data-e'));
    else if (n) gPick('n:' + n.getAttribute('data-n'));
  });
  $('#gwrap').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var n = e.target.closest('[data-n]'), ed = e.target.closest('[data-e]');
    if (ed) { gPick('e:' + ed.getAttribute('data-e')); e.preventDefault(); } else if (n) { gPick('n:' + n.getAttribute('data-n')); e.preventDefault(); }
  });
  [$('#g-insp'), $('#g-side')].forEach(function (el) { el.addEventListener('click', function (e) { var b = e.target.closest('[data-gsel]'); if (b) gPick(b.getAttribute('data-gsel')); }); });
  function stopReplay() { if (GTIMER) { clearInterval(GTIMER); GTIMER = null; } var s = $('#gsvg'); if (s) s.classList.remove('running'); }
  $('#g-run').addEventListener('click', function () {
    stopReplay();
    var route = routeOf(GRAPH);
    if (!route.nodes.length) return;
    var svg = $('#gsvg');
    svg.classList.add('running');
    $$('#gsvg .node').forEach(function (n) { n.classList.remove('hit'); var b = n.querySelector('.badge'); if (b) b.style.display = 'none'; });
    $$('#gsvg .edge, #gsvg .elabel').forEach(function (n) { n.classList.remove('taken'); });
    var k = 0;
    function lightEdge(id) { $$('#gsvg [data-e="' + id + '"]').forEach(function (x) { x.classList.add('taken'); }); }
    lightEdge(route.edges[0]);
    GTIMER = setInterval(function () {
      if (k >= route.nodes.length) { if (route.edges[k]) lightEdge(route.edges[k]); stopReplay(); return; }
      var n = $('#gsvg [data-n="' + route.nodes[k] + '"]');
      if (n) { n.classList.add('hit'); var b = n.querySelector('.badge'); if (b) b.style.display = ''; }
      GSEL = 'n:' + route.nodes[k];
      $$('#gsvg .node').forEach(function (x) { x.classList.toggle('sel', x.getAttribute('data-n') === route.nodes[k]); });
      gInspector();
      if (route.edges[k + 1] && k + 1 < route.nodes.length) lightEdge(route.edges[k + 1]);
      k++;
    }, 750);
  });

  // ---------- search lab ----------
  var LQ = 'زيت زيتوون', LS = 'prod', LSEL = null, LR = null;
  var PRESETS = [['زيت زيتوون', 'prod'], ['رز', 'prod'], ['olive oil', 'prod'], ['حليب بودره', 'prod'], ['coffee', 'prod'], ['بالزرقا', 'place'], ['بالجبيهة', 'place'], ['Abdoun', 'place'], ['سامح مول', 'place']];
  $('#q-presets').innerHTML = '<span class="label">Try</span>' + PRESETS.map(function (p) { return '<button type="button" class="chip" data-q="' + esc(p[0]) + '" data-s="' + p[1] + '" dir="auto">' + esc(p[0]) + '</button>'; }).join('');
  $('#q-presets').addEventListener('click', function (e) { var b = e.target.closest('[data-q]'); if (b) runLab(b.getAttribute('data-q'), b.getAttribute('data-s')); });
  $$('#q-scope button').forEach(function (b) { b.addEventListener('click', function () { runLab($('#q').value, b.getAttribute('data-s')); }); });
  $('#lab-form').addEventListener('submit', function (e) { e.preventDefault(); runLab($('#q').value); });
  function openLab(q, scope) { showTab('search'); runLab(q, scope); window.scrollTo({ top: 0, behavior: 'smooth' }); }

  function runLab(q, scope) {
    if (q != null && String(q).trim()) LQ = String(q).trim();
    if (scope) LS = scope;
    $('#q').value = LQ;
    $$('#q-scope button').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-s') === LS ? 'true' : 'false'); });
    LR = X.searchDetail(LQ, LS === 'prod' ? PROD : PLACE, 6);
    LSEL = LR.best[0] ? LR.best[0].i : null;
    renderLab();
  }
  function selCand() { return LR.cands.filter(function (c) { return c.i === LSEL; })[0] || null; }

  function decisionSteps(R) {
    var m = R.matches, top = m[0], out = [];
    if (!top) return { status: 'none', lines: ['No name shares a word with it or looks close enough: every name has BM25 0 and a letters score under ' + C.SKIP_FZ + '.'] };
    out.push('Best: ' + t(top.alias) + ' (' + esc(top.entry.type) + ') with confidence ' + fx(top.conf, 2) + '.');
    if (top.conf < C.CONSIDER) { out.push('That is under ' + C.CONSIDER + ', so nothing is chosen <span class="ok-n">✗</span>'); return { status: 'none', lines: out }; }
    var close = m.filter(function (x) {
      return x !== top && x.entry.type === top.entry.type && !(top.how.exact && !x.how.exact) && (x.conf >= top.conf - C.MARGIN || (!top.how.exact && top.how.covers && x.how.covers && x.conf >= C.CONSIDER));
    });
    out.push(top.conf >= C.ACCEPT ? 'It is at least ' + C.ACCEPT + ' <span class="ok-y">✓</span>' : 'It is between ' + C.CONSIDER + ' and ' + C.ACCEPT + ': close enough to offer, not enough to choose <span class="ok-n">✗</span>');
    out.push(close.length ? 'Close rivals of the same type: ' + close.map(function (x) { return t(x.alias) + ' ' + fx(x.conf, 2); }).join(', ') + ' (within ' + C.MARGIN + ', or also containing every word) <span class="ok-n">✗</span>' : 'No other ' + esc(top.entry.type) + ' within ' + C.MARGIN + (top.how.exact ? '; an exact name beats names that are not exact' : '') + ' <span class="ok-y">✓</span>');
    return { status: R.decision.status, lines: out };
  }

  function renderLab() {
    var R = LR, c = selCand();
    var left = '', right = '';
    left += '<div class="card lab-card"><div class="hd"><h3>1 · Clean the words</h3><span class="small muted">text.ts · normalize, tokens, tokenVariants</span></div>' +
      kv([['typed', t(R.mention)], ['normalized', t(R.normalized || '')], ['words', R.tokens.length ? R.tokens.map(function (w) { return '<span class="chip mono' + (R.removed.indexOf(w) >= 0 ? ' strike' : '') + '">' + t(w) + '</span>'; }).join(' ') : '<span class="muted">none</span>'],
        ['forms searched', R.variants.length ? R.variants.map(function (v) { return v.variants.map(function (x) { return '<span class="chip mono accent">' + t(x) + '</span>'; }).join(' '); }).join(' <span class="muted">·</span> ') : '<span class="muted">none</span>']]) +
      (R.removed.length ? '<p class="small muted">Crossed out: filler words that never name a product or place.</p>' : '') + '</div>';
    var rows = R.best.slice(0, 8).map(function (x) {
      var e = X.entry(x.entryId);
      return '<tr class="click' + (x.i === LSEL ? ' sel' : '') + '" data-i="' + x.i + '"><td>' + t(x.alias) + '<br><span class="small muted">' + esc(e ? e.name : '') + ' · ' + esc(x.type) + '</span></td><td class="r">' + fx(x.bm, 2) + '<br><span class="small muted">#' + x.rBm + '</span></td><td class="r">' + fx(x.fz, 2) + '<br><span class="small muted">#' + x.rFz + '</span></td><td class="r muted">—</td><td class="r">' + fx(x.score, 4) + (x.exact ? '<br><span class="small muted">+0.05 exact</span>' : '') + '</td><td class="r"><b>' + fx(x.conf, 2) + '</b><div class="bar" style="margin-top:4px"><i style="width:' + fx(x.conf * 100, 0) + '%"></i></div></td></tr>';
    }).join('');
    left += '<div class="card lab-card"><div class="hd"><h3>2 · Rank three ways, then fuse</h3><span class="small muted">' + R.cands.length + ' names considered</span></div>' +
      (rows ? '<div class="tbl-wrap"><table class="t"><tr><th>Name</th><th class="r">BM25</th><th class="r">Letters</th><th class="r">Jina</th><th class="r">RRF</th><th class="r">Conf.</th></tr>' + rows + '</table></div>' : '<p class="muted">No name shares a word or enough letters.</p>') +
      '<div class="formula">RRF = 1/(60 + BM25 rank) + 1/(60 + letters rank) + 1/(60 + Jina rank)</div><p class="small muted">Click a row to see its numbers. Jina is not run on this page, so its column is empty and the sum has two terms; one row per catalog entry (its best name).</p></div>';
    var ds = decisionSteps(R);
    left += '<div class="card lab-card"><div class="hd"><h3>3 · Decide</h3><span class="small muted">search.ts · decide()</span></div><div class="decision">' + decPill(ds.status) + '<ol class="steps-ol">' + ds.lines.map(function (l) { return '<li>' + l + '</li>'; }).join('') + '</ol></div>' +
      '<p class="small body">' + (ds.status === 'match' ? 'find_entities uses it. A category takes the post\'s product from that category.' : ds.status === 'ambiguous' ? 'find_entities asks the customer, unless the post shows exactly one of the options.' : 'find_entities notes that the word did not match.') + '</p>' +
      '<div class="formula">match: conf ≥ ' + C.ACCEPT + ' and no rival within ' + C.MARGIN + ' · ask: conf ≥ ' + C.CONSIDER + ' · else none</div></div>';

    if (c) {
      var e2 = X.entry(c.entryId);
      right += '<div class="card lab-card"><div class="hd"><h3>BM25 · ' + t(c.alias) + '</h3><span class="small muted">rank #' + c.rBm + '</span></div>';
      if (c.terms.length) {
        var avg = X.dataInfo ? D.bm25.avgLen : 0;
        right += '<div class="tbl-wrap"><table class="t"><tr><th>Shared form</th><th class="r">In names</th><th class="r">idf</th><th class="r">Part</th></tr>' + c.terms.map(function (x) { return '<tr><td>' + t(x.term) + '</td><td class="r">' + x.df + '</td><td class="r">' + fx(x.idf, 3) + '</td><td class="r">' + fx(x.part, 3) + '</td></tr>'; }).join('') + '<tr><td colspan="3"><b>BM25</b></td><td class="r"><b>' + fx(c.bm, 3) + '</b></td></tr></table></div>' +
          '<div class="formula">part = idf × 2.2 / (1 + 1.2 × (0.25 + 0.75 × ' + c.toks.length + ' / ' + fx(avg, 2) + '))</div><p class="small muted">This name has ' + c.toks.length + ' word' + (c.toks.length === 1 ? '' : 's') + '; the average is ' + fx(avg, 2) + '. Shorter names score a little higher.</p>';
      } else right += '<p class="body">No shared word, so BM25 is 0 and this name ranks after every name that shares one.</p>';
      right += '</div>';

      var qp = X.charPieces(R.base.join(' ')), dp = X.charPieces(c.alias), qv = R.local, dv = X.docVector(c.i);
      var qSlots = {}, dSlots = {};
      qp.words.forEach(function (w) { w.pieces.forEach(function (p) { (qSlots[p.slot] = qSlots[p.slot] || []).push(p.p); }); });
      dp.words.forEach(function (w) { w.pieces.forEach(function (p) { (dSlots[p.slot] = dSlots[p.slot] || []).push(p.p); }); });
      var shared = [];
      for (var i = 0; i < 512; i++) if (qv[i] > 0 && dv[i] > 0) shared.push({ slot: i, prod: qv[i] * dv[i] });
      shared.sort(function (a, b) { return b.prod - a.prod; });
      var cos = shared.reduce(function (s, x) { return s + x.prod; }, 0);
      var qmax = Math.max.apply(null, qv) || 1, cells = '';
      for (var j = 0; j < 512; j++) {
        var x0 = (j % 32) * 18, y0 = Math.floor(j / 32) * 18;
        cells += '<rect class="e" x="' + x0 + '" y="' + y0 + '" width="16" height="16" rx="3"/>';
        if (qv[j] > 0) cells += '<rect x="' + x0 + '" y="' + y0 + '" width="16" height="16" rx="3" fill="' + (dv[j] > 0 ? 'var(--solid)' : 'var(--accent)') + '" opacity="' + (dv[j] > 0 ? 1 : fx(0.35 + (0.65 * qv[j]) / qmax, 2)) + '"/>';
        if (dv[j] > 0) cells += '<rect x="' + (x0 + 1.5) + '" y="' + (y0 + 1.5) + '" width="13" height="13" rx="2.5" fill="none" stroke="var(--amber)" stroke-width="3"/>';
      }
      right += '<div class="card lab-card"><div class="hd"><h3>Character vectors · ' + t(c.alias) + '</h3><span class="small muted">rank #' + c.rFz + '</span></div>' +
        '<p class="small body">' + qp.words.map(function (w) { return '<span class="chip mono accent">' + t(w.padded) + '</span>'; }).join(' ') + ' vs ' + dp.words.map(function (w) { return '<span class="chip mono">' + t(w.padded) + '</span>'; }).join(' ') + '</p>' +
        '<svg class="vgrid" viewBox="0 0 574 286" role="img" aria-label="512 slots: query pieces, name pieces and shared pieces">' + cells + '</svg>' +
        '<div class="vlegend"><span><i style="background:var(--accent)"></i>query pieces</span><span><i style="border:3px solid var(--amber)"></i>name pieces</span><span><i style="background:var(--solid)"></i>shared</span></div>' +
        '<div class="formula">cos = Σ qᵢ × dᵢ over ' + shared.length + ' shared slots = ' + fx(cos, 3) + '</div>' +
        (shared.length ? '<div class="tbl-wrap"><table class="t"><tr><th class="r">Slot</th><th>Query pieces</th><th>Name pieces</th><th class="r">qᵢ × dᵢ</th></tr>' + shared.slice(0, 6).map(function (s) { return '<tr><td class="r mono">' + s.slot + '</td><td>' + (qSlots[s.slot] || []).map(function (p) { return '<span class="chip mono">' + t(p) + '</span>'; }).join(' ') + '</td><td>' + (dSlots[s.slot] || []).map(function (p) { return '<span class="chip mono">' + t(p) + '</span>'; }).join(' ') + '</td><td class="r">' + fx(s.prod, 4) + '</td></tr>'; }).join('') + '</table></div>' : '<p class="small muted">No shared piece.</p>') +
        '<p class="small muted">Each piece adds its length minus one to its slot (2-letter: 1, 3-letter: 2, 4-letter: 3); both vectors are divided by their length, so the dot product is the cosine. A different piece can land in the same slot; with 512 slots that is rare.</p></div>';

      var conf = c.rule === 'exact' ? '1.00 (an exact name)' : c.rule === 'contained' ? 'max(' + fx(c.lexical, 3) + ', 0.78) = ' + fx(c.conf, 2) + ' (every word of the name is in the text)' : fx(c.conf, 2) + ' (the lexical score)';
      right += '<div class="card lab-card"><div class="hd"><h3>Confidence · ' + t(c.alias) + '</h3><span class="small muted">' + esc(e2 ? e2.name : '') + '</span></div>' +
        kv([['words of the text found', c.hitQ + ' of ' + R.base.length + ' → ' + fx(c.rQ, 2)], ['words of the name found', c.hitD + ' of ' + c.toks.length + ' → ' + fx(c.pD, 2)], ['word overlap (F1)', fx(c.lex, 3)], ['lexical', '0.55 × ' + fx(c.lex, 3) + ' + 0.45 × ' + fx(c.fz, 3) + ' = ' + fx(c.lexical, 3)], ['confidence', '<b>' + conf + '</b>']]) +
        '<p class="small muted">With a Jina key, a high cosine can also lift it: (cos − 0.35) / 0.4 × 0.9, capped at 0.9.</p></div>';
    } else right += '<div class="card lab-card"><h3>No candidate</h3><p class="body">Nothing came close. Try another spelling or the other list.</p></div>';
    right += '<div class="card lab-card"><div class="hd"><h3>Jina · the third ranking</h3><span class="small muted">not run on this page</span></div><p class="body">On Netlify the words are embedded once (256 numbers) and compared by cosine with the 436 stored name vectors. Their order is the third ranking, adding 1/(60 + rank) to the sum. It is what matches olive oil with زيت زيتون, which share no letters, so the other two rankings alone could not.</p></div>';
    $('#lab-left').innerHTML = left;
    $('#lab-right').innerHTML = right;
  }
  $('#lab-left').addEventListener('click', function (e) { var r = e.target.closest('tr[data-i]'); if (!r) return; LSEL = +r.getAttribute('data-i'); renderLab(); });

  // ---------- start ----------
  cText.value = 'زيت زيتوون بالزرقا متوفر؟';
  cPersona = 'ahmad';
  refreshCommentPosts();
  Promise.all([runPostNow(), runCommentNow()]).then(function () {
    refreshCommentPosts();
    // deep links from the slides: #data, #post, #comment open a path; #graph, #search, #models open a view
    var h = String(location.hash || '').replace('#', '');
    var PATHS = ['data', 'post', 'comment'];
    var linked = PATHS.indexOf(h) >= 0;
    var p = linked ? h : mem.get('ape-path');
    setPath(PATHS.indexOf(p) >= 0 ? p : 'data', linked ? { step: 0 } : undefined);
    var tab = TABS.indexOf(h) >= 0 ? h : linked ? 'paths' : mem.get('ape-tab');
    if (tab && tab !== 'paths') showTab(tab);
  }).catch(function (err) {
    $('#insp-title').textContent = 'Something failed while starting: ' + err.message;
  });
})();

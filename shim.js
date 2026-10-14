/* رحلتي — طبقة البيانات: تخزين محلي (IndexedDB) + مزامنة مع Supabase + الدخول.
   تحاكي واجهة window.claude التي يستعملها التطبيق (db / user / downloads / mcp)
   حتى يعمل التطبيق نفسه دون تعديل كبير، سواء كان الاتصال متاحاً أم لا. */
(function () {
  'use strict';

  var CFG = {
    url: 'https://aoflodcxgswazbbryyqt.supabase.co',
    key: 'sb_publishable_sMWwxTFswhtcU3qHCmyikg_-SPz-jsM'
  };
  if (window.RH_CONFIG) { for (var ck in window.RH_CONFIG) CFG[ck] = window.RH_CONFIG[ck]; }
  var POLL_MS = 10000, OVERLAP = 100, BATCH_BYTES = 700000;

  /* ---------- helpers ---------- */
  function clone(o) { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); }
  function nowMs() { return Date.now(); }
  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'on') { for (var ev in attrs.on) e.addEventListener(ev, attrs.on[ev]); }
      else if (k === 'style') e.style.cssText = attrs[k];
      else e.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function genId() {
    var s = '', c = 'abcdefghijklmnopqrstuvwxyz0123456789';
    for (var i = 0; i < 20; i++) s += c[Math.floor(Math.random() * c.length)];
    return s;
  }
  function jwtPayload(t) {
    try {
      var p = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      while (p.length % 4) p += '=';
      return JSON.parse(decodeURIComponent(escape(atob(p))));
    } catch (e) { return {}; }
  }
  function permErr(msg) { var e = new Error(msg || 'ليست لديك صلاحية'); e.code = 'permission-denied'; return e; }

  /* ---------- IndexedDB ---------- */
  var IDB = null;
  function idbOpen() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open('rehlati-local', 1);
      r.onupgradeneeded = function () {
        var d = r.result;
        if (!d.objectStoreNames.contains('docs')) d.createObjectStore('docs', { keyPath: 'k' });
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'k' });
      };
      r.onsuccess = function () { IDB = r.result; res(IDB); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function idbAll(store) {
    return new Promise(function (res, rej) {
      var q = IDB.transaction(store, 'readonly').objectStore(store).getAll();
      q.onsuccess = function () { res(q.result || []); };
      q.onerror = function () { rej(q.error); };
    });
  }
  function idbPutMany(store, arr) {
    if (!arr.length) return Promise.resolve();
    return new Promise(function (res, rej) {
      var tx = IDB.transaction(store, 'readwrite'), os = tx.objectStore(store);
      arr.forEach(function (x) { os.put(x); });
      tx.oncomplete = function () { res(); };
      tx.onerror = tx.onabort = function () { rej(tx.error); };
    });
  }
  function idbClear() {
    return new Promise(function (res) {
      var tx = IDB.transaction(['docs', 'files', 'meta'], 'readwrite');
      ['docs', 'files', 'meta'].forEach(function (s) { tx.objectStore(s).clear(); });
      tx.oncomplete = tx.onerror = tx.onabort = function () { res(); };
    });
  }
  function metaGet(k) { return metaCache[k]; }
  var metaCache = {};
  function metaSet(k, v) { metaCache[k] = v; return idbPutMany('meta', [{ k: k, v: v }]).catch(function () {}); }

  /* ---------- in-memory state ---------- */
  var DOCS = new Map();      // coll -> Map(id -> rec)
  var FILES = new Map();     // id -> rec
  var LIS = {};              // coll -> Set(fn)  (query listeners: {q, fn, err})
  var DLIS = {};             // 'coll/id' -> Set(fn)
  var session = null, profile = null, staffList = [];
  var net = { online: navigator.onLine !== false, syncing: false, last: 0, err: '', authLost: false, initial: false, rejected: 0 };
  var bootedRole = null;

  function collMap(c) { var m = DOCS.get(c); if (!m) { m = new Map(); DOCS.set(c, m); } return m; }
  function pendingCount() {
    var n = 0;
    DOCS.forEach(function (m) { m.forEach(function (r) { if (r.dirty) n++; }); });
    FILES.forEach(function (r) { if (r.dirty) n++; });
    return n;
  }

  /* ---------- queries ---------- */
  function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
  function passWhere(v, op, x) {
    switch (op) {
      case '<': return v < x; case '<=': return v <= x; case '>': return v > x; case '>=': return v >= x;
      case '==': case '===': return v === x; case '!=': return v !== x;
    }
    return true;
  }
  function mkDoc(r) {
    return { id: r.id, exists: true, data: function () { return clone(r.data); }, ref: docRef(r.coll, r.id) };
  }
  function runQuery(q) {
    var arr = [], m = DOCS.get(q.coll);
    if (m) m.forEach(function (r) {
      if (r.deleted) return;
      for (var i = 0; i < q.wheres.length; i++) {
        var w = q.wheres[i];
        if (!passWhere(r.data ? r.data[w[0]] : undefined, w[1], w[2])) return;
      }
      arr.push(r);
    });
    if (q.order) {
      var f = q.order[0], d = q.order[1] === 'desc' ? -1 : 1;
      arr.sort(function (a, b) { return d * cmp(a.data[f], b.data[f]); });
    }
    if (q.lim) arr = arr.slice(0, q.lim);
    var docs = arr.map(mkDoc);
    return { docs: docs, size: docs.length, empty: !docs.length, forEach: function (fn) { docs.forEach(fn); } };
  }
  function Query(coll, wheres, order, lim) { this.coll = coll; this.wheres = wheres || []; this.order = order || null; this.lim = lim || 0; }
  Query.prototype.where = function (f, op, v) { return new Query(this.coll, this.wheres.concat([[f, op, v]]), this.order, this.lim); };
  Query.prototype.orderBy = function (f, dir) { return new Query(this.coll, this.wheres, [f, dir || 'asc'], this.lim); };
  Query.prototype.limit = function (n) { return new Query(this.coll, this.wheres, this.order, n); };
  Query.prototype.get = function () { var self = this; return Promise.resolve().then(function () { return runQuery(self); }); };
  Query.prototype.onSnapshot = function (fn, err) {
    var self = this, rec = { q: self, fn: fn, err: err }, set = LIS[self.coll] || (LIS[self.coll] = new Set());
    set.add(rec);
    setTimeout(function () { if (set.has(rec)) { try { fn(runQuery(self)); } catch (e) { console.error(e); } } }, 0);
    return function () { set.delete(rec); };
  };
  function Coll(name) { Query.call(this, name); this.id = name; }
  Coll.prototype = Object.create(Query.prototype);
  Coll.prototype.doc = function (id) { return docRef(this.coll, id || genId()); };
  Coll.prototype.add = function (data) { var r = docRef(this.coll, genId()); return r.set(data).then(function () { return r; }); };

  var notifyQ = {};
  function notify(coll, id) {
    var key = coll;
    if (!notifyQ[key]) {
      notifyQ[key] = { ids: {} };
      setTimeout(function () {
        var n = notifyQ[key]; notifyQ[key] = null;
        (LIS[coll] ? Array.from(LIS[coll]) : []).forEach(function (rec) { try { rec.fn(runQuery(rec.q)); } catch (e) { console.error(e); } });
        Object.keys(n.ids).forEach(function (i) {
          var s = DLIS[coll + '/' + i];
          if (s) Array.from(s).forEach(function (fn) { try { fn(docSnap(coll, i)); } catch (e) { console.error(e); } });
        });
      }, 0);
    }
    if (id != null) notifyQ[key].ids[id] = 1;
  }
  function docSnap(coll, id) {
    var r = collMap(coll).get(id);
    if (!r || r.deleted) return { id: id, exists: false, data: function () { return undefined; }, ref: docRef(coll, id) };
    return mkDoc(r);
  }

  /* ---------- doc refs ---------- */
  function docRef(coll, id) {
    var isFile = coll === 'pgfiles';
    return {
      id: id, path: coll + '/' + id,
      get: function () { return isFile ? getFile(id) : Promise.resolve(docSnap(coll, id)); },
      set: function (d) { return isFile ? putFile(id, d, false) : putDoc(coll, id, d, false); },
      update: function (d) {
        var cur = collMap(coll).get(id);
        return putDoc(coll, id, Object.assign({}, cur && !cur.deleted ? cur.data : {}, d), false);
      },
      delete: function () { return isFile ? putFile(id, null, true) : putDoc(coll, id, null, true); },
      onSnapshot: function (fn, err) {
        var key = coll + '/' + id, set = DLIS[key] || (DLIS[key] = new Set());
        set.add(fn);
        setTimeout(function () { if (set.has(fn)) { try { fn(docSnap(coll, id)); } catch (e) { console.error(e); } } }, 0);
        return function () { set.delete(fn); };
      }
    };
  }
  function splitPath(p) { var i = String(p).indexOf('/'); return [p.slice(0, i), p.slice(i + 1)]; }
  var dbApi = {
    collection: function (n) { return new Coll(n); },
    doc: function (p) { var s = splitPath(p); return docRef(s[0], s[1]); }
  };

  /* ---------- writes (local first) ---------- */
  function roleOk(coll) {
    var r = profile && profile.role;
    if (r !== 'admin' && r !== 'employee') return false;
    if (coll === 'settings' && r !== 'admin') return false;
    return true;
  }
  function putDoc(coll, id, data, del) {
    if (!roleOk(coll)) return Promise.reject(permErr());
    var m = collMap(coll), r = m.get(id);
    if (!r) { r = { k: coll + '/' + id, coll: coll, id: id, data: {}, deleted: false, dirty: false, v: 0 }; m.set(id, r); }
    if (!del) r.data = clone(data) || {};
    r.deleted = !!del; r.dirty = true; r.v = (r.v || 0) + 1;
    return idbPutMany('docs', [r]).then(function () { notify(coll, id); updatePill(); schedulePush(); });
  }
  function putFile(id, data, del) {
    if (!roleOk('pgfiles')) return Promise.reject(permErr());
    var r = FILES.get(id);
    if (!r) { r = { id: id, p: '', d: '', deleted: false, dirty: false, v: 0 }; FILES.set(id, r); }
    if (!del) { r.d = String((data && data.d) || ''); r.p = String((data && data.p) || ''); r.i = data && data.i; }
    else { r.d = ''; }
    r.deleted = !!del; r.dirty = true; r.v = (r.v || 0) + 1;
    return idbPutMany('files', [r]).then(function () { updatePill(); schedulePush(); });
  }
  function fileSnap(r) {
    if (!r || r.deleted || !r.d) return { id: r && r.id, exists: false, data: function () { return undefined; } };
    return { id: r.id, exists: true, data: function () { return { d: r.d, p: r.p, i: r.i }; } };
  }
  function getFile(id) {
    var r = FILES.get(id);
    if (r && !r.deleted && r.d) return Promise.resolve(fileSnap(r));
    if (r && r.deleted) return Promise.resolve(fileSnap(null));
    return api('/rest/v1/rh_files?select=id,p,d,deleted&id=eq.' + encodeURIComponent(id)).then(function (rows) {
      var x = rows && rows[0];
      if (!x || x.deleted || !x.d) return fileSnap(null);
      var rec = { id: x.id, p: x.p, d: x.d, deleted: false, dirty: false, v: 0 };
      FILES.set(id, rec); idbPutMany('files', [rec]).catch(function () {});
      return fileSnap(rec);
    }, function () { return fileSnap(null); });
  }

  /* ---------- auth + network ---------- */
  function saveSession(s) { session = s; return metaSet('session', s); }
  function authReq(path, body) {
    return fetch(CFG.url + path, {
      method: 'POST', headers: { apikey: CFG.key, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, body: j }; }); });
  }
  function sessionFrom(j) {
    var p = jwtPayload(j.access_token || '');
    return {
      access_token: j.access_token, refresh_token: j.refresh_token,
      expires_at: j.expires_at ? j.expires_at * 1000 : nowMs() + (j.expires_in || 3600) * 1000,
      uid: p.sub, email: String(p.email || (j.user && j.user.email) || '').toLowerCase()
    };
  }
  var refreshing = null;
  function refreshSession() {
    if (!session || !session.refresh_token) return Promise.reject(new Error('no-session'));
    if (refreshing) return refreshing;
    refreshing = authReq('/auth/v1/token?grant_type=refresh_token', { refresh_token: session.refresh_token }).then(function (r) {
      refreshing = null;
      if (r.ok && r.body.access_token) { net.authLost = false; return saveSession(sessionFrom(r.body)).then(function () { return session; }); }
      if (r.status === 400 || r.status === 401 || r.status === 403) { net.authLost = true; updatePill(); }
      var e = new Error('refresh-failed'); e.auth = true; throw e;
    }, function (e) { refreshing = null; setOnline(false); throw e; });
    return refreshing;
  }
  function token() {
    if (!session) return Promise.reject(Object.assign(new Error('no-session'), { auth: true }));
    if (session.expires_at - nowMs() > 60000) return Promise.resolve(session.access_token);
    return refreshSession().then(function (s) { return s.access_token; });
  }
  function setOnline(v) {
    if (net.online !== v) { net.online = v; updatePill(); if (v) schedulePush(); }
  }
  /* طلب REST: يعيد JSON، ويرمي {net:true} عند انقطاع الشبكة و{status} عند خطأ HTTP */
  function api(path, opt, retried) {
    opt = opt || {};
    return token().then(function (tk) {
      var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var to = ctl ? setTimeout(function () { ctl.abort(); }, opt.timeout || 25000) : null;
      var h = Object.assign({ apikey: CFG.key, Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json' }, opt.headers || {});
      return fetch(CFG.url + path, { method: opt.method || 'GET', headers: h, body: opt.body ? JSON.stringify(opt.body) : undefined, signal: ctl ? ctl.signal : undefined })
        .then(function (r) {
          if (to) clearTimeout(to);
          setOnline(true);
          if (r.status === 401 && !retried) { session.expires_at = 0; return api(path, opt, true); }
          if (!r.ok) {
            return r.text().then(function (t) { var e = new Error('http ' + r.status); e.status = r.status; e.text = t; throw e; });
          }
          if (r.status === 204) return null;
          return r.text().then(function (t) { return t ? JSON.parse(t) : null; });
        }, function (e) { if (to) clearTimeout(to); setOnline(false); var x = new Error('network'); x.net = true; throw x; });
    });
  }

  /* ---------- sync ---------- */
  var pushTimer = null, syncing = false, again = false, backoff = 0;
  function schedulePush() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () { sync(); }, 400);
  }
  function chunkRows(items, sizeOf) {
    var out = [], cur = [], sz = 0;
    items.forEach(function (it) {
      var s = sizeOf(it);
      if (cur.length && (sz + s > BATCH_BYTES || cur.length >= 100)) { out.push(cur); cur = []; sz = 0; }
      cur.push(it); sz += s;
    });
    if (cur.length) out.push(cur);
    return out;
  }
  function clearDirty(recs, store, sent) {
    var out = [];
    recs.forEach(function (r, i) { if (r.v === sent[i]) { r.dirty = false; out.push(r); } });
    return idbPutMany(store, out);
  }
  function pushKind(table, recs, toRow, store, conflict) {
    if (!recs.length) return Promise.resolve();
    var chain = Promise.resolve();
    chunkRows(recs, function (r) { return (r.d ? r.d.length : 0) + JSON.stringify(r.data || {}).length + 100; }).forEach(function (batch) {
      chain = chain.then(function () {
        var sent = batch.map(function (r) { return r.v; });
        return api('/rest/v1/' + table + '?on_conflict=' + conflict, {
          method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: batch.map(toRow), timeout: 60000
        }).then(function () { return clearDirty(batch, store, sent); }, function (e) {
          if (e.net || !e.status || e.status >= 500 || e.status === 401) throw e;
          // رُفضت الدفعة: جرّب كل سجل على حدة وتخلَّ عن المرفوض
          var inner = Promise.resolve();
          batch.forEach(function (r) {
            inner = inner.then(function () {
              var v = r.v;
              return api('/rest/v1/' + table + '?on_conflict=' + conflict, { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: [toRow(r)], timeout: 60000 })
                .then(function () { return clearDirty([r], store, [v]); }, function (e2) {
                  if (e2.net || !e2.status || e2.status >= 500 || e2.status === 401) throw e2;
                  net.rejected++; console.warn('rejected', table, r.id, e2.status, e2.text);
                  return restoreRemote(table, r);
                });
            });
          });
          return inner;
        });
      });
    });
    return chain;
  }
  function restoreRemote(table, r) {
    if (table === 'rh_files') { r.dirty = false; return idbPutMany('files', [r]); }
    return api('/rest/v1/rh_docs?select=coll,id,data,deleted&coll=eq.' + encodeURIComponent(r.coll) + '&id=eq.' + encodeURIComponent(r.id)).then(function (rows) {
      var x = rows && rows[0];
      r.dirty = false;
      if (x) { r.data = x.data || {}; r.deleted = !!x.deleted; } else { r.deleted = true; }
      notify(r.coll, r.id);
      return idbPutMany('docs', [r]);
    }).catch(function () { r.dirty = false; });
  }
  function push() {
    var d = [], f = [];
    DOCS.forEach(function (m) { m.forEach(function (r) { if (r.dirty) d.push(r); }); });
    FILES.forEach(function (r) { if (r.dirty) f.push(r); });
    return pushKind('rh_docs', d, function (r) { return { coll: r.coll, id: r.id, data: r.deleted ? {} : r.data, deleted: !!r.deleted }; }, 'docs', 'coll,id')
      .then(function () { return pushKind('rh_files', f, function (r) { return { id: r.id, p: r.p || '', d: r.deleted ? '' : (r.d || ''), deleted: !!r.deleted }; }, 'files', 'id'); });
  }
  function pull() {
    var cursor = num(metaGet('cursor')), from = Math.max(0, cursor - OVERLAP), total = 0;
    function page() {
      return api('/rest/v1/rh_docs?select=coll,id,data,deleted,seq&seq=gt.' + from + '&order=seq.asc&limit=500').then(function (rows) {
        rows = rows || [];
        var touched = {}, put = [];
        rows.forEach(function (x) {
          var m = collMap(x.coll), r = m.get(x.id);
          if (r && r.dirty) return;
          if (!r) { r = { k: x.coll + '/' + x.id, coll: x.coll, id: x.id, dirty: false, v: 0 }; m.set(x.id, r); }
          var same = r.deleted === !!x.deleted && JSON.stringify(r.data) === JSON.stringify(x.data || {});
          r.data = x.data || {}; r.deleted = !!x.deleted; r.dirty = false;
          if (!same) { put.push(r); (touched[x.coll] = touched[x.coll] || []).push(x.id); }
        });
        total += rows.length;
        if (rows.length) { from = rows[rows.length - 1].seq; cursor = Math.max(cursor, from); }
        return idbPutMany('docs', put).then(function () {
          Object.keys(touched).forEach(function (c) { touched[c].forEach(function (i) { notify(c, i); }); });
          if (rows.length === 500) { setStatus('جارٍ تنزيل البيانات… ' + total); return page(); }
        });
      });
    }
    return page().then(function () { return metaSet('cursor', cursor); });
  }
  function num(x) { x = Number(x); return isFinite(x) ? x : 0; }
  function touchMe() {
    return api('/rest/v1/rpc/rh_touch', { method: 'POST', body: {} }).then(function (p) {
      if (!p) { var e = new Error('not-staff'); e.notStaff = true; throw e; }
      profile = { role: p.role, name: p.name || '', email: p.email, uid: p.uid };
      return metaSet('profile', profile).then(function () {
        if (bootedRole && bootedRole !== profile.role) { setStatus('تغيّرت صلاحياتك — يُعاد التحميل…'); setTimeout(function () { location.reload(); }, 1200); }
      });
    });
  }
  function loadStaff() {
    return api('/rest/v1/rh_staff?select=email,name,role,uid&order=created_at.asc').then(function (rows) {
      staffList = rows || []; return metaSet('staff', staffList);
    });
  }
  function sync() {
    if (syncing) { again = true; return Promise.resolve(); }
    if (!session || !navigator.onLine && !net.online) { updatePill(); return Promise.resolve(); }
    syncing = true; net.syncing = true; updatePill();
    return touchMe().then(function () { return push(); }).then(function () { return pull(); }).then(function () {
      net.last = nowMs(); net.err = ''; backoff = 0; net.initial = true;
      metaSet('last', net.last);
      loadStaff().catch(function () {});
    }).catch(function (e) {
      if (e.notStaff) { handleRemoved(); return; }
      if (e.auth) { net.authLost = true; }
      else if (e.net) { /* offline */ }
      else { net.err = 'تعذّرت المزامنة (' + (e.status || '؟') + ')'; backoff = Math.min(120000, (backoff || 10000) * 2); }
    }).then(function () {
      syncing = false; net.syncing = false; updatePill();
      if (again) { again = false; schedulePush(); }
    });
  }
  function handleRemoved() {
    syncing = false; net.syncing = false;
    idbClear().then(function () { DOCS.clear(); FILES.clear(); metaCache = {}; session = null; profile = null; showBlocked('هذا البريد غير مسجّل لدى الوكالة، أو أُزيلت صلاحيته. اطلب من المدير إضافته.'); });
  }
  function startPolling() {
    setInterval(function () {
      if (document.hidden && nowMs() - net.last < 60000) return;
      if (backoff && nowMs() - net.last < backoff) return;
      sync();
    }, POLL_MS);
    window.addEventListener('online', function () { net.online = true; backoff = 0; updatePill(); sync(); });
    window.addEventListener('offline', function () { net.online = false; updatePill(); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) sync(); });
    window.addEventListener('focus', function () { sync(); });
    window.addEventListener('beforeunload', function () { /* التعديلات المعلّقة محفوظة محلياً */ });
  }

  /* ---------- UI: styles ---------- */
  var cssDone = false;
  function injectCss() {
    if (cssDone) return; cssDone = true;
    var s = document.createElement('style');
    s.textContent =
      '.rh-ov{position:fixed;inset:0;z-index:200;background:var(--bg,#F1F5F5);color:var(--ink,#10262A);display:flex;align-items:center;justify-content:center;padding:20px;font-family:var(--f-body,system-ui,sans-serif);overflow:auto}' +
      '.rh-box{background:var(--surface,#fff);border:1px solid var(--line,#D6E0E0);border-radius:14px;padding:26px 22px;width:100%;max-width:400px}' +
      '.rh-box h1{font-family:var(--f-display,inherit);font-size:26px;font-weight:600;margin:0 0 4px;color:var(--brand,#0B5A61)}' +
      '.rh-box p{color:var(--muted,#566C70);margin:0 0 14px;font-size:14px}' +
      '.rh-box label{display:block;font-size:13px;color:var(--muted,#566C70);margin:10px 0 4px}' +
      '.rh-box input,.rh-box select{width:100%;font:inherit;font-size:16px;padding:11px 12px;border:1px solid var(--line,#D6E0E0);border-radius:9px;background:var(--bg,#F1F5F5);color:var(--ink,#10262A)}' +
      '.rh-box input[dir=ltr]{text-align:left}' +
      '.rh-btn{font:inherit;font-weight:600;font-size:15px;border:1px solid var(--line,#D6E0E0);background:var(--surface2,#E7EEEE);color:var(--ink,#10262A);border-radius:9px;padding:10px 16px;cursor:pointer}' +
      '.rh-btn.pri{background:var(--brand,#0B5A61);border-color:var(--brand,#0B5A61);color:var(--on-brand,#fff);width:100%;margin-top:14px;padding:12px}' +
      '.rh-btn.sm{padding:6px 10px;font-size:13px}' +
      '.rh-btn[disabled]{opacity:.55;cursor:default}' +
      '.rh-msg{margin-top:12px;font-size:14px;color:var(--muted,#566C70)}.rh-msg.bad{color:var(--bad,#B3261E)}.rh-msg.good{color:var(--good,#16794A)}' +
      '.rh-link{background:none;border:0;color:var(--brand,#0B5A61);font:inherit;font-size:14px;text-decoration:underline;cursor:pointer;padding:6px 0;margin-top:6px}' +
      '#rh-pill{position:fixed;left:10px;bottom:10px;z-index:90;display:flex;align-items:center;gap:6px;background:var(--surface,#fff);color:var(--ink,#10262A);border:1px solid var(--line,#D6E0E0);border-radius:999px;padding:5px 11px;font:inherit;font-size:12px;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.12);max-width:calc(100vw - 20px)}' +
      '#rh-pill i{width:9px;height:9px;border-radius:50%;background:#16794A;display:inline-block;flex:0 0 auto}' +
      '#rh-pill.off i{background:#9A5B00}#rh-pill.bad i{background:#B3261E}#rh-pill.syn i{background:#0B5A61;animation:rhp 1s infinite}' +
      '@keyframes rhp{50%{opacity:.35}}' +
      '@media(max-width:700px){#rh-pill{bottom:calc(66px + env(safe-area-inset-bottom,0px))}}' +
      '@media print{#rh-pill,.rh-ov{display:none!important}}' +
      '.rh-menu{position:fixed;left:10px;bottom:48px;z-index:91;background:var(--surface,#fff);color:var(--ink,#10262A);border:1px solid var(--line,#D6E0E0);border-radius:12px;padding:12px;min-width:240px;max-width:calc(100vw - 20px);box-shadow:0 4px 18px rgba(0,0,0,.2);font-family:var(--f-body,inherit);font-size:14px}' +
      '@media(max-width:700px){.rh-menu{bottom:calc(104px + env(safe-area-inset-bottom,0px))}}' +
      '.rh-menu .rh-who{font-weight:600}.rh-menu small{display:block;color:var(--muted,#566C70);margin-top:2px}' +
      '.rh-menu .rh-btn{display:block;width:100%;text-align:right;margin-top:8px}' +
      '.rh-staff{width:100%;max-width:520px}.rh-row{display:flex;align-items:center;gap:8px;border-top:1px solid var(--line,#D6E0E0);padding:9px 0;flex-wrap:wrap}.rh-row b{flex:1;min-width:140px;overflow-wrap:anywhere}.rh-row small{display:block;color:var(--muted,#566C70);font-weight:400}' +
      '.rh-row select{width:auto;padding:6px 8px;font-size:14px}';
    document.head.appendChild(s);
  }

  /* ---------- UI: status pill + menu ---------- */
  var pill = null, menu = null, statusMsg = '', updateReady = false;
  function setStatus(t) { statusMsg = t; updatePill(); }
  function fmtAgo(t) {
    if (!t) return 'لم تتم بعد';
    var s = Math.round((nowMs() - t) / 1000);
    if (s < 60) return 'الآن'; if (s < 3600) return 'قبل ' + Math.round(s / 60) + ' د';
    if (s < 86400) return 'قبل ' + Math.round(s / 3600) + ' س'; return 'قبل ' + Math.round(s / 86400) + ' يوم';
  }
  function updatePill() {
    if (!pill) return;
    var p = pendingCount(), cls = '', txt;
    if (updateReady) { cls = 'syn'; txt = 'يتوفر تحديث — اضغط لإعادة التحميل'; }
    else if (net.authLost) { cls = 'bad'; txt = 'انتهت الجلسة — اضغط لتسجيل الدخول'; }
    else if (statusMsg && net.syncing) { cls = 'syn'; txt = statusMsg; }
    else if (!net.online) { cls = 'off'; txt = 'بلا اتصال' + (p ? ' — ' + p + ' تعديل معلّق' : ' — يعمل محلياً'); }
    else if (net.syncing) { cls = 'syn'; txt = 'جارٍ المزامنة' + (p ? ' (' + p + ')' : '…'); }
    else if (net.err) { cls = 'bad'; txt = net.err + (p ? ' — ' + p + ' معلّق' : ''); }
    else if (p) { cls = 'syn'; txt = p + ' تعديل بانتظار المزامنة'; }
    else { txt = 'متصل ✓ متزامن'; }
    pill.className = cls; pill.querySelector('span').textContent = txt;
    if (menu) renderMenu();
  }
  function ensurePill() {
    injectCss();
    if (pill) return;
    pill = el('button', { id: 'rh-pill', type: 'button', 'aria-label': 'حالة المزامنة', on: { click: function () { if (updateReady) { location.reload(); } else if (net.authLost) { showLogin(true); } else toggleMenu(); } } }, [el('i'), el('span')]);
    document.body.appendChild(pill);
    updatePill();
  }
  function toggleMenu() {
    if (menu) { menu.remove(); menu = null; return; }
    menu = el('div', { class: 'rh-menu', role: 'dialog' });
    document.body.appendChild(menu); renderMenu();
    setTimeout(function () { document.addEventListener('click', outside, true); }, 0);
  }
  function outside(e) {
    if (menu && !menu.contains(e.target) && !pill.contains(e.target)) { menu.remove(); menu = null; document.removeEventListener('click', outside, true); }
  }
  var ROLE_AR = { admin: 'مدير', employee: 'موظف', readonly: 'قراءة فقط' };
  function renderMenu() {
    if (!menu) return;
    while (menu.firstChild) menu.removeChild(menu.firstChild);
    var p = pendingCount();
    menu.appendChild(el('div', { class: 'rh-who', text: (profile && profile.name) || (profile && profile.email) || '' }));
    menu.appendChild(el('small', { text: (profile ? profile.email + ' · ' + (ROLE_AR[profile.role] || '') : '') }));
    menu.appendChild(el('small', { text: 'آخر مزامنة: ' + fmtAgo(net.last) + (p ? ' · معلّق: ' + p : '') }));
    if (net.rejected) menu.appendChild(el('small', { text: 'رُفض ' + net.rejected + ' تعديل لعدم الصلاحية', style: 'color:var(--bad,#B3261E)' }));
    menu.appendChild(el('button', { class: 'rh-btn sm', type: 'button', text: 'مزامنة الآن', on: { click: function () { sync(); } } }));
    if (profile && profile.role === 'admin') menu.appendChild(el('button', { class: 'rh-btn sm', type: 'button', text: 'إدارة الموظفين', on: { click: function () { toggleMenu(); openStaff(); } } }));
    menu.appendChild(el('button', { class: 'rh-btn sm', type: 'button', text: 'تسجيل الخروج', on: { click: function () { toggleMenu(); signOut(); } } }));
  }
  function signOut() {
    var p = pendingCount();
    var msg = p ? 'يوجد ' + p + ' تعديل لم يُرفع بعد وسيُفقد عند الخروج. هل تريد الخروج؟' : 'تسجيل الخروج ومسح بيانات هذا الجهاز؟';
    if (!confirm(msg)) return;
    idbClear().then(function () { location.reload(); });
  }

  /* ---------- UI: login ---------- */
  var overlay = null;
  function closeOverlay() { if (overlay) { overlay.remove(); overlay = null; } }
  function showBlocked(msg) {
    injectCss(); closeOverlay();
    var bootEl = document.getElementById('boot'); if (bootEl) bootEl.hidden = true;
    var app = document.getElementById('app'); if (app) app.hidden = true;
    overlay = el('div', { class: 'rh-ov' }, [el('div', { class: 'rh-box' }, [
      el('h1', { text: 'رحلتي' }), el('p', { text: msg }),
      el('button', { class: 'rh-btn pri', type: 'button', text: 'العودة لتسجيل الدخول', on: { click: function () { idbClear().then(function () { location.reload(); }); } } })
    ])]);
    document.body.appendChild(overlay);
    if (pill) pill.remove(), pill = null;
  }
  /* يقبل: رمزاً من الرسالة، أو رابط الرسالة (token=…)، أو رابط التطبيق بعد الدخول (#access_token=…) */
  function verifyInput(t, email) {
    var i = t.indexOf('access_token=');
    if (i >= 0) {
      var q = new URLSearchParams(t.slice(i));
      if (q.get('access_token')) return Promise.resolve(sessionFrom({ access_token: q.get('access_token'), refresh_token: q.get('refresh_token'), expires_in: Number(q.get('expires_in')) || 3600 }));
    }
    var hash = '', type = '';
    if (/^https?:\/\//i.test(t) || /[?&](token|token_hash)=/.test(t)) {
      try {
        var u = new URL(t.indexOf('http') === 0 ? t : 'https://x/?' + t.replace(/^[?]/, ''));
        hash = u.searchParams.get('token_hash') || u.searchParams.get('token') || '';
        type = u.searchParams.get('type') || '';
      } catch (e) {}
      if (!hash) return Promise.resolve(null);
      var types = type ? [type] : ['magiclink', 'signup'];
      return tryTypes(types, function (ty) { return { type: ty, token_hash: hash }; });
    }
    var tok = t.replace(/\s+/g, '');
    return tryTypes(['email', 'signup', 'magiclink'], function (ty) { return { type: ty, email: email, token: tok }; });
  }
  function tryTypes(types, mk) {
    var i = 0;
    function next() {
      if (i >= types.length) return Promise.resolve(null);
      return authReq('/auth/v1/verify', mk(types[i++])).then(function (r) {
        if (r.ok && r.body.access_token) return sessionFrom(r.body);
        return next();
      });
    }
    return next();
  }
  var loginResolve = null, pendingErr = '';
  function showLogin(isOverlay) {
    injectCss(); closeOverlay();
    var bootEl = document.getElementById('boot'); if (bootEl && !isOverlay) bootEl.hidden = true;
    var email = '', stage = 1;
    var box = el('div', { class: 'rh-box' });
    overlay = el('div', { class: 'rh-ov' }, [box]);
    document.body.appendChild(overlay);
    function draw(msg, cls) {
      while (box.firstChild) box.removeChild(box.firstChild);
      box.appendChild(el('h1', { text: 'رحلتي' }));
      if (stage === 1) {
        box.appendChild(el('p', { text: 'سجّل الدخول ببريدك الإلكتروني. سيصلك رمز دخول (وأيضاً رابط).' }));
        var inp = el('input', { type: 'email', dir: 'ltr', inputmode: 'email', autocomplete: 'email', placeholder: 'name@example.com', id: 'rh-email', value: email });
        box.appendChild(el('label', { for: 'rh-email', text: 'البريد الإلكتروني' })); box.appendChild(inp);
        var b = el('button', { class: 'rh-btn pri', type: 'button', text: 'إرسال رمز الدخول' });
        b.addEventListener('click', function () {
          email = inp.value.trim().toLowerCase();
          if (!/^\S+@\S+\.\S+$/.test(email)) { draw('أدخل بريداً صحيحاً.', 'bad'); return; }
          b.disabled = true; b.textContent = 'جارٍ الإرسال…';
          authReq('/auth/v1/otp?redirect_to=' + encodeURIComponent(location.origin + location.pathname), { email: email, create_user: true }).then(function (r) {
            if (r.ok) { stage = 2; draw('تم الإرسال إلى ' + email + '. افتح الرسالة وأدخل الرمز هنا، أو اضغط الرابط الذي فيها.', 'good'); }
            else draw(r.status === 429 ? 'محاولات كثيرة. انتظر دقيقة ثم أعد المحاولة.' : (r.body && (r.body.msg || r.body.error_description)) || 'تعذّر الإرسال.', 'bad');
          }, function () { draw('لا يوجد اتصال بالإنترنت. أول تسجيل دخول يحتاج اتصالاً.', 'bad'); });
        });
        box.appendChild(b);
        inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') b.click(); });
        setTimeout(function () { inp.focus(); }, 50);
      } else {
        box.appendChild(el('p', { text: 'تم الإرسال إلى ' + email + '. أدخل الرمز الذي في الرسالة، أو الصق رابط الدخول الذي فيها (اضغط عليه مطوّلاً ثم «نسخ الرابط»).' }));
        var code = el('input', { type: 'text', dir: 'ltr', inputmode: 'text', autocomplete: 'one-time-code', autocapitalize: 'off', spellcheck: 'false', placeholder: '123456 أو https://…', id: 'rh-code' });
        box.appendChild(el('label', { for: 'rh-code', text: 'الرمز أو رابط الدخول' })); box.appendChild(code);
        var v = el('button', { class: 'rh-btn pri', type: 'button', text: 'دخول' });
        v.addEventListener('click', function () {
          var t = code.value.trim();
          if (t.length < 6) { draw('أدخل الرمز أو الصق الرابط.', 'bad'); return; }
          v.disabled = true; v.textContent = 'جارٍ التحقق…';
          verifyInput(t, email).then(function (sess) {
            if (sess) finishLogin(sess); else draw('الرمز أو الرابط غير صحيح أو انتهت صلاحيته. اطلب رسالة جديدة.', 'bad');
          }, function () { draw('لا يوجد اتصال بالإنترنت.', 'bad'); });
        });
        box.appendChild(v);
        code.addEventListener('keydown', function (e) { if (e.key === 'Enter') v.click(); });
        box.appendChild(el('button', { class: 'rh-link', type: 'button', text: 'تغيير البريد / إعادة الإرسال', on: { click: function () { stage = 1; draw(); } } }));
        setTimeout(function () { code.focus(); }, 50);
      }
      var m = pendingErr || msg, mc = pendingErr ? 'bad' : (cls || ''); pendingErr = '';
      if (m) box.appendChild(el('div', { class: 'rh-msg ' + mc, text: m }));
    }
    draw();
  }
  function finishLogin(s) {
    saveSession(s).then(function () {
      net.authLost = false; closeOverlay();
      if (loginResolve) { var f = loginResolve; loginResolve = null; f(); }
      else { sync(); updatePill(); }
    });
  }

  /* ---------- UI: staff management ---------- */
  function openStaff() {
    injectCss(); closeOverlay();
    var box = el('div', { class: 'rh-box rh-staff' });
    overlay = el('div', { class: 'rh-ov' }, [box]);
    document.body.appendChild(overlay);
    var listBox = el('div'), msgBox = el('div');
    function say(t, c) { msgBox.className = 'rh-msg ' + (c || ''); msgBox.textContent = t; drawList(); }
    function drawList() {
      while (listBox.firstChild) listBox.removeChild(listBox.firstChild);
      staffList.forEach(function (s) {
        var me = profile && s.email === profile.email, row = el('div', { class: 'rh-row' });
        row.appendChild(el('b', null, [s.name || s.email, el('small', { text: s.email + (me ? ' · أنت' : '') + (s.uid ? '' : ' · لم يدخل بعد') })]));
        if (me) row.appendChild(el('span', { text: ROLE_AR[s.role] }));
        else {
          var sel = el('select', { 'aria-label': 'الدور' }, ['employee', 'readonly', 'admin'].map(function (r) { var o = el('option', { value: r, text: ROLE_AR[r] }); if (r === s.role) o.selected = true; return o; }));
          sel.addEventListener('change', function () {
            api('/rest/v1/rh_staff?email=eq.' + encodeURIComponent(s.email), { method: 'PATCH', body: { role: sel.value }, headers: { Prefer: 'return=minimal' } })
              .then(function () { s.role = sel.value; say('تم تحديث الدور.', 'good'); }, function () { say('تعذّر التحديث (تحقق من الاتصال).', 'bad'); });
          });
          row.appendChild(sel);
          row.appendChild(el('button', { class: 'rh-btn sm', type: 'button', text: 'إزالة', on: { click: function () {
            if (!confirm('إزالة ' + (s.name || s.email) + ' من الموظفين؟')) return;
            api('/rest/v1/rh_staff?email=eq.' + encodeURIComponent(s.email), { method: 'DELETE', headers: { Prefer: 'return=minimal' } })
              .then(function () { staffList = staffList.filter(function (x) { return x.email !== s.email; }); metaSet('staff', staffList); say('تمت الإزالة.', 'good'); }, function () { say('تعذّرت الإزالة.', 'bad'); });
          } } }));
        }
        listBox.appendChild(row);
      });
    }
    var em = el('input', { type: 'email', dir: 'ltr', placeholder: 'البريد الإلكتروني', id: 'rh-s-email', 'aria-label': 'بريد الموظف' });
    var nm = el('input', { type: 'text', placeholder: 'الاسم', id: 'rh-s-name', 'aria-label': 'اسم الموظف' });
    var rl = el('select', { id: 'rh-s-role', 'aria-label': 'الدور' }, ['employee', 'readonly', 'admin'].map(function (r) { return el('option', { value: r, text: ROLE_AR[r] }); }));
    box.appendChild(el('h1', { text: 'الموظفون' }));
    box.appendChild(el('p', { text: 'أضف بريد الموظف واختر دوره. يدخل الموظف من رابط التطبيق ببريده ثم الرمز الذي يصله. يحتاج هذا الإجراء إلى اتصال.' }));
    box.appendChild(listBox);
    box.appendChild(el('h2', { text: 'إضافة موظف', style: 'font-size:16px;margin:16px 0 0' }));
    box.appendChild(el('label', { text: 'البريد' })); box.appendChild(em);
    box.appendChild(el('label', { text: 'الاسم' })); box.appendChild(nm);
    box.appendChild(el('label', { text: 'الدور' })); box.appendChild(rl);
    box.appendChild(el('button', { class: 'rh-btn pri', type: 'button', text: 'إضافة', on: { click: function () {
      var e = em.value.trim().toLowerCase();
      if (!/^\S+@\S+\.\S+$/.test(e)) { say('بريد غير صحيح.', 'bad'); return; }
      var nmv = nm.value.trim(), rlv = rl.value;
      api('/rest/v1/rh_staff', { method: 'POST', body: { email: e, name: nmv, role: rlv }, headers: { Prefer: 'return=minimal' } })
        .then(function () { staffList.push({ email: e, name: nmv, role: rlv, uid: null }); metaSet('staff', staffList); em.value = ''; nm.value = ''; say('تمت إضافة الموظف.', 'good'); },
          function (x) { say(x.status === 409 ? 'هذا البريد مضاف مسبقاً.' : 'تعذّرت الإضافة (تحقق من الاتصال).', 'bad'); });
    } } }));
    box.appendChild(el('button', { class: 'rh-link', type: 'button', text: 'إغلاق', on: { click: closeOverlay } }));
    box.appendChild(msgBox);
    drawList();
    loadStaff().then(drawList, function () { say('تعذّر تحميل القائمة (تحقق من الاتصال).', 'bad'); });
  }

  /* ---------- downloads ---------- */
  var MIME = { json: 'application/json', csv: 'text/csv;charset=utf-8', html: 'text/html;charset=utf-8', pdf: 'application/pdf', txt: 'text/plain;charset=utf-8', jpg: 'image/jpeg', png: 'image/png' };
  var dlApi = {
    save: function (req) {
      return new Promise(function (res, rej) {
        try {
          var name = String(req.filename || 'file'), ext = (name.split('.').pop() || '').toLowerCase();
          var d = req.data, blob = d instanceof Blob ? d : new Blob([d], { type: MIME[ext] || 'application/octet-stream' });
          var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.style.display = 'none';
          document.body.appendChild(a); a.click();
          setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
          res({ status: 'saved' });
        } catch (e) { rej({ code: 'unavailable', message: String(e) }); }
      });
    }
  };

  /* ---------- user ---------- */
  var userApi = {
    canEdit: function () { return Promise.resolve(!!(profile && profile.role === 'admin')); },
    can: function (s) { return Promise.resolve(s === 'data.write' ? !!(profile && (profile.role === 'admin' || profile.role === 'employee')) : true); },
    me: function () { return Promise.resolve(profile ? { id: profile.uid || (session && session.uid) || '', name: profile.name || profile.email, email: profile.email } : null); },
    profiles: function (ids) {
      var out = {};
      (staffList || []).forEach(function (s) { if (s.uid && (!ids || ids.indexOf(s.uid) >= 0)) out[s.uid] = { name: s.name || s.email }; });
      return Promise.resolve(out);
    }
  };

  /* ---------- boot ---------- */
  var readyP = null;
  function boot() {
    if (readyP) return readyP;
    readyP = new Promise(function (resolve, reject) {
      var hashSess = null, hashErr = '';
      try {
        var h = location.hash || '';
        if (/(^#|&)(access_token|error_description|error)=/.test(h)) {
          var q = new URLSearchParams(h.slice(1));
          if (q.get('access_token')) hashSess = sessionFrom({ access_token: q.get('access_token'), refresh_token: q.get('refresh_token'), expires_in: Number(q.get('expires_in')) || 3600 });
          else hashErr = 'انتهت صلاحية الرابط أو استُعمل من قبل. اطلب رمزاً جديداً.';
          history.replaceState(null, '', location.pathname + location.search);
        }
      } catch (e) {}
      pendingErr = hashErr;
      idbOpen().then(function () { return Promise.all([idbAll('docs'), idbAll('files'), idbAll('meta')]); }).then(function (a) {
        a[0].forEach(function (r) { collMap(r.coll).set(r.id, r); });
        a[1].forEach(function (r) { FILES.set(r.id, r); });
        a[2].forEach(function (m) { metaCache[m.k] = m.v; });
        session = metaGet('session') || null; profile = metaGet('profile') || null; staffList = metaGet('staff') || [];
        net.last = num(metaGet('last'));
        if (hashSess && profile && profile.email && hashSess.email && profile.email !== hashSess.email) {
          return idbClear().then(function () { DOCS.clear(); FILES.clear(); metaCache = {}; profile = null; staffList = []; net.last = 0; return saveSession(hashSess); });
        }
        return hashSess ? saveSession(hashSess) : null;
      }).then(function () {
        function enter() {
          bootedRole = profile && profile.role;
          if (!profile) { showBlocked('تعذّر تحديد صلاحيتك.'); return; }
          if (!bootedRole || (bootedRole !== 'admin' && bootedRole !== 'employee' && bootedRole !== 'readonly')) { showBlocked('لا تملك صلاحية.'); return; }
          closeOverlay(); ensurePill(); startPolling();
          var b = document.getElementById('boot'); if (b) b.hidden = false;
          resolve();
        }
        function firstSync() {
          // أول مرة: لا بد من تنزيل البيانات قبل فتح التطبيق حتى لا تظهر شاشة الإعداد الأولى بالخطأ
          var b = document.getElementById('boot'); if (b) { b.hidden = false; b.textContent = 'جارٍ تنزيل البيانات…'; }
          return touchMe().then(function () { return pull(); }).then(function () { net.last = nowMs(); net.initial = true; return metaSet('last', net.last); }).then(function () { loadStaff().catch(function () {}); enter(); sync(); }, function (e) {
            if (e.notStaff) { handleRemoved(); return; }
            if (e.net) { showBlocked('أول فتح للتطبيق على هذا الجهاز يحتاج اتصالاً بالإنترنت لتنزيل البيانات. اتصل ثم أعد المحاولة.'); return; }
            if (e.auth) { loginResolve = firstSync; showLogin(false); return; }
            showBlocked('تعذّر تنزيل البيانات (' + (e.status || '؟') + '). أعد المحاولة لاحقاً.');
          });
        }
        function go() {
          var synced = num(metaGet('cursor')) > 0 || !!metaGet('last');
          if (profile && synced) { enter(); sync(); } else firstSync();
        }
        if (!session) { loginResolve = go; showLogin(false); } else go();
      }).catch(function (e) { reject(e); });
    });
    return readyP;
  }

  window.claude = {
    use: function (name) {
      if (name === 'mcp') return Promise.resolve(null);
      return boot().then(function () {
        if (name === 'db') return dbApi;
        if (name === 'user') return userApi;
        if (name === 'downloads') return dlApi;
        return null;
      });
    }
  };
  window.RH = { sync: sync, openStaff: openStaff, signOut: signOut, net: net, pending: pendingCount, role: function () { return profile && profile.role; } };

  /* ---------- service worker ---------- */
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol) && !window.RH_NO_SW) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').then(function (reg) {
        reg.addEventListener('updatefound', function () {
          var w = reg.installing; if (!w) return;
          w.addEventListener('statechange', function () {
            if (w.state === 'installed' && navigator.serviceWorker.controller) { updateReady = true; updatePill(); }
          });
        });
      }).catch(function () {});
    });
  }
})();

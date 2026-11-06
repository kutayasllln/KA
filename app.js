/* KA Sabah Radarı — uygulama mantığı.
 *
 * Veri sözleşmesi (Apps Script uç noktası şu biçimde döner):
 * {
 *   generatedAt: <ms>,
 *   accounts: { A: "ad", B: "ad" },
 *   status:   { A: {lastOk, scanned, noise, error}, B: {...} },
 *   apps:     [{ id, acct: "A"|"B", who, subject, snippet, pill, time, link }],
 *   imps:     [{ ...aynı }],
 *   waiting:  [{ id, acct, who, subject, to, sentTime, days, link }]
 * }
 */
(function () {
  "use strict";

  var CFG = window.KA_CONFIG || {};
  var NAMES = CFG.accounts || { A: "A", B: "B" };
  var COLORS = { A: "#ff4d2e", B: "#9cc4ff" };
  var TZ_OFFSET = 3 * 3600000; // İstanbul sabit UTC+3
  var MONTHS = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
  var DAYS = ["Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"];
  var SCAN_HOURS = [9, 14, 17]; // A hesabının bildirim saatleri
  var FOLLOWUP_DAYS = 10;
  var TOKEN_KEY = "ka_token";
  var CACHE_KEY = "ka_cache_v1";

  var state = { filter: "all", data: null, demo: false, loadedAt: 0, loading: false, error: "" };

  // ───────── küçük yardımcılar ─────────
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function store(key, val) { try { if (val === null) localStorage.removeItem(key); else localStorage.setItem(key, val); } catch (e) { /* özel mod */ } }
  function load(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }

  function ist(ms) { return new Date(ms + TZ_OFFSET); }
  function clock(ms) { var d = ist(ms); return pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()); }
  function dayKey(ms) { var d = ist(ms); return d.getUTCFullYear() + "-" + d.getUTCMonth() + "-" + d.getUTCDate(); }
  function dateLabel(ms) { var d = ist(ms); return d.getUTCDate() + " " + MONTHS[d.getUTCMonth()]; }
  function relTime(ms) {
    var now = Date.now();
    if (dayKey(ms) === dayKey(now)) return "Bugün " + clock(ms);
    if (dayKey(ms) === dayKey(now - 86400000)) return "Dün " + clock(ms);
    return dateLabel(ms) + " " + clock(ms);
  }
  function hash(s) { var h = 2166136261; s = String(s); for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function safeLink(url) { return typeof url === "string" && /^https:\/\/mail\.google\.com\//.test(url) ? url : ""; }
  function acctName(k) { return (state.data && state.data.accounts && state.data.accounts[k]) || NAMES[k] || k; }

  function pillClass(p) {
    if (p === "Mülakat daveti" || p === "Teklif") return "filled";
    if (p === "Son tarih" || p === "Güvenlik" || p === "Acil" || p === "VIP") return "hot";
    if (p === "Randevu" || p === "Etkinlik" || p === "Değerlendirmede") return "ice";
    return "";
  }

  // ───────── örnek veri (gerçek veri bağlanana kadar) ─────────
  function demoData() {
    var now = Date.now(), H = 3600000, D = 86400000;
    return {
      generatedAt: now,
      accounts: NAMES,
      status: { A: { lastOk: now - 40 * 60000, scanned: 31, noise: 28 }, B: { lastOk: now - 100 * 60000, scanned: 16, noise: 14 } },
      apps: [
        { id: "d1", acct: "A", who: "Örnek Lojistik A.Ş.", subject: "Görüşme daveti: Operasyon Analisti", snippet: "Başvurunuzu inceledik. Salı günü 14:00 için online görüşme planlamak istiyoruz, uygun olup olmadığınızı bildirir misiniz?", pill: "Mülakat daveti", time: now - 2 * H, link: "https://mail.google.com/mail/" },
        { id: "d2", acct: "B", who: "Örnek Teknoloji", subject: "Başvurunuz alındı", snippet: "Başvurunuz değerlendirme sürecine alındı. Sonuç için 5 iş günü içinde dönüş yapılacaktır.", pill: "Değerlendirmede", time: now - 3 * H, link: "https://mail.google.com/mail/" }
      ],
      imps: [
        { id: "d3", acct: "A", who: "Banka bildirimi", subject: "Kart ekstreniz hazır", snippet: "Son ödeme tarihi 12 Kasım. Ekstreyi görüntülemek için uygulamaya girin.", pill: "Son tarih", time: now - 4 * H, link: "https://mail.google.com/mail/" },
        { id: "d4", acct: "B", who: "Üniversite Kariyer Merkezi", subject: "Kariyer günü kaydınız onaylandı", snippet: "Etkinlik yeri ve saatine ilişkin bilgiler ekte.", pill: "Etkinlik", time: now - D - 2 * H, link: "https://mail.google.com/mail/" }
      ],
      waiting: [
        { id: "w1", acct: "A", who: "Örnek Finans Grubu", subject: "Süreç Geliştirme Uzmanı başvurusu", sentTime: now - 11 * D, days: 11, link: "https://mail.google.com/mail/" },
        { id: "w2", acct: "B", who: "Örnek Üretim San.", subject: "Planlama Mühendisi başvurusu", sentTime: now - 9 * D, days: 9, link: "https://mail.google.com/mail/" },
        { id: "w3", acct: "A", who: "Örnek Danışmanlık", subject: "Junior Danışman başvurusu", sentTime: now - 4 * D, days: 4, link: "https://mail.google.com/mail/" }
      ]
    };
  }

  // ───────── veri yükleme ─────────
  function normalize(raw) {
    var d = raw && typeof raw === "object" ? raw : {};
    return {
      generatedAt: Number(d.generatedAt) || Date.now(),
      accounts: d.accounts || NAMES,
      status: d.status || {},
      apps: Array.isArray(d.apps) ? d.apps : [],
      imps: Array.isArray(d.imps) ? d.imps : [],
      waiting: Array.isArray(d.waiting) ? d.waiting : []
    };
  }

  function fetchData() {
    var token = load(TOKEN_KEY) || "";
    if (!CFG.dataUrl) { state.demo = true; state.data = demoData(); state.error = ""; return Promise.resolve(); }
    if (!token) { state.demo = true; state.data = demoData(); state.error = "token"; return Promise.resolve(); }
    var url = CFG.dataUrl + (CFG.dataUrl.indexOf("?") === -1 ? "?" : "&") + "token=" + encodeURIComponent(token);
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 25000) : null;
    return fetch(url, { redirect: "follow", signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { if (!r.ok) throw new Error("Sunucu " + r.status); return r.json(); })
      .then(function (j) {
        if (j && j.error) throw new Error(j.error === "unauthorized" ? "Anahtar geçersiz" : String(j.error));
        state.demo = false; state.error = "";
        state.data = normalize(j);
        store(CACHE_KEY, JSON.stringify(state.data));
      })
      .catch(function (e) {
        var cached = load(CACHE_KEY);
        state.error = "fetch:" + (e && e.name === "AbortError" ? "Zaman aşımı" : (e && e.message) || "bağlantı hatası");
        if (cached) { try { state.data = normalize(JSON.parse(cached)); state.demo = false; return; } catch (x) { /* bozuk önbellek */ } }
        state.demo = true; state.data = demoData();
      })
      .then(function () { if (timer) clearTimeout(timer); });
  }

  function refresh() {
    if (state.loading) return;
    state.loading = true;
    $("refreshBtn").disabled = true;
    $("refreshBtn").textContent = "…";
    fetchData().then(function () {
      state.loading = false; state.loadedAt = Date.now();
      $("refreshBtn").disabled = false; $("refreshBtn").textContent = "Yenile";
      render();
    });
  }

  // ───────── çizim ─────────
  function shownFor(list) {
    return list.filter(function (m) { return state.filter === "all" || m.acct === state.filter; });
  }

  function acctDot(k) {
    var s = el("span", "pdot"); s.style.background = COLORS[k] || "#aaa398"; return s;
  }

  function linkEl(url, text) {
    var safe = safeLink(url);
    if (!safe) return null;
    var a = el("a", "open", text);
    a.href = safe; a.target = "_blank"; a.rel = "noopener noreferrer";
    return a;
  }

  function mailRow(m) {
    var row = el("article", "row-item");
    var top = el("div", "row-top");
    top.appendChild(el("span", "who", m.who || "Bilinmeyen gönderen"));
    if (m.pill) top.appendChild(el("span", "pill " + pillClass(m.pill), m.pill));
    row.appendChild(top);
    row.appendChild(el("span", "subject", m.subject || "(konu yok)"));
    if (m.snippet) row.appendChild(el("span", "snippet", m.snippet));
    var meta = el("div", "row-meta");
    var a = el("span", "acct"); a.appendChild(acctDot(m.acct)); a.appendChild(document.createTextNode(acctName(m.acct)));
    meta.appendChild(a);
    meta.appendChild(el("span", "time", relTime(Number(m.time))));
    row.appendChild(meta);
    var l = linkEl(m.link, "Gmail'de aç ↗"); if (l) row.appendChild(l);
    return row;
  }

  function waitRow(w) {
    var days = Number(w.days) || 0;
    var due = days >= FOLLOWUP_DAYS, soon = days >= 7 && !due;
    var row = el("article", "row-item");
    var top = el("div", "row-top");
    top.appendChild(el("span", "who", w.who || "Bilinmeyen alıcı"));
    top.appendChild(el("span", "pill " + (due ? "filled" : (soon ? "hot" : "")), due ? "Takip zamanı" : (soon ? "Yakında takip" : "Bekleniyor")));
    row.appendChild(top);
    row.appendChild(el("span", "subject", w.subject || "(konu yok)"));
    var wd = el("div", "wait-days");
    var d = el("span", "d", String(days)); if (due) d.style.color = "var(--accent)";
    wd.appendChild(d); wd.appendChild(el("span", "t", "gündür sessiz"));
    row.appendChild(wd);
    var bar = el("div", "bar " + (due ? "due" : (soon ? "soon" : ""))); var fill = el("i"); fill.style.width = Math.min(100, Math.round(days / FOLLOWUP_DAYS * 100)) + "%"; bar.appendChild(fill);
    row.appendChild(bar);
    var meta = el("div", "row-meta");
    var a = el("span", "acct"); a.appendChild(acctDot(w.acct)); a.appendChild(document.createTextNode(acctName(w.acct)));
    meta.appendChild(a);
    if (w.sentTime) meta.appendChild(el("span", "time", "Gönderildi: " + dateLabel(Number(w.sentTime))));
    row.appendChild(meta);
    var l = linkEl(w.link, "Gönderilen maili aç ↗"); if (l) row.appendChild(l);
    return row;
  }

  function fillList(node, items, builder, emptyText) {
    clear(node);
    if (!items.length) { node.appendChild(el("div", "empty", emptyText)); return; }
    items.forEach(function (it) { node.appendChild(builder(it)); });
  }

  function statBox(n, label, cls) {
    var s = el("div", "stat " + (cls || "")); s.appendChild(el("span", "n", String(n))); s.appendChild(el("span", "l", label)); return s;
  }

  function lastScanMs(d) {
    var best = 0;
    ["A", "B"].forEach(function (k) {
      if (state.filter !== "all" && state.filter !== k) return;
      var s = d.status && d.status[k]; if (s && Number(s.lastOk) > best) best = Number(s.lastOk);
    });
    return best || d.generatedAt;
  }

  function nextScanLabel(now) {
    var d = ist(now), h = d.getUTCHours() + d.getUTCMinutes() / 60;
    for (var i = 0; i < SCAN_HOURS.length; i++) if (SCAN_HOURS[i] > h) return "bugün " + pad(SCAN_HOURS[i]) + ":00 civarı";
    return "yarın " + pad(SCAN_HOURS[0]) + ":00 civarı";
  }

  function renderNotice(d) {
    var n = $("notice"); clear(n); n.hidden = true; n.className = "notice";
    function say(strongText, rest, warn) {
      n.hidden = false; if (warn) n.className = "notice warn";
      n.appendChild(el("strong", "", strongText)); n.appendChild(document.createTextNode(" " + rest));
    }
    if (!CFG.dataUrl) { say("Örnek veri gösteriliyor.", "Gerçek mailler, sistem bağlanınca burada görünecek.", false); return; }
    if (state.error === "token") { say("Bağlantı anahtarı girilmedi.", "Aşağıdaki “Bağlantı ayarı” bölümünden anahtarı gir. Şimdilik örnek veri var.", true); return; }
    if (state.error.indexOf("fetch:") === 0) { say("Güncel veri alınamadı", "(" + state.error.slice(6) + "). Son kaydedilen veri gösteriliyor.", true); return; }
    var sb = d.status && d.status.B;
    if (sb && Date.now() - Number(sb.lastOk || 0) > 6 * 3600000) say(acctName("B") + " taraması eski.", "Son başarılı tarama: " + relTime(Number(sb.lastOk)) + ".", true);
    else if (sb && sb.error) say(acctName("B") + " tarama hatası:", String(sb.error).slice(0, 120), true);
  }

  function renderRadar(items) {
    var box = $("blips"); clear(box);
    items.forEach(function (m) {
      var h = hash(m.id || (m.who + m.subject));
      var ang = (h % 360) * Math.PI / 180, rad = 0.2 + ((h >>> 9) % 70) / 100 * 0.62; // 0.2 – 0.82
      var b = el("span", "blip");
      b.style.left = (50 + Math.cos(ang) * rad * 50) + "%";
      b.style.top = (50 + Math.sin(ang) * rad * 50) + "%";
      var c = COLORS[m.acct] || COLORS.A; b.style.background = c; b.style.color = c;
      box.appendChild(b);
    });
  }

  function render() {
    var d = state.data; if (!d) return;
    var apps = shownFor(d.apps), imps = shownFor(d.imps), wait = shownFor(d.waiting);
    var now = Date.now();

    // üst bilgi
    var t = ist(now);
    $("scanInfo").textContent = DAYS[t.getUTCDay()] + " " + t.getUTCDate() + " " + MONTHS[t.getUTCMonth()] + " · Son tarama " + clock(lastScanMs(d));
    renderNotice(d);

    // hero
    $("heroCount").textContent = pad(apps.length);
    $("heroTitle").textContent = apps.length > 0 ? "başvuru cevabı\nbugün geldi." : "yeni cevap yok,\nbugün sessiz.";
    var invite = apps.filter(function (m) { return m.pill === "Mülakat daveti"; })[0];
    var due = wait.filter(function (w) { return Number(w.days) >= FOLLOWUP_DAYS; });
    var oldest = wait.reduce(function (a, w) { return Math.max(a, Number(w.days) || 0); }, 0);
    var lead;
    if (invite) lead = invite.who + " seni görüşmeye davet ediyor. Önce buna cevap ver.";
    else if (apps.length) lead = "Davet yok ama cevap var. Detaylar aşağıda.";
    else lead = wait.length ? wait.length + " başvurun cevap bekliyor, en eskisi " + oldest + " gündür sessiz." : "Bekleyen başvuru da yok.";
    if (due.length) lead += " Takip maili zamanı gelen: " + due.length + ".";
    $("heroLead").textContent = lead;
    $("heroEyebrow").textContent = state.demo ? "Örnek veri" : "Canlı tarama · 2 hesap";
    renderRadar(apps.concat(imps));

    // hesap düğmeleri
    var tabs = $("tabs"); clear(tabs);
    [["all", "Tümü", "#efe9df"], ["A", acctName("A"), COLORS.A], ["B", acctName("B"), COLORS.B]].forEach(function (def) {
      var count = d.apps.concat(d.imps).filter(function (m) { return def[0] === "all" || m.acct === def[0]; }).length;
      var b = el("button"); b.type = "button"; b.setAttribute("aria-pressed", state.filter === def[0] ? "true" : "false");
      var dot = el("span", "pdot"); dot.style.background = def[2]; b.appendChild(dot);
      b.appendChild(el("span", "", def[1])); b.appendChild(el("span", "num", pad(count)));
      b.addEventListener("click", function () { state.filter = def[0]; render(); });
      tabs.appendChild(b);
    });

    // istatistikler
    var scanned = 0, noise = 0;
    ["A", "B"].forEach(function (k) {
      if (state.filter !== "all" && state.filter !== k) return;
      var s = d.status && d.status[k]; if (s) { scanned += Number(s.scanned) || 0; noise += Number(s.noise) || 0; }
    });
    var stats = $("stats"); clear(stats);
    stats.appendChild(statBox(scanned, "Taranan mail"));
    stats.appendChild(statBox(noise, "Gürültü, ayıklandı", "dim"));
    stats.appendChild(statBox(apps.length + imps.length, "Sana kalan", "hot"));
    stats.appendChild(statBox(wait.length, "Cevap bekleyen"));

    // listeler
    fillList($("apps"), apps, mailRow, "Bugün başvuru cevabı yok. Cevap geldiğinde burada görünür.");
    fillList($("waiting"), wait, waitRow, "Cevap bekleyen başvuru yok.");
    fillList($("imps"), imps, mailRow, "Bugün önemli mail yok.");
    $("appsCount").textContent = pad(apps.length);
    $("waitCount").textContent = pad(wait.length);
    $("impsCount").textContent = pad(imps.length);

    $("footLeft").textContent = state.demo ? "Örnek veri gösteriliyor" : "Gmail · 2 hesap";
    $("footRight").textContent = "Sonraki tarama " + nextScanLabel(now);
  }

  // ───────── bağlantı anahtarı ─────────
  function setupToken() {
    var input = $("tokenInput");
    input.value = load(TOKEN_KEY) ? "••••••••" : "";
    $("tokenSave").addEventListener("click", function () {
      var v = input.value.trim();
      if (!v || /^•+$/.test(v)) return;
      store(TOKEN_KEY, v); input.value = "••••••••"; $("settings").open = false; refresh();
    });
    $("tokenClear").addEventListener("click", function () { store(TOKEN_KEY, null); store(CACHE_KEY, null); input.value = ""; refresh(); });
    $("settings").open = !!CFG.dataUrl && !load(TOKEN_KEY);
  }

  // ───────── bildirimler (OneSignal) ─────────
  function isStandalone() {
    return window.navigator.standalone === true || (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  }
  function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); }

  function setupPush() {
    var btn = $("notifBtn"), hint = $("pushHint");
    if (!CFG.oneSignalAppId) {
      btn.disabled = true; btn.textContent = "Bildirimleri aç";
      hint.textContent = "Bildirim servisi henüz bağlanmadı. Sistem kurulumunda açılacak.";
      return;
    }
    if (isIOS() && !isStandalone()) {
      btn.hidden = true;
      hint.textContent = "Bildirim için önce uygulamayı ana ekrana ekle: Safari’de Paylaş düğmesi, ardından “Ana Ekrana Ekle”. Sonra KA ikonundan aç.";
      return;
    }
    btn.disabled = true; hint.textContent = "Bildirim servisi yükleniyor…";
    window.OneSignalDeferred = window.OneSignalDeferred || [];
    window.OneSignalDeferred.push(function (OneSignal) {
      OneSignal.init({
        appId: CFG.oneSignalAppId,
        serviceWorkerPath: "KA/OneSignalSDKWorker.js",
        serviceWorkerParam: { scope: "/KA/" }
      }).then(function () {
        function paint() {
          var on = OneSignal.Notifications.permission === true;
          btn.disabled = on;
          btn.textContent = on ? "Bildirimler açık ✓" : "Bildirimleri aç";
          hint.textContent = on ? "Radar mesajları bu telefona gelecek." : "Düğmeye basınca iPhone izin soracak, “İzin Ver” de.";
        }
        btn.addEventListener("click", function () { OneSignal.Notifications.requestPermission().then(paint); });
        paint();
      }).catch(function (e) { hint.textContent = "Bildirim servisi başlatılamadı: " + ((e && e.message) || "bilinmeyen hata"); });
    });
    var s = document.createElement("script");
    s.src = "https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js"; s.defer = true;
    s.onerror = function () { hint.textContent = "Bildirim servisine ulaşılamadı. İnterneti kontrol et."; };
    document.head.appendChild(s);
  }

  // ───────── başlat ─────────
  document.addEventListener("DOMContentLoaded", function () {
    $("refreshBtn").addEventListener("click", refresh);
    setupToken();
    setupPush();
    refresh();
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && Date.now() - state.loadedAt > 60000) refresh();
    });
  });

  // test için
  window.__KA = { state: state, render: render, pillClass: pillClass, safeLink: safeLink, relTime: relTime, clock: clock, demoData: demoData };
})();

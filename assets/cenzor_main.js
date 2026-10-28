// cenzor_main.js — [AGENT-EXP] 2026-10-19: 🤐 Cenzor przekleństw (świat MAIN, document_start).
// Port „Netflix Cenzor 4.5.2” / „YouTube Cenzor 1.1.0” (userscript). Wycisza ORYGINALNY dźwięk filmu
// (video.muted) — lektor ścisza film przez video.volume, więc oba mechanizmy się nie gryzą, a głos
// lektora (osobne audio) gra dalej.
// Dwa tryby, osobne opcje w Ustawieniach (src/options/options.js, sekcja „🤐 Cenzor przekleństw”):
//  1) cenzorOn — Z POBRANYCH NAPISÓW (YouTube): łapie odpowiedzi /api/timedtext (te, które pobiera
//     odtwarzacz i yt_subs_bridge.js lektora — ten plik jest w manifeście PRZED nim, więc jego
//     origFetch to nasz fetch), a gdy nic nie przyszło — sam każe odtwarzaczowi załadować ścieżkę
//     (ta sama metoda co getRaw w yt_subs_bridge.js). Wszystkie słowa są znane z góry, więc cisza
//     wchodzi PRZED słowem — także wtedy, gdy lektor nic nie mówi.
//  2) cenzorLive — NA BIEŻĄCO, bez pobierania: czyta napisy widoczne na ekranie (YouTube, Netflix,
//     Prime, selektory z Kreatora napisów, ścieżki <track> odtwarzacza HTML5) i szacuje modelem
//     segmentowym, kiedy padnie słowo. [AGENT-EXP] 2026-10-20: osobno czyta też polskie tłumaczenie
//     Immersive Translate (TR_SELECTORS). Działa na wszystkich stronach lektora. Przy włączonym 1)
//     jest tylko zapasem, gdy napisów z sieci brak.
// Zawsze wycisza TYLKO samo słowo (nie całą kwestię). Nie słucha dźwięku — wyłącznie tekst napisów.
// Działa niezależnie od tego, czy lektor jest włączony (własne skrypty, własne opcje).
// Ustawienia przychodzą z cenzor_bridge.js (świat ISOLATED, chrome.storage) przez postMessage.
// Diagnostyka w konsoli: lektorCenzor.status()
(function () {
    'use strict';
    if (window.__lektorCenzor) return;
    window.__lektorCenzor = true;

    var TAG = '__lektorCenzor';
    var IS_YT = /(^|\.)youtube(-nocookie)?\.com$/.test(location.hostname);

    /* ---------------- ustawienia ---------------- */

    var DEFAULT_WORDS = [
        'kurw*', 'kurew*', 'nakurw*', 'wkurw*', 'zakurw*', 'rozkurw*', 'pokurw*', 'skurwysyn*', 'skurwi*',
        'chuj*', 'huj*', 'pizd*', 'spizdz*', 'wypizdz*', 'przypizdz*', 'zapizdz*', 'popizdz*', 'podpizdz*',
        'cip*', 'dziwk*', 'jeb*', 'wjeb*', 'podjeb*', 'przyjeb*', 'ujeb*',
        'pierdol*', 'pierdal*', 'spierdol*', 'spierdal*', 'wypierdol*', 'wypierdal*',
        'odpierdol*', 'odpierdal*', 'napierdal*', 'rozpierdal*', 'zapierdal*',
        'przepierdal*', 'opierdal*', 'wpierdal*', 'dopierdol*', 'dopierdal*',
        'przypierdol*', 'przypierdal*', 'podpierdol*', 'podpierdal*', 'popierdol*', 'popierdal*',
        'zajeb*', 'dojeb*', 'pojeb*', 'najeb*', 'wyjeb*', 'odjeb*', 'rozjeb*', 'przejeb*',
        'fuck*', 'motherfuck*', 'shit*', 'bitch*', 'cunt*'
    ].join(', ');

    var opt = {
        cenzorOn: false,
        cenzorLive: false,
        cenzorBufferMs: 500,
        cenzorHoldMs: 100,
        cenzorLenMode: 'normal',
        cenzorTextRate: 1,     // [AGENT-EXP] 2026-10-20: tempo tekstu (suwak), gdy cenzorTextAuto wył.
        cenzorTextAuto: true,  // [AGENT-EXP] 2026-10-20: tempo tekstu = tempo filmu (jak dotąd)
        cenzorAsrTag: true,
        cenzorWords: '',
        cenzorNfPl: true,      // Netflix: zawsze cały polski plik napisów
        cenzorYtPl: true,      // YouTube: zawsze polskie napisy (ręczne → auto → tłumaczenie YouTube)
        selectors: []          // Kreator napisów dla tej strony (z cenzor_bridge.js)
    };

    function num(v, min, max, def) { var n = Number(v); return isFinite(n) ? Math.min(max, Math.max(min, n)) : def; }

    function applyOpts(o) {
        if (!o || typeof o !== 'object') return;
        var wasOn = opt.cenzorOn || opt.cenzorLive;
        opt.cenzorOn = !!o.cenzorOn;
        opt.cenzorLive = !!o.cenzorLive;
        opt.cenzorBufferMs = num(o.cenzorBufferMs, 0, 3000, 500);
        opt.cenzorHoldMs = num(o.cenzorHoldMs, 0, 2000, 100);
        opt.cenzorLenMode = ['off', 'normal', 'strong'].indexOf(o.cenzorLenMode) >= 0 ? o.cenzorLenMode : 'normal';
        opt.cenzorTextRate = num(o.cenzorTextRate, 0.25, 2.5, 1);   // [AGENT-EXP] 2026-10-20
        opt.cenzorTextAuto = o.cenzorTextAuto !== false;
        opt.cenzorAsrTag = o.cenzorAsrTag !== false;
        opt.cenzorWords = typeof o.cenzorWords === 'string' ? o.cenzorWords : '';
        opt.cenzorNfPl = o.cenzorNfPl !== false;
        opt.cenzorYtPl = o.cenzorYtPl !== false;
        opt.selectors = Array.isArray(o.selectors) ? o.selectors.filter(function (s) { return typeof s === 'string' && s.trim(); }) : [];
        buildRegex();
        windows = []; plannedFor = -1;
        liveWins = []; liveSeen = new Set(); lastSubs = { nat: '', tr: '' }; natChangedAt = -1;   // [AGENT-EXP] 2026-10-20
        if (cueMode) planFromCues();
        if (wasOn && !(opt.cenzorOn || opt.cenzorLive)) applyMute(false);
    }

    window.addEventListener('message', function (ev) {
        if (ev.source !== window || ev.origin !== location.origin) return;
        var d = ev.data;
        if (d && d[TAG] === 'opts') applyOpts(d.opts);
    });

    /* ---------------- 1) napisy z sieci (YouTube /api/timedtext) ---------------- */

    var cuesByVid = new Map();
    var ytLang = new Map();     // YouTube: język napisów, z których wyciszamy (vid -> 'pl', 'en'…)
    function isPl(l) { return /^pl/i.test(String(l || '')); }
    var cues = [];
    var cueMode = false;
    var lastTrackInfo = '';

    function isTimedtextUrl(u) { return typeof u === 'string' && u.indexOf('/api/timedtext') >= 0; }
    function paramOf(u, name) { try { return new URL(u, location.href).searchParams.get(name) || ''; } catch (e) { return ''; } }

    function decodeEntities(s) {
        return String(s)
            .replace(/&#(\d+);/g, function (m, n) { return String.fromCodePoint(+n); })
            .replace(/&#x([0-9a-f]+);/gi, function (m, n) { return String.fromCodePoint(parseInt(n, 16)); })
            .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&');
    }

    // Skleja kawałki w linię i pamięta, gdzie zaczyna się każdy kawałek (auto-napisy: czas słowa).
    function joinPieces(pieces) {
        var text = '', segs = [];
        pieces.forEach(function (p) {
            var r = String(p.text || '').replace(/\s+/g, ' ');
            if (!r.trim()) { if (text && text.slice(-1) !== ' ') text += ' '; return; }
            if ((!text || text.slice(-1) === ' ') && r.charAt(0) === ' ') r = r.replace(/^ +/, '');
            var lead = r.length - r.replace(/^ +/, '').length;
            segs.push({ off: text.length + lead, t: p.t });
            text += r;
        });
        return { text: text.replace(/ +$/, ''), segs: segs };
    }

    function parseJson3(obj) {
        var out = [];
        ((obj && obj.events) || []).forEach(function (ev) {
            if (!ev || !ev.segs || typeof ev.tStartMs !== 'number') return;
            var t0 = ev.tStartMs / 1000;
            var dur = (typeof ev.dDurationMs === 'number' ? ev.dDurationMs : 2000) / 1000;
            var j = joinPieces(ev.segs.map(function (s) {
                return { text: (s && s.utf8) || '', t: t0 + ((s && typeof s.tOffsetMs === 'number') ? s.tOffsetMs / 1000 : 0) };
            }));
            if (!j.text) return;
            var wordLevel = j.segs.length > 1 && j.segs.some(function (s) { return s.t !== t0; });
            out.push({ start: t0, end: t0 + Math.max(0.1, dur), text: j.text, segs: wordLevel ? j.segs : null, rawSegs: j.segs });
        });
        return wordLevelFile(out);
    }

    // [AGENT-EXP] 2026-10-20: gdy plik ma czasy słów (auto-napisy), linia z JEDNYM słowem też je ma — słowo zaczyna
    // się na początku linii. Wcześniej taka linia szła modelem proporcji, a auto-napisy trzymają linię długo
    // (np. „kurwa” wisi 3 s) → cisza na całe 3 s zamiast na samo słowo.
    function wordLevelFile(out) {
        var any = out.some(function (c) { return c.segs; });
        out.forEach(function (c) {
            if (any && !c.segs && c.rawSegs && c.rawSegs.length) c.segs = c.rawSegs;
            delete c.rawSegs;
        });
        return out;
    }

    // XML bez DOMParser (YouTube wymusza Trusted Types).
    function parseXml(xml) {
        var out = [], m;
        var stripTags = function (s) { return decodeEntities(s.replace(/<[^>]*>/g, '')); };
        var attr = function (a, n) { var r = a.match(new RegExp('\\b' + n + '="([^"]*)"')); return r ? r[1] : null; };
        var reP = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
        while ((m = reP.exec(xml))) {
            var t = +attr(m[1], 't'), d = +attr(m[1], 'd');
            if (!isFinite(t)) continue;
            var t0 = t / 1000, pieces = [], s;
            var reS = /<s\b([^>]*)>([\s\S]*?)<\/s>/g;
            while ((s = reS.exec(m[2]))) {
                var off = +attr(s[1], 't');
                pieces.push({ text: stripTags(s[2]), t: t0 + (isFinite(off) ? off / 1000 : 0) });
            }
            if (!pieces.length) pieces.push({ text: stripTags(m[2]), t: t0 });
            var j = joinPieces(pieces);
            if (!j.text) continue;
            var wl = j.segs.length > 1 && j.segs.some(function (x) { return x.t !== t0; });
            out.push({ start: t0, end: t0 + Math.max(0.1, (isFinite(d) ? d : 2000) / 1000), text: j.text, segs: wl ? j.segs : null, rawSegs: j.segs });
        }
        if (out.length) return wordLevelFile(out);   // [AGENT-EXP] 2026-10-20
        var reT = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
        while ((m = reT.exec(xml))) {
            var st = +attr(m[1], 'start'), du = +attr(m[1], 'dur');
            if (!isFinite(st)) continue;
            var tx = stripTags(decodeEntities(m[2])).replace(/\s+/g, ' ').trim();
            if (tx) out.push({ start: st, end: st + Math.max(0.1, isFinite(du) ? du : 2), text: tx, segs: null });
        }
        return out;
    }

    function parseVtt(txt) {
        var out = [];
        var tm = function (s) {
            var p = s.trim().split(':').map(Number);
            if (p.some(function (x) { return !isFinite(x); })) return NaN;
            return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
        };
        txt.replace(/\r/g, '').split(/\n\n+/).forEach(function (b) {
            var lines = b.split('\n');
            var i = lines.findIndex(function (l) { return l.indexOf('-->') >= 0; });
            if (i < 0) return;
            var parts = lines[i].split('-->');
            var st = tm(parts[0]), en = tm(parts[1].trim().split(/\s+/)[0]);
            if (!isFinite(st) || !isFinite(en)) return;
            var tx = decodeEntities(lines.slice(i + 1).join(' ').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
            if (tx) out.push({ start: st, end: Math.max(en, st + 0.1), text: tx, segs: null });
        });
        return out;
    }

    function parseTimedtext(body) {
        if (body && typeof body === 'object') return parseJson3(body);
        var s = String(body || '').trim();
        if (!s) return [];
        if (s.charAt(0) === '{') { try { return parseJson3(JSON.parse(s)); } catch (e) { return []; } }
        if (s.charAt(0) === '<') return parseXml(s);
        if (s.indexOf('-->') >= 0) return parseVtt(s);
        return [];
    }

    function onTimedtext(url, body) {
        var list;
        try { list = parseTimedtext(body); } catch (e) { list = []; }
        if (!list.length) return;
        list.sort(function (a, b) { return a.start - b.start; });
        var vid = paramOf(url, 'v') || currentVid() || '?';
        var tl = paramOf(url, 'tlang'), lang = String(tl || paramOf(url, 'lang')).toLowerCase();
        // Druga ścieżka tego samego filmu (inny język) ZASTĘPUJE poprzednią — dwa sklejone języki
        // dawałyby fałszywe okna ciszy. [AGENT-EXP] 2026-10-19: przy cenzorYtPl polskie napisy wygrywają
        // (gdy już są, inny język ich nie nadpisze, np. po przywróceniu angielskich CC użytkownika).
        // Bez tej opcji — jak dawniej: auto-tłumaczenie YouTube (tlang) nie nadpisuje oryginału.
        if (opt.cenzorYtPl) { if (isPl(ytLang.get(vid)) && !isPl(lang)) return; }
        else if (tl && cuesByVid.has(vid)) return;
        cuesByVid.delete(vid);
        cuesByVid.set(vid, list);
        ytLang.set(vid, lang);
        while (cuesByVid.size > 20) { var old = cuesByVid.keys().next().value; cuesByVid.delete(old); ytLang.delete(old); }
        lastTrackInfo = (lang || '?') + (tl ? ' (tłumaczenie YouTube)' : paramOf(url, 'kind') === 'asr' ? ' (auto)' : '')
            + ', ' + list.length + ' kwestii' + (list.some(function (c) { return c.segs; }) ? ', czasy słów' : '');
        if (vid === currentVid()) useCuesFor(vid);
    }

    function useCuesFor(vid) {
        cues = cuesByVid.get(vid) || [];
        cueMode = cues.length > 0;
        windows = []; plannedFor = -1;
        if (cueMode) planFromCues();
    }

    var origFetch = window.fetch;
    if (IS_YT) {
        try {
            window.fetch = function (input) {
                var p = origFetch.apply(this, arguments);
                try {
                    var url = (input && typeof input === 'object' && 'url' in input) ? input.url : String(input);
                    if (isTimedtextUrl(url)) {
                        p.then(function (res) {
                            try { res.clone().text().then(function (t) { onTimedtext(url, t); }).catch(function () {}); } catch (e) {}
                        }).catch(function () {});
                    }
                } catch (e) {}
                return p;
            };
        } catch (e) {}
        try {
            var XP = XMLHttpRequest.prototype, oOpen = XP.open, oSend = XP.send;
            XP.open = function (m, url) { try { this.__czUrl = String(url); } catch (e) {} return oOpen.apply(this, arguments); };
            XP.send = function () {
                try {
                    if (isTimedtextUrl(this.__czUrl)) {
                        var x = this;
                        x.addEventListener('load', function () {
                            try {
                                var rt = x.responseType, body;
                                if (!rt || rt === 'text') body = x.responseText;
                                else if (rt === 'json') body = x.response;
                                else if (rt === 'arraybuffer') body = new TextDecoder().decode(x.response);
                                else return;
                                onTimedtext(x.responseURL || x.__czUrl, body);
                            } catch (e) {}
                        });
                    }
                } catch (e) {}
                return oSend.apply(this, arguments);
            };
        } catch (e) {}
    }

    /* ---------------- 1b) NETFLIX: całe napisy z góry ---------------- */
    // [AGENT-EXP] 2026-10-19: Netflix ładuje napisy wybranej ścieżki PARTIAMI. Pełny plik każdej ścieżki jest
    // w manifeście filmu (timedtexttracks → ttDownloadables) — tak jak robią programy do pobierania napisów:
    //  - JSON.stringify: do zapytania o manifest dopisujemy formaty pełnych plików (WebVTT, DFXP)
    //    i showAllSubtitles (wszystkie języki mają wtedy adresy),
    //  - JSON.parse: z odpowiedzi bierzemy listę ścieżek (movieId = id odcinka z /watch/<id>),
    //  - opcja cenzorNfPl: od razu ściągamy CAŁY polski plik (nie trzeba go wybierać w odtwarzaczu).
    // Drugie źródło: napisy wybrane w odtwarzaczu (inject.js lektora → LIVEDUB_SUBTITLE_DATA, partiami).
    // [AGENT-EXP] 2026-10-19: cenzor NIE słucha dźwięku — pracuje wyłącznie na tekście napisów. Gdy cały polski
    // plik jest pobrany, tylko on się liczy (wystarcza); napisy z odtwarzacza są zapasem, gdy pliku brak.
    var IS_NF = /(^|\.)netflix\.com$/.test(location.hostname);
    var NF_PROFILES = ['webvtt-lssdh-ios8', 'dfxp-ls-sdh'];
    var NF_FORMATS = NF_PROFILES.concat(['imsc1.1']);   // imsc1.1 = TTML, Netflix daje go domyślnie
    var nfTracks = new Map();   // movieId -> timedtexttracks
    var nfStore = new Map();    // movieId -> { file: cues|null, fileLang, sel: { klucz: cues } }
    var nfFetched = new Set();  // movieId|język — już ściągnięte (albo w trakcie)

    function nfEntry(vid) {
        var e = nfStore.get(vid);
        if (!e) { e = { file: null, fileLang: '', sel: Object.create(null), sent: 0 }; nfStore.set(vid, e); }
        while (nfStore.size > 20) nfStore.delete(nfStore.keys().next().value);
        return e;
    }


    function nfRebuild(vid) {
        var e = nfStore.get(vid);
        if (!e) return;
        var all = [];
        // [AGENT-EXP] 2026-10-19: cały polski plik WYSTARCZA — napisy z odtwarzacza tylko, gdy go brak.
        if (e.file) e.file.forEach(function (c) { all.push(c); });
        else for (var k in e.sel) e.sel[k].forEach(function (c) { all.push(c); });
        all.sort(function (a, b) { return a.start - b.start; });
        cuesByVid.set(vid, all);
        lastTrackInfo = (e.file ? 'cały plik ' + (e.fileLang || '?') + ' (' + e.file.length + ')' : 'bez pełnego pliku')
            + ', z odtwarzacza: ' + Object.keys(e.sel).length;
        if (vid === currentVid()) useCuesFor(vid);
    }

    // TTML/DFXP Netflixa: <p begin="123t" end="456t">…<br/>…</p>, ttp:tickRate; też zapis zegarowy.
    function parseTtml(xml) {
        var out = [], m;
        var tr = xml.match(/tickRate="(\d+)"/);
        var tick = tr ? +tr[1] : 10000000;
        var tm = function (s) {
            if (!s) return NaN;
            var t = s.match(/^(\d+)t$/);
            if (t) return +t[1] / tick;
            var c = s.match(/^(?:(\d+):)?(\d+):(\d+(?:[.,]\d+)?)$/);
            if (c) return (+(c[1] || 0)) * 3600 + (+c[2]) * 60 + parseFloat(c[3].replace(',', '.'));
            var sec = s.match(/^([\d.]+)s$/);
            return sec ? +sec[1] : NaN;
        };
        var attr = function (a, n) { var r = a.match(new RegExp('\\b' + n + '="([^"]*)"')); return r ? r[1] : null; };
        var reP = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
        while ((m = reP.exec(xml))) {
            var st = tm(attr(m[1], 'begin')), en = tm(attr(m[1], 'end'));
            if (!isFinite(en) && isFinite(st)) en = st + (tm(attr(m[1], 'dur')) || 2);
            if (!isFinite(st)) continue;
            var tx = decodeEntities(m[2].replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
            if (!tx) continue;
            var last = out[out.length - 1];   // dwie linie jednej kwestii jako dwa <p> — sklejamy
            if (last && Math.abs(last.start - st) < 0.1 && Math.abs(last.end - en) < 0.1) last.text += ' ' + tx;
            else out.push({ start: st, end: Math.max(en, st + 0.1), text: tx, segs: null });
        }
        return out;
    }

    function nfTrackUrl(t) {
        var dl = t && t.ttDownloadables;
        if (!dl) return '';
        for (var i = 0; i < NF_FORMATS.length; i++) {
            var d = dl[NF_FORMATS[i]];
            if (!d) continue;
            if (Array.isArray(d.urls) && d.urls[0] && d.urls[0].url) return d.urls[0].url;
            if (d.downloadUrls) { for (var k in d.downloadUrls) if (d.downloadUrls[k]) return d.downloadUrls[k]; }
        }
        return '';
    }

    function nfLang(t) { return String((t && (t.language || t.bcp47)) || '').toLowerCase().split('-')[0]; }

    function nfPickTrack(tracks, lang) {
        var ok = tracks.filter(function (t) { return t && !t.isNoneTrack && !t.isForcedNarrative && nfLang(t) === lang && nfTrackUrl(t); });
        return ok.filter(function (t) { return t.trackType === 'PRIMARY' || t.rawTrackType === 'subtitles'; })[0] || ok[0] || null;
    }

    async function nfFetchFile(vid, lang) {
        var key = vid + '|' + lang;
        if (nfFetched.has(key)) return;
        var track = nfPickTrack(nfTracks.get(vid) || [], lang);
        if (!track) return;
        nfFetched.add(key);
        try {
            var txt = await (await origFetch.call(window, nfTrackUrl(track))).text();
            var s = String(txt || '').trim();
            var list = s.indexOf('WEBVTT') === 0 ? parseVtt(s) : parseTtml(s);
            if (!list.length) { nfFetched.delete(key); return; }
            var e = nfEntry(vid);
            e.file = list; e.fileLang = lang; e.sent = 0;
            nfRebuild(vid);
            nfSendToLektor(vid);
        } catch (err) { nfFetched.delete(key); }
    }

    // [AGENT-EXP] 2026-10-19: cały polski plik idzie też do LEKTORA — tym samym komunikatem co napisy z inject.js
    // (content.js-BgeP3Ise.js: LIVEDUB_SUBTITLE_DATA, osobne źródło 'cenzor-pl'; lektor woli polskie źródło).
    // Lektor ma wtedy komplet od pierwszej minuty, nawet gdy w odtwarzaczu nie wybrano napisów. Wysyłamy
    // po pobraniu i jeszcze 2× przy kolejnych partiach z odtwarzacza (gdyby lektor wtedy jeszcze nie słuchał).
    var NF_LEKTOR_KEY = 'cenzor-pl';
    function nfSendToLektor(vid) {
        var e = nfStore.get(vid);
        if (!e || !e.file || e.sent >= 3 || vid !== currentVid()) return;
        e.sent++;
        try {
            window.postMessage({
                type: 'LIVEDUB_SUBTITLE_DATA',
                source: { key: NF_LEKTOR_KEY, url: 'cenzor:pl:' + vid },
                subtitles: e.file.map(function (c, i) {
                    var st = Math.round(c.start * 1000);
                    return { id: NF_LEKTOR_KEY + '_' + st + '_' + i, text: c.text, lines: [c.text], startMs: st, endMs: Math.round(c.end * 1000) };
                })
            }, location.origin);
        } catch (err) {}
    }

    function nfMaybeFetch() {
        if (!IS_NF || !opt.cenzorOn || opt.cenzorNfPl === false || !curVid) return;
        if (nfTracks.has(curVid)) nfFetchFile(curVid, 'pl');
    }

    if (IS_NF) {
        try {
            var oParse = JSON.parse, oStringify = JSON.stringify;
            JSON.stringify = function (value) {
                try {
                    var prm = value && value.params;
                    if (prm && Array.isArray(prm.profiles) && opt.cenzorOn && opt.cenzorNfPl !== false) {
                        NF_PROFILES.forEach(function (p) { if (prm.profiles.indexOf(p) < 0) prm.profiles.push(p); });
                        prm.showAllSubtitles = true;
                    }
                } catch (e) {}
                return oStringify.apply(this, arguments);
            };
            JSON.parse = function () {
                var r = oParse.apply(this, arguments);
                try {
                    var res = r && (r.result || r);
                    if (res && Array.isArray(res.timedtexttracks) && res.movieId) {
                        var vid = String(res.movieId);
                        nfTracks.set(vid, res.timedtexttracks);
                        while (nfTracks.size > 20) nfTracks.delete(nfTracks.keys().next().value);
                        setTimeout(nfMaybeFetch, 0);
                    }
                } catch (e) {}
                return r;
            };
        } catch (e) {}

        // Napisy z odtwarzacza (wybrana ścieżka) — z inject.js lektora, partiami.
        window.addEventListener('message', function (ev) {
            if (ev.source !== window || !ev.data || ev.data.type !== 'LIVEDUB_SUBTITLE_DATA') return;
            var vid = currentVid();
            if (!vid) return;
            var src = ev.data.source || {};
            var k = String(src.key || src.url || 'src');
            if (k === NF_LEKTOR_KEY) return;   // nasz własny komunikat dla lektora
            var e = nfEntry(vid);
            var have = e.sel[k] || [], ids = new Set(have.map(function (c) { return c.id; }));
            (ev.data.subtitles || []).forEach(function (s) {
                if (!s || ids.has(String(s.id))) return;
                var tx = String(s.text || '').replace(/\s+/g, ' ').trim();
                if (!tx || !(s.endMs > s.startMs)) return;
                have.push({ id: String(s.id), start: s.startMs / 1000, end: s.endMs / 1000, text: tx, segs: null });
            });
            e.sel[k] = have;
            nfRebuild(vid);
            nfSendToLektor(vid);
        });
    }

    // Samodzielne pobranie (metoda z yt_subs_bridge.js → getRaw), gdy ani odtwarzacz, ani lektor
    // nie pobrały napisów. Czekamy dłużej niż w userscripcie, żeby nie przełączać ścieżki
    // równocześnie z lektorem.
    var autoTried = new Set(), autoBusy = false, vidSince = 0;
    var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

    function playerResponse() {
        try {
            var p = document.getElementById('movie_player');
            return (p && p.getPlayerResponse && p.getPlayerResponse()) || window.ytInitialPlayerResponse || null;
        } catch (e) { return null; }
    }

    // [AGENT-EXP] 2026-10-19: przy cenzorYtPl — polskie ręczne → polskie auto → ścieżka filmu przetłumaczona
    // przez YouTube na polski (tlang=pl, jak „Automatyczne tłumaczenie” w odtwarzaczu). Zwraca { track, tlang }.
    function pickTrackPl(tracks, audioLang) {
        var pl = tracks.filter(function (t) { return isPl(t.languageCode); });
        var man = pl.filter(function (t) { return t.kind !== 'asr'; })[0];
        if (man || pl[0]) return { track: man || pl[0], tlang: '' };
        var base = pickTrack(tracks, audioLang);
        if (!base) return null;
        return { track: base, tlang: base.isTranslatable === false ? '' : 'pl' };
    }

    function pickTrack(tracks, audioLang) {
        var lang = String(audioLang || '').toLowerCase().split('-')[0];
        var is = function (t, l) { return String(t.languageCode || '').toLowerCase().split('-')[0] === l; };
        var langs = [lang, 'pl', 'en'].filter(Boolean);
        for (var i = 0; i < langs.length; i++) {
            var l = langs[i], hit = tracks.filter(function (t) { return is(t, l); });
            var man = hit.filter(function (t) { return t.kind !== 'asr'; })[0];
            if (man || hit[0]) return man || hit[0];
        }
        return tracks.filter(function (t) { return t.kind !== 'asr'; })[0] || tracks[0] || null;
    }

    async function autoLoad(vid) {
        autoTried.add(vid); autoBusy = true;
        try {
            var pr = playerResponse();
            if (!pr || !pr.videoDetails || pr.videoDetails.videoId !== vid) { autoTried.delete(vid); return; }
            var r = pr.captions && pr.captions.playerCaptionsTracklistRenderer;
            var tracks = (r && r.captionTracks) || [];
            if (!tracks.length) return;
            var mf = pr.microformat && pr.microformat.playerMicroformatRenderer;
            var aLang = (mf && mf.defaultAudioLanguage) || pr.videoDetails.defaultAudioLanguage;
            var sel = opt.cenzorYtPl ? pickTrackPl(tracks, aLang) : { track: pickTrack(tracks, aLang), tlang: '' };
            var track = sel && sel.track;
            if (!track) return;
            // przy cenzorYtPl czekamy na POLSKIE napisy (te z odtwarzacza w innym języku się nie liczą)
            var wantPl = opt.cenzorYtPl && (sel.tlang === 'pl' || isPl(track.languageCode));
            var got = wantPl ? function () { return isPl(ytLang.get(vid)); } : function () { return cuesByVid.has(vid); };
            try {
                var u = new URL(track.baseUrl, location.origin);
                u.searchParams.set('fmt', 'json3');
                if (sel.tlang) u.searchParams.set('tlang', sel.tlang);
                var t = await (await origFetch.call(window, u.toString(), { credentials: 'include' })).text();
                if (t && t.trim()) onTimedtext(u.toString(), t);
            } catch (e) {}
            if (got()) return;
            var player = document.getElementById('movie_player');
            if (!player || typeof player.setOption !== 'function') return;
            var prev = null;
            try { prev = player.getOption && player.getOption('captions', 'track'); } catch (e) {}
            try {
                if (player.loadModule) player.loadModule('captions');
                await sleep(300);
                var list = (player.getOption && player.getOption('captions', 'tracklist')) || [];
                var target = list.filter(function (x) { return x.languageCode === track.languageCode && (x.kind || '') === (track.kind || ''); })[0]
                    || { languageCode: track.languageCode };
                if (sel.tlang) target = Object.assign({}, target, { translationLanguage: { languageCode: sel.tlang, languageName: 'Polski' } });
                player.setOption('captions', 'track', target);
            } catch (e) {}
            for (var i = 0; i < 30 && !got(); i++) await sleep(200);
            try {
                if (prev && prev.languageCode) player.setOption('captions', 'track', prev);
                else if (player.unloadModule) player.unloadModule('captions');
            } catch (e) {}
        } finally { autoBusy = false; }
    }

    function maybeAutoLoad() {
        if (!IS_YT || !opt.cenzorOn || autoBusy || !curVid || isShorts() || isAd()) return;
        if (cueMode && (!opt.cenzorYtPl || isPl(ytLang.get(curVid)))) return;   // napisy już są (przy cenzorYtPl: polskie)
        if (autoTried.has(curVid) || Date.now() - vidSince < 4000) return;
        autoLoad(curVid).catch(function () { autoBusy = false; });
    }

    /* ---------------- lista słów ---------------- */

    var DIGRAPH_RE = /dzi(?=[aąeęioóuy])|dż|dź|dz|sz|cz|rz|ch/g;
    var VOWEL_RE = /[aąeęioóuy]/;
    var PUNCT_RE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
    var ASR_TAG_RE = /\[\s*_{2,}\s*\]/g;
    var wordRegex = null;

    function buildRegex() {
        var src = opt.cenzorWords && opt.cenzorWords.trim() ? opt.cenzorWords : DEFAULT_WORDS;
        var esc = function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
        var parts = [];
        String(src).split(/[\s,;\n]+/).forEach(function (w) {
            w = w.trim().toLowerCase();
            if (!w) return;
            var wild = w.slice(-1) === '*';
            var base = (wild ? w.slice(0, -1) : w).replace(PUNCT_RE, '');
            if (base.length < 2) return;
            var p = esc(base) + (wild ? '[\\p{L}\\p{N}]*' : '');
            if (parts.indexOf(p) < 0) parts.push(p);
        });
        if (!parts.length) { wordRegex = null; return; }
        var body = '(?:' + parts.join('|') + ')';
        try { wordRegex = new RegExp('(?<![\\p{L}\\p{N}])' + body + '(?![\\p{L}\\p{N}])', 'giu'); }
        catch (e) { wordRegex = new RegExp('\\b' + body + '\\b', 'gi'); }
    }

    function findMatches(flat) {
        var out = [], m;
        if (wordRegex) {
            wordRegex.lastIndex = 0;
            while ((m = wordRegex.exec(flat))) {
                out.push({ word: m[0], index: m.index });
                if (m.index === wordRegex.lastIndex) wordRegex.lastIndex++;
            }
        }
        if (opt.cenzorAsrTag) {
            ASR_TAG_RE.lastIndex = 0;
            while ((m = ASR_TAG_RE.exec(flat))) out.push({ word: m[0], index: m.index });
        }
        return out.sort(function (a, b) { return a.index - b.index; });
    }

    /* ---------------- model czasu słowa (z Netflix Cenzor 4.5.2) ---------------- */

    function estimateWeight(w) {
        if (!w) return 0.4;
        var c = w.replace(DIGRAPH_RE, '#'), weight = 0;
        for (var i = 0; i < c.length; i++) {
            var ch = c[i], prev = c[i - 1] || '', next = c[i + 1] || '';
            if (ch === '#') weight += 0.8;
            else if (ch === 'i' && VOWEL_RE.test(next)) weight += (prev && !VOWEL_RE.test(prev)) ? 0 : 0.8;
            else if (VOWEL_RE.test(ch)) weight += 1.4;
            else weight += 0.8;
        }
        return Math.max(weight, 1.0);
    }
    function cleanW(w) { return String(w).toLowerCase().replace(PUNCT_RE, ''); }

    function calculateWordTimings(text, startTime, endTime) {
        text = String(text || '').trim();
        if (!text || !(endTime > startTime)) return [];
        var words = text.split(/\s+/).map(function (w) { return { word: w, weight: estimateWeight(cleanW(w)) }; });
        var total = words.reduce(function (s, w) { return s + w.weight; }, 0), dur = endTime - startTime, acc = 0;
        var out = words.map(function (it) {
            var st = startTime + (acc / total) * dur;
            acc += it.weight;
            return { word: it.word, start: st, end: startTime + (acc / total) * dur };
        });
        out[out.length - 1].end = endTime;
        return out;
    }

    // Zakres słów [first, last] obejmujący trafienie (wg podziału po spacjach).
    function wordSpan(text, match) {
        var toks = String(text).trim().split(/\s+/), pos = 0, first = -1, last = -1;
        var mEnd = match.index + Math.max(1, match.word.length) - 1;
        var t = String(text);
        for (var i = 0; i < toks.length; i++) {
            while (pos < t.length && /\s/.test(t[pos])) pos++;
            var s = pos, e = s + toks[i].length;
            if (first < 0 && match.index < e) first = i;
            if (first >= 0 && s <= mEnd) last = i;
            if (s > mEnd) break;
            pos = e;
        }
        return { first: first, last: last };
    }

    var LEN_FACTOR = { off: 0, normal: 1, strong: 2 };
    function extraHold(word) {
        var f = LEN_FACTOR[opt.cenzorLenMode];
        var letters = String(word).replace(/[^\p{L}\p{N}]/gu, '').length;
        return f ? Math.max(0, (letters - 4) * 90 * f) : 0;
    }
    function asrWordDuration(word) { return Math.max(0.35, estimateWeight(cleanW(word)) * 0.09); }

    function wordTimesInCue(cue, match) {
        var text = cue.text || '';
        var mEnd = match.index + Math.max(1, match.word.length) - 1;
        if (cue.segs && cue.segs.length) {   // auto-napisy: prawdziwe czasy słów
            var sg = cue.segs, i = 0;
            while (i + 1 < sg.length && sg[i + 1].off <= match.index) i++;
            var j = i;
            while (j + 1 < sg.length && sg[j + 1].off <= mEnd) j++;
            var from = sg[i].t;
            var to = j + 1 < sg.length ? sg[j + 1].t : Math.min(cue.end, sg[j].t + asrWordDuration(text.slice(sg[j].off)));
            return { from: from, to: Math.max(to, from + 0.15) };
        }
        var tm = calculateWordTimings(text, cue.start, cue.start + Math.max(0.1, cue.end - cue.start));
        var sp = wordSpan(text, match);
        if (!tm.length || sp.first < 0 || sp.last < 0) return null;
        return { from: tm[sp.first].start, to: Math.max(tm[sp.last].end, tm[sp.first].start + 0.15) };
    }

    /* ---------------- planowanie okien ciszy ---------------- */

    var windows = [], plannedFor = -1;

    // ms czasu rzeczywistego → sekundy materiału (przy 1.5× okno w materiale musi być 1.5× dłuższe).
    // [AGENT-EXP] 2026-10-20: trzeci suwak z „Netflix Cenzor 4.6” — TEMPO TEKSTU. Auto = tempo filmu (jak dotąd);
    // ręcznie = suwak 0,25–2,5, niezależny od tempa filmu (mniej = krótsze okna ciszy, więcej = dłuższe).
    function textRate() {
        if (opt.cenzorTextAuto) return speedOf();
        var n = Number(opt.cenzorTextRate);
        return (!isFinite(n) || n <= 0) ? 1 : Math.min(2.5, Math.max(0.25, n));
    }
    function realMsToMaterial(ms) { return Math.max(0, ms) / 1000 * textRate(); }

    function planFromCues() {
        if (!wordRegex) buildRegex();
        var buf = realMsToMaterial(opt.cenzorBufferMs), hold = realMsToMaterial(opt.cenzorHoldMs), out = [];
        cues.forEach(function (c) {
            findMatches(c.text).forEach(function (m) {
                // [AGENT-EXP] 2026-10-19: zawsze TYLKO samo słowo (tryb „cała kwestia” usunięty na życzenie).
                var extra = realMsToMaterial(extraHold(m.word));
                var wt = wordTimesInCue(c, m);
                if (!wt) {   // awaryjnie: proporcja pozycji w tekście
                    var dur = Math.max(0.2, c.end - c.start), total = c.text.length || 1;
                    var f = c.start + (m.index / total) * dur;
                    wt = { from: f, to: f + Math.max(0.15, (m.word.length / total) * dur) };
                }
                out.push({ start: Math.max(0, wt.from - buf), end: wt.to + hold + extra });
            });
        });
        out.sort(function (a, b) { return a.start - b.start; });
        windows = [];
        out.forEach(function (w) {
            var last = windows[windows.length - 1];
            if (last && w.start <= last.end) last.end = Math.max(last.end, w.end);
            else windows.push(w);
        });
        plannedFor = cues.length;
    }

    /* ---------------- 2) LIVE: napisy z ekranu ---------------- */

    var LIVE_SELECTORS = [
        '.ytp-caption-segment',
        '.player-timedtext-text-container',
        '.atvwebplayersdk-captions-text',
        '.dmp_SubtitleText', '.vjs-text-track-display', '.jw-text-track-cue', '.shaka-text-container'
    ];
    // [AGENT-EXP] 2026-10-20: polskie tłumaczenie Immersive Translate (to samo co czyta lektor — dom_content.js,
    // youtube_content.js). Czytane OSOBNO od napisów strony: wcześniej brana była tylko pierwsza znaleziona grupa
    // (np. angielskie napisy Netflixa), więc polskiego przekleństwa z Immersive cenzor nie widział.
    var TR_SELECTORS = [
        '.imt-captions-text', '.imt-cue', '.immersive-translate-subtitle',
        '[data-immersive-translate-translation-element="target"]',
        '.immersive-translate-target-inner', '.immersive-translate-target-translation'
    ];
    var SEC_PER_WEIGHT = 0.075;   // ok. 13 głosek/s — tempo mowy do szacowania, kiedy padnie słowo
    var TR_ANCHOR_SEC = 2.5;      // tłumaczenie przychodzi z opóźnieniem — liczymy od zmiany napisu strony
    var lastSubs = { nat: '', tr: '' }, natChangedAt = -1, liveWins = [], liveSeen = new Set();

    // vr — prostokąt filmu: tłumaczenie bierzemy tylko z obszaru filmu (Immersive tłumaczy też resztę strony).
    // [AGENT-EXP] 2026-10-20: tekst elementu z <br> jako spacją — textContent sklejał linie napisów („możesz”+„wypierdalać”
    // → „możeszwypierdalać”), więc słowa z listy nie były rozpoznawane. innerText odpada: jest pusty, gdy napisy są schowane.
    function domText(node) {
        var out = '';
        for (var n = node.firstChild; n; n = n.nextSibling) {
            if (n.nodeType === 3) out += n.nodeValue;
            else if (n.nodeType === 1) out += String(n.nodeName).toUpperCase() === 'BR' ? ' ' : domText(n);
        }
        return out;
    }
    function readSels(sels, vr) {
        var parts = [];
        for (var i = 0; i < sels.length; i++) {
            var nodes;
            try { nodes = document.querySelectorAll(sels[i]); } catch (e) { continue; }
            for (var k = 0; k < nodes.length; k++) {
                var tx = domText(nodes[k]).replace(/\s+/g, ' ');   // [AGENT-EXP] 2026-10-20: było textContent
                if (!tx.trim()) continue;
                var r = nodes[k].getBoundingClientRect();
                if (!(r.width > 0 && r.height > 0)) continue;
                if (vr && !(r.right > vr.left && r.left < vr.right && r.bottom > vr.top - 40 && r.top < vr.bottom + 40)) continue;
                parts.push(tx);
            }
            if (parts.length) break;
        }
        return parts;
    }
    function flatOf(parts) { return parts.join(' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }

    function liveSources() {
        var v = mainVideo(), vr = null;
        try { vr = v && v.getBoundingClientRect(); } catch (e) {}
        var parts = readSels(LIVE_SELECTORS.concat(opt.selectors), null);
        if (!parts.length) {   // odtwarzacz HTML5 z ścieżką <track> (też ukrytą)
            try {
                var tt = v && v.textTracks;
                for (var n = 0; tt && n < tt.length; n++) {
                    if (tt[n].mode === 'disabled' || !tt[n].activeCues) continue;
                    for (var c = 0; c < tt[n].activeCues.length; c++) parts.push(tt[n].activeCues[c].text || '');
                    if (parts.length) break;
                }
            } catch (e) {}
        }
        var tr = (vr && vr.width > 0 && vr.height > 0) ? readSels(TR_SELECTORS, vr) : [];
        return { nat: flatOf(parts), tr: flatOf(tr) };
    }

    function checkLive(t) {
        var src = liveSources();
        if (src.nat && src.nat !== lastSubs.nat) natChangedAt = t;
        // tłumaczenie: słowo liczone od chwili, gdy zmienił się napis strony (jeśli niedawno) — okno, które już
        // minęło, zaczyna się OD RAZU (start nie wcześniej niż teraz).
        var trAnchor = (natChangedAt >= 0 && t - natChangedAt >= 0 && t - natChangedAt < TR_ANCHOR_SEC) ? natChangedAt : t;
        checkLiveSrc('nat', src.nat, t, t);
        checkLiveSrc('tr', src.tr, trAnchor, t);
    }

    function checkLiveSrc(key, flat, anchor, t) {
        if (flat === lastSubs[key]) return;
        var prev = lastSubs[key];
        lastSubs[key] = flat;
        var matches = flat ? findMatches(flat) : [];
        // Tylko samo słowo: napis zwykle wchodzi razem z początkiem kwestii, więc słowo pada
        // po tylu sekundach, ile zajmuje wypowiedzenie tekstu przed nim. Auto-napisy dopisują
        // słowa na końcu linii — wtedy liczymy tylko od nowej części.
        var base = (prev && flat.indexOf(prev) === 0) ? prev.length : 0;
        if (base) anchor = t;
        var keep = new Set();
        matches.forEach(function (m) {
            var sig = key + '|' + m.word.toLowerCase() + '|' + flat.slice(Math.max(0, m.index - 12), m.index).toLowerCase();
            keep.add(sig);
            if (liveSeen.has(sig)) return;
            liveSeen.add(sig);
            var before = m.index >= base ? flat.slice(base, m.index) : '';
            var w = before.trim() ? before.trim().split(/\s+/).reduce(function (s, x) { return s + estimateWeight(cleanW(x)); }, 0) : 0;
            var from = anchor + w * SEC_PER_WEIGHT;
            var to = from + Math.max(0.25, estimateWeight(cleanW(m.word)) * SEC_PER_WEIGHT);
            var end = to + realMsToMaterial(opt.cenzorHoldMs) + realMsToMaterial(extraHold(m.word));
            liveWins.push({
                start: Math.max(t, from - realMsToMaterial(opt.cenzorBufferMs)),
                end: Math.max(end, t + 0.25)   // spóźnione tłumaczenie: i tak krótkie cięcie od razu
            });
        });
        liveSeen.forEach(function (s) { if (s.indexOf(key + '|') === 0 && !keep.has(s)) liveSeen.delete(s); });
    }

    /* ---------------- wyciszanie i pętla ---------------- */

    function isShorts() { return IS_YT && location.pathname.indexOf('/shorts/') === 0; }
    function playerEl() {
        if (!IS_YT) return null;
        return isShorts() ? (document.getElementById('shorts-player') || document.getElementById('movie_player'))
            : document.getElementById('movie_player');
    }
    function vidFromUrl() {
        var m = location.pathname.match(/^\/(?:shorts|embed|live|watch\/)\/?([\w-]{6,})/);
        if (m) return m[1];
        try { return new URLSearchParams(location.search).get('v') || location.pathname; } catch (e) { return location.pathname; }
    }
    function currentVid() {
        if (IS_YT && !isShorts()) {
            try {
                var pl = playerEl(), d = pl && pl.getVideoData ? pl.getVideoData() : null;
                if (d && d.video_id) return d.video_id;
            } catch (e) {}
        }
        return vidFromUrl();
    }
    function mainVideo() {
        var pl = playerEl(), v = pl && pl.querySelector('video');
        if (v) return v;
        var best = null, bestA = 0;
        var all = document.querySelectorAll('video');
        for (var i = 0; i < all.length; i++) {
            var a = (all[i].videoWidth || 0) * (all[i].videoHeight || 0);
            if (a > bestA) { bestA = a; best = all[i]; }
        }
        return best;
    }
    function isAd() {
        var pl = playerEl();
        return !!(pl && (pl.classList.contains('ad-showing') || pl.classList.contains('ad-interrupting')));
    }
    function speedOf() {
        var v = mainVideo(), r = v ? Number(v.playbackRate) : NaN;
        return (!isFinite(r) || r <= 0) ? 1 : Math.min(4, Math.max(0.25, r));
    }

    var mutedEl = null, mutedWas = false, muting = false;
    function applyMute(want) {
        if (want) {
            var v = mainVideo();
            if (!v) return;
            if (mutedEl && mutedEl !== v) { mutedEl.muted = mutedWas; mutedEl = null; }
            if (!mutedEl) { mutedEl = v; mutedWas = v.muted; }
            if (!v.muted) v.muted = true;
        } else if (mutedEl) {
            if (mutedEl.muted !== mutedWas) mutedEl.muted = mutedWas;
            mutedEl = null;
        }
        muting = !!want;
    }

    var curVid = null, lastT = null, lastRate = null;

    function tick() {
        if (!opt.cenzorOn && !opt.cenzorLive) { if (muting) applyMute(false); return; }
        var vid = currentVid();
        if (vid !== curVid) {
            curVid = vid; vidSince = Date.now();
            applyMute(false);
            lastT = null; lastRate = null; lastSubs = { nat: '', tr: '' }; natChangedAt = -1; liveWins = []; liveSeen = new Set();
            useCuesFor(vid);
        }
        var v = mainVideo();
        if (!v) return;
        var t = v.currentTime, rate = speedOf();
        var jumped = lastT !== null && Math.abs(t - lastT) > 1.5;
        if ((lastRate !== null && rate !== lastRate) || jumped) {
            windows = []; plannedFor = -1;
            if (cueMode) planFromCues();
            if (jumped) liveWins = [];
        }
        lastT = t; lastRate = rate;

        var useCues = opt.cenzorOn && cueMode;
        var want = false;
        if (!isAd()) {
            if (useCues) {
                if (plannedFor !== cues.length) planFromCues();
                want = windows.some(function (w) { return t >= w.start && t < w.end; });
            } else if (opt.cenzorLive) {
                want = liveWins.some(function (w) { return t >= w.start && t < w.end; });
                liveWins = liveWins.filter(function (w) { return w.end > t - 1; });
            }
        }
        applyMute(!!want);
        while (windows.length && windows[0].end + 5 < t) windows.shift();
    }

    // rAF staje w karcie w tle, a YouTube często gra w tle — wtedy setTimeout.
    function loop() {
        try { tick(); } catch (e) {}
        if (document.hidden) setTimeout(loop, 40);
        else requestAnimationFrame(loop);
    }

    function ready(fn) {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
        else fn();
    }

    var nfTicks = 0;
    buildRegex();
    window.lektorCenzor = {
        status: function () {
            return { on: opt.cenzorOn, live: opt.cenzorLive, vid: curVid, cueMode: cueMode, cues: cues.length,
                windows: windows.length, track: lastTrackInfo, muting: muting,
                nfTracks: IS_NF ? (nfTracks.get(curVid) || []).length : undefined };
        },
        __test: { parseTimedtext: parseTimedtext, parseTtml: parseTtml, nfPickTrack: nfPickTrack, nfTrackUrl: nfTrackUrl,
            nfMerge: function (vid, file, sel) { var e = nfEntry(vid); e.file = file; e.sel = Object.create(null); if (sel) e.sel.x = sel; nfRebuild(vid); return (cuesByVid.get(vid) || []).length; },
            pickTrackPl: pickTrackPl, onTimedtext: onTimedtext, ytLang: function (v) { return ytLang.get(v); },
            nfStoreGet: function (v) { return nfStore.get(String(v)); }, nfSendToLektor: nfSendToLektor,
            nfTrackCount: function (v) { return (nfTracks.get(String(v)) || []).length; }, applyOpts: applyOpts, wordTimesInCue: wordTimesInCue,
            plan: function (list) { cues = list; cueMode = true; planFromCues(); return windows.slice(); },
            live: function (text, t, tr) { liveSources = function () { return { nat: text, tr: tr || '' }; }; checkLive(t); return { liveWins: liveWins.slice() }; },
            findMatches: function (s) { return findMatches(s); } }
    };

    ready(function () {
        setInterval(function () {
            if (!opt.cenzorOn && !opt.cenzorLive) return;
            var v = mainVideo();
            if (opt.cenzorLive && !(opt.cenzorOn && cueMode) && v && !isAd()) checkLive(v.currentTime);
            maybeAutoLoad();
            if (IS_NF && ++nfTicks % 5 === 0) nfMaybeFetch();
        }, 200);
        try { window.postMessage({ __lektorCenzor: 'hello' }, location.origin); } catch (e) {}
        loop();
    });
})();

// matcha-bench.js — benchmark prędkości syntezy Matcha-TTS-PL (Edge-v2 w przeglądarce)
// Uruchomić przez serwer HTTP lub wczytać rozszerzenie do Chrome (tryb deweloperski).
import { synthesizeWav, setLogger, reset } from '../../matcha_web/engine.js';

const SR = 22050; // sample rate Matcha (stały w engine.js)

const SENTENCES = [
    'Dzień dobry, jak się masz?',
    'Jutro rano muszę wybrać się do sklepu po chleb i mleko.',
    'Przepraszam, gdzie jest najbliższa apteka? Potrzebuję kupić leki na gorączkę i kaszel.',
];

const VARIANTS = {   // [AGENT-EXP] 2026-10-24: tylko 2 warianty (reszta wolniejsza w teście _test_matcha_cpu_gpu)
    kombi_voc_gpu: { name: 'KOMBI · koder+dekoder CPU INT8, wokoder GPU FP32', enc: 'sdp_int8', dec: 't4_int8', voc: 'fp32', gpu: 1, workers: 2 },
    cpu_fp32:      { name: 'CPU · FP32 · naturalny rytm · wszystko na procesorze', enc: 'sdp', dec: 't4', voc: 'fp32', gpu: 0, workers: 2 },
};

let logEl, statusEl, outEl;
let results = [];
let lastDeviceInfo = '';
setLogger((tag, msg) => { if (tag === 'matcha-web-czas') lastDeviceInfo = msg; });

function wavDurationSeconds(blob) { const n = (blob.size - 44) / 2; return n / SR; }
function rtf(ms, durS) { return durS && durS > 0 ? ms / (durS * 1000) : 0; }
async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function runOne(text, variant) {
    const w = VARIANTS[variant];
    const t0 = performance.now();
    const blob = await synthesizeWav(text, {
        voice: 'male_voxcpm_2', steps: 4,
        tryb: w.gpu ? 'kombi' : 'cpu_fp32',   // [AGENT-EXP] 2026-10-24: główny folder — engine.js zna tylko 2 warianty
    });
    const ms = performance.now() - t0;
    const durS = wavDurationSeconds(blob);
    return { ms, durS, rtf: rtf(ms, durS), blobSize: blob.size, device: lastDeviceInfo };
}

async function run() {
    // zbierz zdania: zaznaczone z listy + własne jeśli zaznaczone i wypełnione
    const sentChecks = document.querySelectorAll('.sent');
    const selSents = [];
    Array.from(sentChecks).forEach((c, i) => {
        if (c.checked) {
            if (i === 3) {
                // własne zdanie
                const custom = document.getElementById('customSent');
                if (custom && custom.value.trim()) selSents.push({ idx: i, text: custom.value.trim() });
            } else {
                selSents.push({ idx: i, text: SENTENCES[i] });
            }
        }
    });
    const selVars = Array.from(document.querySelectorAll('.var')).filter(c => c.checked).map(c => c.value);
    if (selSents.length === 0) { alert('Zaznacz conajmniej jedno zdanie (lub wpisz własne).'); return; }
    if (selVars.length === 0) { alert('Zaznacz conajmniej jeden wariant.'); return; }

    const runBtn = document.getElementById('run');
    runBtn.disabled = true; runBtn.textContent = '⏳ Testuję…';
    results = []; outEl.innerHTML = ''; logEl.textContent = '';

    let total = selVars.length * selSents.length, done = 0;
    for (const variant of selVars) {
        await reset('benchmark nowy wariant');
        await sleep(300);
        const w = VARIANTS[variant];
        const perVariant = { variant, name: w.name, sents: [], warmupMs: null };

        for (const s of selSents) {
            const text = s.text;
            done++;
            statusEl.textContent = `Testuję "${w.name}" — zdanie ${done}/${total}…`;
            try { await runOne(text, variant); perVariant.warmupMs = 'model załadowany'; }
            catch (e) { perVariant.warmupMs = 'błąd warmup: ' + e.message; log('❌ ' + w.name + ' warmup: ' + e.message); continue; }

            const measures = [];
            for (let r = 0; r < 2; r++) {
                try { measures.push(await runOne(text, variant)); }
                catch (e) { log('❌ ' + w.name + ' pomiar: ' + e.message); }
            }
            if (measures.length === 0) continue;
            const avgMs = measures.reduce((s, m) => s + m.ms, 0) / measures.length;
            const avgDur = measures.reduce((s, m) => s + m.durS, 0) / measures.length;
            const avgRtf = measures.reduce((s, m) => s + m.rtf, 0) / measures.length;
            perVariant.sents.push({ si: s.idx, text, ms: avgMs, durS: avgDur, rtf: avgRtf, device: measures[measures.length - 1].device });
            log('✓ ' + w.name + ' · ' + text.slice(0, 40) + '… — ' + avgMs.toFixed(0) + ' ms, ' + avgDur.toFixed(2) + ' s, RTF ' + avgRtf.toFixed(3));
        }
        if (perVariant.sents.length) {
            perVariant.avgMs = perVariant.sents.reduce((s, x) => s + x.ms, 0) / perVariant.sents.length;
            perVariant.avgDur = perVariant.sents.reduce((s, x) => s + x.durS, 0) / perVariant.sents.length;
            perVariant.avgRtf = perVariant.sents.reduce((s, x) => s + x.rtf, 0) / perVariant.sents.length;
            results.push(perVariant);
        }
    }
    render();
    runBtn.disabled = false; runBtn.textContent = '▶ Start testów';
    statusEl.textContent = `Gotowe — przetestowano ${results.length} wariant(ów) × ${selSents.length} zdanie(ń).`;
    log('✅ Wszystkie testy zakończone.');
}

function log(t) { logEl.textContent += t + '\n'; logEl.scrollTop = logEl.scrollHeight; }
function mark(vals, lowerBetter) {
    if (vals.length < 2) return () => '';
    const best = lowerBetter ? Math.min(...vals) : Math.max(...vals);
    const worst = lowerBetter ? Math.max(...vals) : Math.min(...vals);
    return (v) => (v === best ? 'best' : v === worst ? 'worst' : '');
}
function render() {
    if (!results.length) return;
    const rtfVals = results.map(r => r.avgRtf), msVals = results.map(r => r.avgMs);
    const mRtf = mark(rtfVals, true), mMs = mark(msVals, true);
    results.sort((a, b) => a.avgRtf - b.avgRtf);
    const slowestRtf = Math.max(...rtfVals);
    let h = '<table><thead><tr><th class="l">Wariant</th><th>Średni czas syntezy</th><th>Średnia długość mowy</th><th>RTF (niżej = lepiej)</th><th>vs najwolniejszy</th><th>Urządzenie</th></tr></thead><tbody>';
    results.forEach(r => {
        const clsR = mRtf(r.avgRtf), clsT = mMs(r.avgMs);
        const vsSlowest = slowestRtf > 0 ? (slowestRtf / r.avgRtf).toFixed(2) + '×' : '—';
        h += `<tr><td class="l"><b>${r.name}</b>${r.warmupMs ? ' · ' + r.warmupMs : ''}</td>
            <td class="${clsT}">${r.avgMs.toFixed(0)} ms</td><td>${r.avgDur.toFixed(2)} s</td>
            <td class="${clsR}">${r.avgRtf.toFixed(3)}</td><td>${vsSlowest}</td><td class="l">${r.device || '—'}</td></tr>`;
        r.sents.forEach(s => {
            h += `<tr><td class="l" style="padding-left:24px">   └ "${s.text.slice(0, 60)}…"</td>
            <td class="${mMs([s.ms])}">${s.ms.toFixed(0)} ms</td><td>${s.durS.toFixed(2)} s</td><td>${s.rtf.toFixed(3)}</td><td></td><td class="l">${s.device || '—'}</td></tr>`;
        });
    });
    h += '</tbody></table>';
    outEl.innerHTML = h;
}

document.getElementById('run').addEventListener('click', () => run().catch(e => {
    log('❌ BŁĄD: ' + (e && e.stack || e));
    document.getElementById('run').disabled = false;
    document.getElementById('run').textContent = '▶ Start testów';
}));
document.getElementById('clear').addEventListener('click', () => { results = []; outEl.innerHTML = ''; logEl.textContent = ''; statusEl.textContent = ''; });
logEl = document.getElementById('log');
statusEl = document.getElementById('status');
outEl = document.getElementById('out');
log('🔧 Benchmark Matcha gotowy.');
log('ℹ Pierwszy test każdego wariantu ładuje model (~30 MB) — kolejne mierzą czysty wniosek.');
log('ℹ int8 i fp16 zawsze lecą na procesorze (WASM), nawet jeśli wybrano „karta graficzna”. Tylko fp32 może użyć WebGPU.');

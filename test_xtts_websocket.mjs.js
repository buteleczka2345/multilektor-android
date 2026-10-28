// [AGENT-EXP] Test atrapą klientów lokalnych XTTS i Audio8 WebSocket.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, 'src', 'offscreen', 'offscreen.js'), 'utf8');
const start = source.indexOf('function synthesizeRemoteWav(');
const end = source.indexOf('\nfunction cancelMatchaRequests', start);
assert(start >= 0 && end > start, 'Nie znaleziono klienta WebSocket lokalnych silników');
const clientSource = source.slice(start, end);
const initRoute = source.slice(source.indexOf("if (msg.action === 'INIT_TTS')"), source.indexOf("if (msg.action === 'CLEAR_CACHE')"));
const preloadRoute = source.slice(source.indexOf("if (msg.action === 'TTS_PRELOAD')"), source.indexOf("if (msg.action === 'TTS_PLAY')"));
const playRoute = source.slice(source.indexOf("if (msg.action === 'TTS_PLAY')"), source.indexOf("if (msg.action === 'TTS_PAUSE')"));
// [AGENT-EXP] 2026-10-17: silnik i głos są teraz tylko w popupie (sekcja w Ustawieniach usunięta).
const popupHtml = fs.readFileSync(path.join(__dirname, 'src', 'popup', 'popup.html'), 'utf8');
const popupJs = fs.readFileSync(path.join(__dirname, 'src', 'popup', 'popup.js'), 'utf8');
assert.match(initRoute, /status: 'initialized', engine: 'xtts'/, 'INIT_TTS should not initialize Sherpa for XTTS');
assert.match(preloadRoute, /ttsEngine === 'xtts'[\s\S]*xttsSynthesize/, 'XTTS preload route is missing');
assert.match(playRoute, /ttsEngine === 'xtts'[\s\S]*playXttsStream/, 'XTTS playback route is missing');
assert.match(initRoute, /status: 'initialized', engine: 'audio8'/, 'INIT_TTS should not initialize Sherpa for Audio8');
assert.match(preloadRoute, /ttsEngine === 'audio8'[\s\S]*audio8Synthesize/, 'Audio8 preload route is missing');
assert.match(playRoute, /ttsEngine === 'audio8'[\s\S]*playAudio8Stream/, 'Audio8 playback route is missing');
assert.match(popupHtml, /<option value="audio8">/, 'Audio8 engine option is missing');
assert.match(popupJs, /k: 'audio8Voice'/, 'Audio8 voice setting is missing');

function createClient(engine = 'xtts') {
    const sockets = [];
    class FakeWebSocket {
        constructor(url) {
            this.url = url;
            this.sent = [];
            this.readyState = 0;
            sockets.push(this);
        }
        send(data) { this.sent.push(data); }
        close() {
            this.readyState = 3;
            if (this.onclose) this.onclose();
        }
    }
    const context = {
        XTTS_WS_URL: 'ws://127.0.0.1:8000',
        AUDIO8_WS_URL: 'ws://127.0.0.1:9300',
        AUDIO8_TIMEOUT_MS: 900000,
        xttsSockets: new Set(),
        audio8Sockets: new Set(),
        WebSocket: FakeWebSocket,
        Blob,
        Uint8Array,
        setTimeout,
        clearTimeout,
        errMsg: (error) => String((error && error.message) || error)
    };
    vm.runInNewContext(clientSource, context);
    return { client: engine === 'audio8' ? context.audio8Synthesize : context.xttsSynthesize, sockets, context };
}

function wavBlob() {
    const data = new Uint8Array(44);
    data.set([82, 73, 70, 70], 0);
    data.set([87, 65, 86, 69], 8);
    return new Blob([data], { type: 'audio/wav' });
}

async function run() {
    const success = createClient();
    const successPromise = success.client('Cześć', 'Marcin_demo1_przyciety.wav');
    const socket = success.sockets[0];
    assert.strictEqual(socket.url, 'ws://127.0.0.1:8000');
    socket.onopen();
    assert.deepStrictEqual(JSON.parse(socket.sent[0]), {
        text: 'Cześć',
        voice: 'Marcin_demo1_przyciety.wav'
    });
    socket.onmessage({ data: await wavBlob().arrayBuffer() });
    const result = await successPromise;
    assert.strictEqual(result.size, 44);
    assert.strictEqual(success.context.xttsSockets.size, 0);

    const serverError = createClient();
    const errorPromise = serverError.client('Test', '');
    serverError.sockets[0].onmessage({ data: '{"ok":false,"error":"Brak probek glosowych"}' });
    await assert.rejects(errorPromise, /Brak probek glosowych/);

    const invalidAudio = createClient();
    const invalidPromise = invalidAudio.client('Test', '');
    invalidAudio.sockets[0].onmessage({ data: new ArrayBuffer(44) });
    await assert.rejects(invalidPromise, /nieprawidłowy plik WAV/);

    const closedSocket = createClient();
    const closedPromise = closedSocket.client('Test', '');
    closedSocket.sockets[0].close();
    await assert.rejects(closedPromise, /Połączenie z XTTS zostało przerwane/);
    assert.strictEqual(closedSocket.context.xttsSockets.size, 0);

    const audio8 = createClient('audio8');
    const audio8Promise = audio8.client('Audio8 test', 'mojglos');
    const audio8Socket = audio8.sockets[0];
    assert.strictEqual(audio8Socket.url, 'ws://127.0.0.1:9300');
    audio8Socket.onopen();
    assert.deepStrictEqual(JSON.parse(audio8Socket.sent[0]), {
        text: 'Audio8 test',
        voice: 'mojglos',
        speed: 1
    });
    audio8Socket.onmessage({ data: await wavBlob().arrayBuffer() });
    assert.strictEqual((await audio8Promise).size, 44);
    assert.strictEqual(audio8.context.audio8Sockets.size, 0);

    const defaultVoice = createClient('audio8');
    const defaultPromise = defaultVoice.client('Domyślny', '');
    defaultVoice.sockets[0].onopen();
    assert.deepStrictEqual(JSON.parse(defaultVoice.sockets[0].sent[0]), {
        text: 'Domyślny',
        voice: 'default',
        speed: 1
    });
    defaultVoice.sockets[0].onmessage({ data: await wavBlob().arrayBuffer() });
    await defaultPromise;

    process.stdout.write('Lokalne TTS WebSocket: XTTS 4/4, Audio8 2/2; trasy i ustawienia sprawdzone\n');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

// ============ STREAM SERVER ============
// আগের মনোলিথিক backend.js থেকে শুধু স্ট্রিমিং প্রক্সি + ভিডিও লিস্টিং অংশ আলাদা করা হয়েছে।
// লজিক হুবহু আগের মতোই — আপলোড/এনকোড/ডাউনলোড এখানে নেই (আলাদা প্রজেক্টে)।
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { config, CHANNEL_ID, NETWORK_REQ_TIMEOUT, sleep, acquireBotSlot, precheckBotPool } = require('./common');

const app = express();
app.use(express.json());
const PLAYLIST_DIR = './playlist';
if (!fs.existsSync(PLAYLIST_DIR)) fs.mkdirSync(PLAYLIST_DIR, { recursive: true });

// ============ শুধু stream_bots পুল লোড ============
const STREAM_BOTS = (config.stream_bots || []).filter(b => b.isEnabled !== false);
if (STREAM_BOTS.length === 0) {
    console.error('❌ bot-config.json-এ কোনো enabled stream_bots নেই');
    process.exit(1);
}

async function runStartupPrechecks() {
    if (process.env.SKIP_BOT_PRECHECK === 'true') {
        console.log('⏭️ SKIP_BOT_PRECHECK=true — বট/চ্যানেল প্রি-চেক স্কিপ করা হলো');
        return;
    }
    console.log('🔍 বট টোকেন ও চ্যানেল অ্যাক্সেস প্রি-চেক শুরু হচ্ছে...');
    const streamValid = await precheckBotPool('stream', STREAM_BOTS);
    STREAM_BOTS.length = 0; STREAM_BOTS.push(...streamValid);
    if (STREAM_BOTS.length === 0) {
        console.error('❌ প্রি-চেকের পর কোনো valid stream bot নেই — সার্ভার বন্ধ হচ্ছে');
        process.exit(1);
    }
    console.log(`✅ প্রি-চেক শেষ — স্ট্রিম: ${STREAM_BOTS.length}`);
}

console.log(`🤖 বট পুল লোড হয়েছে — স্ট্রিম: ${STREAM_BOTS.length}`);
console.log(`⏱️ টাইমআউট: ${NETWORK_REQ_TIMEOUT/1000} সেকেন্ড`);

// ============ CORS Middleware ============
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
    res.setTimeout(600000);
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

let streamBotIndex = 0;
function getNextStreamBot() {
    const bot = STREAM_BOTS[streamBotIndex % STREAM_BOTS.length];
    streamBotIndex = (streamBotIndex + 1) % STREAM_BOTS.length;
    return bot;
}

// ============ Proxy: Telegram ফাইল serve ============
app.get('/s/:fileId', async (req, res) => {
    for (let i = 0; i < STREAM_BOTS.length; i++) {
        const bot = getNextStreamBot();
        try {
            const TELEGRAM_API = `https://api.telegram.org/bot${bot.token}`;
            await acquireBotSlot(bot);
            const fileInfo = await axios.get(`${TELEGRAM_API}/getFile?file_id=${req.params.fileId}`, {
                timeout: NETWORK_REQ_TIMEOUT
            });

            if (!fileInfo.data.ok) {
                console.error(`❌ বট ${bot.name} getFile failed`);
                continue;
            }

            const filePath = fileInfo.data.result.file_path;
            const fileUrl = `https://api.telegram.org/file/bot${bot.token}/${filePath}`;

            console.log(`🔄 প্রোক্সি (${bot.name}): ${req.params.fileId}`);

            const range = req.headers.range;
            const headers = { 'User-Agent': 'Mozilla/5.0' };
            if (range) headers['Range'] = range;

            await acquireBotSlot(bot);
            const response = await axios({
                method: 'get',
                url: fileUrl,
                responseType: 'stream',
                timeout: NETWORK_REQ_TIMEOUT,
                headers: headers,
                validateStatus: status => status >= 200 && status < 300
            });

            if (range) {
                res.setHeader('Content-Range', response.headers['content-range'] || '');
                res.status(206);
            }
            const isM3u8 = filePath.toLowerCase().endsWith('.m3u8');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', isM3u8 ? 'application/vnd.apple.mpegurl' : 'video/MP2T');
            res.setHeader('Cache-Control', isM3u8 ? 'no-cache' : 'public, max-age=31536000');
            response.data.pipe(res);
            return;

        } catch (err) {
            console.error(`❌ প্রোক্সি এরর (${bot.name}):`, err.message);
            if (err.response?.status === 429) {
                const wait = parseInt(err.response.headers['retry-after']) * 1000 || 5000;
                await sleep(wait);
            }
        }
    }
    res.status(500).send('Proxy error');
});

// ============ ভিডিও ইনডেক্স (read-only এখানে — upload-server লিখে/আপডেট করে) ============
// আগের মনোলিথে যা একই disk-এ ছিল, এখন এই ফাইলটা upload-server-এর সাথে শেয়ার্ড থাকতে হবে
// (shared volume/mount/sync) — বিস্তারিত README.md-তে।
const VIDEO_INDEX_PATH = path.join(PLAYLIST_DIR, 'videos.idx');

function loadVideoIndex() {
    try {
        return JSON.parse(fs.readFileSync(VIDEO_INDEX_PATH, 'utf8'));
    } catch (e) {
        try {
            const legacy = JSON.parse(fs.readFileSync(path.join(PLAYLIST_DIR, 'videos.json'), 'utf8'));
            return legacy;
        } catch (e2) {
            return {};
        }
    }
}

// প্লেলিস্ট সার্ভ (মাস্টার/ভ্যারিয়েন্ট .m3u8 — মূল ব্যবহার এখন Telegram-হোস্টেড লিংক দিয়ে,
// এই রাউট ব্যাকওয়ার্ড-কম্প্যাটিবিলিটির জন্য অপরিবর্তিত রাখা হয়েছে)
app.get('/playlist/:file', (req, res) => {
    const file = path.basename(req.params.file);
    if (!file.endsWith('.m3u8')) {
        return res.status(400).json({ error: 'অবৈধ ফাইলনাম' });
    }
    const playlistPath = path.join(PLAYLIST_DIR, file);
    if (fs.existsSync(playlistPath)) {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.sendFile(path.resolve(playlistPath));
    } else {
        res.status(404).json({ error: 'প্লেলিস্ট নেই' });
    }
});

app.get('/api/videos', (req, res) => {
    try {
        const index = loadVideoIndex();
        const videos = Object.values(index)
            .map(v => ({
                id: v.id,
                name: v.name,
                created: v.created,
                url: `/play.html?id=${v.id}`
            }))
            .sort((a, b) => b.created - a.created);
        res.json({ success: true, count: videos.length, videos });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/video/:id', (req, res) => {
    const index = loadVideoIndex();
    const entry = index[req.params.id];
    if (!entry) return res.status(404).json({ error: 'ভিডিও পাওয়া যায়নি' });
    res.json({
        success: true,
        id: entry.id,
        name: entry.name,
        playlistUrl: entry.playlistUrl,
        renditions: entry.renditions,
        variants: entry.variants || []
    });
});

app.get('/status', (req, res) => {
    res.json({
        status: 'running',
        service: 'stream',
        bots: { stream: STREAM_BOTS.length },
        channel: CHANNEL_ID ? '✅' : '❌',
        videos: Object.keys(loadVideoIndex()).length,
        timeout: NETWORK_REQ_TIMEOUT/1000 + 's'
    });
});

app.use(express.static(__dirname));

app.use((err, req, res, next) => {
    console.error('❌ Server Error:', err.message);
    res.status(500).json({ error: err.message });
});

const PORT = process.env.PORT || 3002;
runStartupPrechecks()
    .then(() => {
        app.listen(PORT, () => {
            console.log(`✅ Stream Server: http://localhost:${PORT}`);
            console.log(`📺 Play: http://localhost:${PORT}/play.html?id=VIDEO_ID`);
            console.log(`📚 List: http://localhost:${PORT}/list.html`);
            console.log(`🤖 বট — স্ট্রিম: ${STREAM_BOTS.length}`);
        });
    })
    .catch(err => {
        console.error('❌ প্রি-চেক চালাতে সমস্যা হয়েছে:', err.message);
        process.exit(1);
    });

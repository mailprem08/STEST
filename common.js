// common.js — বট-পুল লোড, rate-limit, prechecking হেল্পার
// আগে backend.js-এর এই অংশগুলো তিনটা ফিচারই শেয়ার করত; এখন প্রতিটা প্রজেক্ট (upload/stream/download)
// আলাদাভাবে হোস্ট হবে বলে ফাইলটা প্রতিটা প্রজেক্টে হুবহু কপি করা আছে — লজিক অপরিবর্তিত।
const fs = require('fs');
const axios = require('axios');
const dotenv = require('dotenv');
dotenv.config();

const NETWORK_REQ_TIMEOUT = parseInt(process.env.NETWORK_REQ_TIMEOUT) || 60000;

let config, CHANNEL_ID, SETTINGS;
try {
    config = JSON.parse(fs.readFileSync('./bot-config.json', 'utf8'));
    CHANNEL_ID = config.channelId;
    SETTINGS = config.settings;
} catch (err) {
    console.error('❌ bot-config.json লোড করতে পারেনি:', err.message);
    process.exit(1);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============ প্রতি বটে Telegram-এর ~৩০ req/sec limit মেনে rate-limit (token bucket) ============
const BOT_RATE_LIMIT = parseInt(process.env.BOT_RATE_LIMIT_PER_SEC) || 30;
const botBuckets = new Map(); // token -> { tokens, lastRefill }

function getBucket(token) {
    let b = botBuckets.get(token);
    if (!b) {
        b = { tokens: BOT_RATE_LIMIT, lastRefill: Date.now() };
        botBuckets.set(token, b);
    }
    return b;
}

async function acquireBotSlot(bot) {
    const bucket = getBucket(bot.token);
    for (;;) {
        const now = Date.now();
        const elapsed = now - bucket.lastRefill;
        if (elapsed > 0) {
            bucket.tokens = Math.min(BOT_RATE_LIMIT, bucket.tokens + (elapsed / 1000) * BOT_RATE_LIMIT);
            bucket.lastRefill = now;
        }
        if (bucket.tokens >= 1) {
            bucket.tokens -= 1;
            return;
        }
        const waitMs = Math.max(10, ((1 - bucket.tokens) / BOT_RATE_LIMIT) * 1000);
        await sleep(waitMs);
    }
}

// ============ বট টোকেন + চ্যানেল অ্যাক্সেস প্রি-চেক (স্টার্টআপে) ============
const _botInfoCache = new Map();
const _channelAccessCache = new Map();

async function getBotInfo(token) {
    if (_botInfoCache.has(token)) return _botInfoCache.get(token);
    let result;
    try {
        const res = await axios.get(`https://api.telegram.org/bot${token}/getMe`, { timeout: 10000 });
        result = res.data?.ok
            ? { ok: true, botId: res.data.result.id, username: res.data.result.username }
            : { ok: false, error: res.data?.description || 'অজানা এরর' };
    } catch (err) {
        result = { ok: false, error: err.response?.data?.description || err.message };
    }
    _botInfoCache.set(token, result);
    return result;
}

async function checkChannelAccess(token, botId, channelId) {
    const cacheKey = `${token}:${channelId}`;
    if (_channelAccessCache.has(cacheKey)) return _channelAccessCache.get(cacheKey);
    let result;
    try {
        const res = await axios.get(`https://api.telegram.org/bot${token}/getChatMember`, {
            params: { chat_id: channelId, user_id: botId },
            timeout: 10000
        });
        if (!res.data?.ok) {
            result = { ok: false, error: res.data?.description || 'চ্যানেল অ্যাক্সেস চেক ব্যর্থ' };
        } else {
            const status = res.data.result.status;
            result = (status === 'left' || status === 'kicked')
                ? { ok: false, status, error: `বট চ্যানেলে নেই (status: ${status})` }
                : { ok: true, status };
        }
    } catch (err) {
        result = { ok: false, error: err.response?.data?.description || err.message };
    }
    _channelAccessCache.set(cacheKey, result);
    return result;
}

// প্রতিটা পুলের প্রতিটা বট চেক করে, invalid গুলো বাদ দিয়ে শুধু valid বটের লিস্ট ফেরত দেয়
async function precheckBotPool(poolName, bots) {
    const valid = [];
    for (const bot of bots) {
        const info = await getBotInfo(bot.token);
        if (!info.ok) {
            console.error(`❌ [${poolName}] "${bot.name}" (id:${bot.id}) — টোকেন ইনভ্যালিড: ${info.error}`);
            continue;
        }
        const chan = await checkChannelAccess(bot.token, info.botId, CHANNEL_ID);
        if (!chan.ok) {
            console.error(`❌ [${poolName}] "${bot.name}" (@${info.username}) — চ্যানেল অ্যাক্সেস নেই: ${chan.error}`);
            continue;
        }
        console.log(`✅ [${poolName}] "${bot.name}" (@${info.username}) — OK (status: ${chan.status})`);
        valid.push(bot);
    }
    return valid;
}

module.exports = {
    config, CHANNEL_ID, SETTINGS, NETWORK_REQ_TIMEOUT,
    sleep, acquireBotSlot, precheckBotPool
};

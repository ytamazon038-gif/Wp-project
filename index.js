require('dotenv').config();
const fs = require('fs');
const TelegramBot = require('node-telegram-bot-api');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const OpenAI = require('openai');
const { google } = require('googleapis');
const express = require('express');

// --- Environment Configurations ---
const TGTOKEN = process.env.TGTOKEN;
const OPENAIKEY = process.env.OPENAIKEY;
const ADMINTGIDS = process.env.ADMINTGIDS ? process.env.ADMINTGIDS.split(',').map(id => id.trim()) : [];
const DRIVEFOLDERNAME = 'WA-BOT-MEMORY';
const DASHBOARDPORT = process.env.PORT || 3000;
const AIMODEL = "gpt-4o-mini";

// Auto-create credentials file from Render Environment Variable
if (process.env.GOOGLE_CREDENTIALS_JSON && !fs.existsSync('./credentials.json')) {
    fs.writeFileSync('./credentials.json', process.env.GOOGLE_CREDENTIALS_JSON);
}

// --- Logic Constants ---
const USERCOOLDOWNMS = 30000;
const MINREPLYDELAYMS = 2000;
const MAXREPLYDELAYMS = 5000;
const WARMUPMS = 120000;
const HISTORYCONTEXTLIMIT = 5;
const HISTORYSTORELIMIT = 50;
const BROADCASTMINDELAYMS = 2500;
const BROADCASTMAXDELAYMS = 5000;

// --- Initialization ---
const openai = new OpenAI({ apiKey: OPENAIKEY });
const bot = new TelegramBot(TGTOKEN, { polling: true });
const sessions = Object.create(null);
const cooldowns = Object.create(null);

const auth = new google.auth.GoogleAuth({
    keyFile: './credentials.json',
    scopes: ['https://www.googleapis.com/auth/drive'],
});
const drive = google.drive({ version: 'v3', auth });

// --- Helper Functions ---
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);
const todayISO = () => new Date().toISOString().split('T')[0];
const safeText = (s, max = 3500) => { if (!s) return ""; return String(s).slice(0, max); };

// --- Google Drive Memory Logic ---
let cachedFolderId = null;
async function getFolderId() {
    if (cachedFolderId) return cachedFolderId;
    const res = await drive.files.list({
        q: `name='${DRIVEFOLDERNAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'files(id, name)',
    });
    if (!res.data.files || res.data.files.length === 0) throw new Error("Drive folder not found.");
    cachedFolderId = res.data.files[0].id;
    return cachedFolderId;
}

async function findUserFile(folderId, fileName) {
    const res = await drive.files.list({
        q: `'${folderId}' in parents and name='${fileName}' and trashed=false`,
        fields: 'files(id, name)',
    });
    return res.data.files && res.data.files[0] ? res.data.files[0] : null;
}

async function loadUserData(waUserId, displayName = "Unknown") {
    try {
        const folderId = await getFolderId();
        const fileName = waUserId + ".json";
        const file = await findUserFile(folderId, fileName);
        if (!file) return { user: waUserId, name: displayName, firstseen: todayISO(), totalquestions: 0, history: [], lastseen: todayISO() };
        const res = await drive.files.get({ fileId: file.id, alt: 'media' });
        return res.data;
    } catch (e) { return { user: waUserId, name: displayName, history: [], totalquestions: 0 }; }
}

async function saveUserData(userData) {
    const folderId = await getFolderId();
    const fileName = userData.user + ".json";
    const file = await findUserFile(folderId, fileName);
    const body = JSON.stringify(userData, null, 2);
    if (!file) {
        await drive.files.create({
            requestBody: { name: fileName, parents: [folderId] },
            media: { mimeType: 'application/json', body },
        });
    } else {
        await drive.files.update({ fileId: file.id, media: { mimeType: 'application/json', body } });
    }
}

// --- Telegram Commands ---
bot.onText(/\/start/, (msg) => {
    const helpText = `WA SuperBot Pro is running.

Commands:
/login - Get QR
/group [Name] - Set Group
/status - Check Status
/all [Message] - Admin Broadcast`;
    bot.sendMessage(msg.chat.id, helpText);
});

bot.onText(/\/login/, async (msg) => {
    const tgId = msg.chat.id;
    if (sessions[tgId]?.wa) return bot.sendMessage(tgId, "Session already exists.");

    bot.sendMessage(tgId, "Creating WhatsApp session... (Wait for QR)");
    const wa = new Client({
        authStrategy: new LocalAuth({ clientId: String(tgId) }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        }
    });

    sessions[tgId] = { wa, warm: false, groupName: null, readyAt: null };
    cooldowns[tgId] = Object.create(null);

    wa.on('qr', async (qr) => {
        const img = await QRCode.toDataURL(qr);
        bot.sendPhoto(tgId, Buffer.from(img.split(',')[1], 'base64'), { caption: "Scan this QR on WhatsApp" });
    });

    wa.on('ready', async () => {
        sessions[tgId].readyAt = Date.now();
        bot.sendMessage(tgId, "WhatsApp connected! Warming up for 2 mins...");
        await sleep(WARMUPMS);
        sessions[tgId].warm = true;
        bot.sendMessage(tgId, "Bot is now ACTIVE in set group.");
    });

    // --- WhatsApp Group Message Handler ---
    wa.on('message', async (msg2) => {
        const s = sessions[tgId];
        if (!s || !s.warm || !s.groupName) return;
        
        const chat = await msg2.getChat();
        if (!chat.isGroup || chat.name !== s.groupName) return;
        if (msg2.fromMe) return;

        const body = msg2.body.trim();
        const waSender = msg2.author || msg2.from;
        const displayName = msg2._data?.notifyName || "User";

        // Logic for 'history' and 'clear' commands in WA
        if (body === 'history') {
            const userData = await loadUserData(waSender, displayName);
            if (!userData.history.length) return msg2.reply("No history found.");
            let out = "Last Questions:\n" + userData.history.slice(-5).map((h, i) => (i+1) + ". " + safeText(h.q, 50)).join("\n");
            return msg2.reply(out);
        }

        if (body === 'clear') {
            const userData = await loadUserData(waSender, displayName);
            userData.history = [];
            userData.totalquestions = 0;
            await saveUserData(userData);
            return msg2.reply("Memory cleared.");
        }

        // Logic for 'ask ' command
        if (body.startsWith('ask ')) {
            const lastTs = cooldowns[tgId][waSender] || 0;
            if (Date.now() - lastTs < USERCOOLDOWNMS) return; // Cooldown
            
            cooldowns[tgId][waSender] = Date.now();
            const question = body.replace('ask ', '').trim();
            if (!question) return msg2.reply("Usage: ask [your question]");

            await sleep(randInt(MINREPLYDELAYMS, MAXREPLYDELAYMS));
            
            const userData = await loadUserData(waSender, displayName);
            const context = userData.history.slice(-HISTORYCONTEXTLIMIT).map(h => ({ role: "user", content: h.q }));
            
            const messages = [
                { role: "system", content: "You are a helpful assistant." },
                ...context,
                { role: "user", content: question }
            ];

            try {
                const resp = await openai.chat.completions.create({ model: AIMODEL, messages });
                const answer = safeText(resp.choices[0].message.content);
                
                userData.history.push({ q: question, a: answer, time: new Date().toISOString() });
                userData.totalquestions += 1;
                if (userData.history.length > HISTORYSTORELIMIT) userData.history.shift();
                
                await saveUserData(userData);
                await msg2.reply(answer);
            } catch (err) {
                msg2.reply("AI Error. Try later.");
            }
        }
    });

    wa.initialize();
});

bot.onText(/\/group (.+)/, (msg, match) => {
    const name = match[1].trim();
    if (sessions[msg.chat.id]) {
        sessions[msg.chat.id].groupName = name;
        bot.sendMessage(msg.chat.id, "Target group set to: " + name);
    } else {
        bot.sendMessage(msg.chat.id, "Please /login first.");
    }
});

bot.onText(/\/status/, (msg) => {
    const s = sessions[msg.chat.id];
    if (!s) return bot.sendMessage(msg.chat.id, "No active session.");
    bot.sendMessage(msg.chat.id, `Status: Connected
Group: ${s.groupName || "Not set"}
Warm: ${s.warm ? "Yes" : "No"}`);
});

bot.onText(/\/all (.+)/, async (msg, match) => {
    if (!ADMINTGIDS.includes(String(msg.chat.id))) return;
    const text = match[1].trim();
    const tgIds = Object.keys(sessions);
    for (const id of tgIds) {
        const s = sessions[id];
        if (s?.wa && s.groupName && s.warm) {
            const chats = await s.wa.getChats();
            const target = chats.find(c => c.isGroup && c.name === s.groupName);
            if (target) {
                await sleep(randInt(BROADCASTMINDELAYMS, BROADCASTMAXDELAYMS));
                await target.sendMessage(text);
            }
        }
    }
    bot.sendMessage(msg.chat.id, "Broadcast finished.");
});

// --- Express Server for Health Checks ---
const app = express();
app.get('/', (req, res) => res.send('Bot is Running Successfully!'));
app.listen(DASHBOARDPORT, () => console.log("Server listening on port " + DASHBOARDPORT));
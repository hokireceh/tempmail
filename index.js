// File: index.js
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cloudscraper = require('cloudscraper');
const { Pool } = require('pg');
const express = require('express');

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())) : [];
const TMAILOR_API = process.env.TMAILOR_API || 'https://tmailor.com/api';
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL) || 60000;
const BROADCAST_RATE_LIMIT = parseInt(process.env.BROADCAST_RATE_LIMIT) || 25;
const CONCURRENT_CHECKS = parseInt(process.env.CONCURRENT_CHECKS) || 10;
const CHECK_TIMEOUT = parseInt(process.env.CHECK_TIMEOUT) || 15000;
const DB_POOL_SIZE = parseInt(process.env.DB_POOL_SIZE) || 20;
const CACHE_MAX_SIZE = parseInt(process.env.CACHE_MAX_SIZE) || 10000;
const ACTIVE_USER_HOURS = parseInt(process.env.ACTIVE_USER_HOURS) || 24;
const WEBHOOK_PORT = process.env.WEBHOOK_PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://localhost:3000';

const SmartBroadcaster = require('./smartBroadcaster');
const { initializeDatabase } = require('./db-init');

if (!TELEGRAM_TOKEN || TELEGRAM_TOKEN === 'your_telegram_bot_token_here') {
    console.error('❌ ERROR: Token Telegram bot belum diatur!');
    console.error('1. Buat bot di @BotFather di Telegram');
    console.error('2. Dapatkan token');
    console.error('3. Masukkan token ke file .env');
    process.exit(1);
}

// Setup database with connection pooling
const dbPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: DB_POOL_SIZE,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    maxUses: 7500,
});

dbPool.on('error', (err) => {
    console.error('❌ Unexpected database pool error:', err.message);
});

const dbClient = {
    query: (...args) => dbPool.query(...args)
};

// Initialize database
(async () => {
    try {
        const client = await dbPool.connect();
        console.log('✅ Database pool connected (max connections: ' + DB_POOL_SIZE + ')');
        await initializeDatabase(client);
        client.release();
    } catch (err) {
        console.error('❌ Database connection error:', err.message);
        process.exit(1);
    }
})();

// =================== CIRCUIT BREAKER FOR API CALLS ===================
const circuitBreaker = {
    failures: 0,
    lastFailure: 0,
    isOpen: false,
    threshold: 10,
    resetTimeout: 60000,
    
    recordSuccess() {
        this.failures = 0;
        this.isOpen = false;
    },
    
    recordFailure() {
        this.failures++;
        this.lastFailure = Date.now();
        if (this.failures >= this.threshold) {
            this.isOpen = true;
            console.warn('🔴 Circuit breaker OPEN - API calls paused for 60s');
        }
    },
    
    canRequest() {
        if (!this.isOpen) return true;
        if (Date.now() - this.lastFailure > this.resetTimeout) {
            this.isOpen = false;
            this.failures = 0;
            console.log('🟢 Circuit breaker CLOSED - resuming API calls');
            return true;
        }
        return false;
    }
};

// =================== BOT INITIALIZATION ===================
const bot = new TelegramBot(TELEGRAM_TOKEN, { 
    polling: {
        interval: 2000,
        autoStart: true,
        params: {
            timeout: 10
        }
    }
});

console.log('🤖 Bot Telegram TempMail sedang diinisialisasi...');

// =================== START EXPRESS SERVER (STILL NEEDED FOR HEALTH CHECKS) ===================
app.get('/', (req, res) => res.send('Bot is running!'));

app.listen(WEBHOOK_PORT, '0.0.0.0', () => {
    console.log(`🚀 Health check server running on port ${WEBHOOK_PORT}`);
});

// =================== TEST BOT AUTHENTICATION ===================
function testBotAuth() {
    bot.getMe()
        .then((me) => {
            console.log('✅ Bot authenticated successfully!');
            console.log('🤖 Bot username: @' + me.username);
            console.log('🤖 Bot ID:', me.id);
            console.log('🤖 Bot name:', me.first_name);
        })
        .catch((err) => {
            console.error('❌ Failed to authenticate bot!');
            console.error('Error:', err.message);
            console.error('\n🔍 Troubleshooting:');
            console.error('1. Check if TELEGRAM_BOT_TOKEN is correct in .env');
            console.error('2. Check internet connection');
            console.error('3. Verify token at: https://api.telegram.org/botYOUR_TOKEN/getMe');
            console.error('4. Restart the bot: pkill -9 node && node index.js');
        });
}

// =================== BOT ERROR HANDLERS ===================
bot.on('error', (error) => {
    console.error('❌ Bot error:', error.message);
});

bot.on('polling_error', (error) => {
    console.error('❌ Polling error:', error.message);
});

bot.on('webhook_error', (error) => {
    console.error('❌ Webhook error:', error.message);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error.message);
});

// =================== LRU CACHE WITH SIZE LIMIT ===================
class LRUCache {
    constructor(maxSize) {
        this.maxSize = maxSize;
        this.cache = new Map();
    }
    
    get(key) {
        if (!this.cache.has(key)) return undefined;
        const value = this.cache.get(key);
        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
    }
    
    set(key, value) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        this.cache.set(key, value);
    }
    
    delete(key) {
        return this.cache.delete(key);
    }
    
    has(key) {
        return this.cache.has(key);
    }
    
    size() {
        return this.cache.size;
    }
    
    clear() {
        this.cache.clear();
    }
}

const userInboxCache = new LRUCache(CACHE_MAX_SIZE);
const broadcastState = new Map();

// =================== KEYBOARD MENU ===================
function getMainMenuKeyboard(userId) {
    const buttons = [
        [{ text: '📧 Buat Email Baru', callback_data: 'new_email' }],
        [{ text: '🔍 Cek Email Masuk', callback_data: 'check_email' }],
        [{ text: '📋 Daftar Email Saya', callback_data: 'list_emails' }],
        [{ text: '❓ Bantuan', callback_data: 'help' }]
    ];

    if (isAdmin(userId)) {
        buttons.push([{ text: '📢 Broadcast', callback_data: 'broadcast_start' }]);
    }

    return {
        reply_markup: {
            inline_keyboard: buttons
        },
        parse_mode: 'Markdown'
    };
}

const backToMenuKeyboard = {
    reply_markup: {
        inline_keyboard: [
            [{ text: '🏠 Kembali ke Menu', callback_data: 'main_menu' }]
        ]
    },
    parse_mode: 'Markdown'
};

// =================== HELPER FUNCTION - SAFE MESSAGE EDIT ===================
async function safeEditMessage(chatId, messageId, text, options = {}) {
    try {
        await bot.editMessageText(text, {
            chat_id: chatId,
            message_id: messageId,
            ...options
        });
    } catch (error) {
        if (error.message.includes('message to edit not found') || 
            error.message.includes('message not found') ||
            error.message.includes('MESSAGE_NOT_MODIFIED')) {
            console.log(`⚠️ Message edit failed for ${chatId}, sending new message instead`);
            await bot.sendMessage(chatId, text, options);
        } else {
            throw error;
        }
    }
}

// =================== DATABASE FUNCTIONS ===================
async function saveEmail(userId, email, code, token) {
    try {
        const result = await dbClient.query(
            'INSERT INTO user_emails (user_id, email, code, token) VALUES ($1, $2, $3, $4) RETURNING *',
            [userId, email, code, token]
        );
        return result.rows[0];
    } catch (error) {
        console.error('❌ Error saving email:', error.message);
        throw error;
    }
}

async function getUserEmails(userId) {
    try {
        const result = await dbClient.query(
            'SELECT * FROM user_emails WHERE user_id = $1 ORDER BY created_at DESC',
            [userId]
        );
        return result.rows;
    } catch (error) {
        console.error('❌ Error getting emails:', error.message);
        return [];
    }
}

async function getLatestEmail(userId) {
    try {
        const result = await dbClient.query(
            'SELECT * FROM user_emails WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
            [userId]
        );
        return result.rows[0] || null;
    } catch (error) {
        console.error('❌ Error getting latest email:', error.message);
        return null;
    }
}

async function deleteOldEmails(userId) {
    try {
        const result = await dbClient.query(
            'DELETE FROM user_emails WHERE user_id = $1',
            [userId]
        );
        console.log(`🗑️ Deleted ${result.rowCount} old emails for user ${userId}`);
        return result.rowCount;
    } catch (error) {
        console.error('❌ Error deleting old emails:', error.message);
        throw error;
    }
}

async function updateLastChecked(emailId) {
    try {
        await dbClient.query(
            'UPDATE user_emails SET last_checked = CURRENT_TIMESTAMP WHERE id = $1',
            [emailId]
        );
    } catch (error) {
        console.error('❌ Error updating last_checked:', error.message);
    }
}

// =================== API FUNCTIONS ===================
async function createTempEmail() {
    try {
        const response = await cloudscraper.post(`${TMAILOR_API}`, {
            json: {
                action: 'newemail',
                curentToken: ''
            },
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
                'Origin': 'https://tmailor.com',
                'Referer': 'https://tmailor.com/'
            }
        });

        const data = typeof response === 'string' ? JSON.parse(response) : response;
        console.log('API Response:', JSON.stringify(data));

        if (data?.msg === 'ok' && data?.email) {
            console.log('✅ Temp email created:', data.email);
            return {
                email: data.email,
                code: data.code,
                token: data.accesstoken,
                created: new Date()
            };
        }
        console.error('Response:', data);
        throw new Error('Invalid response');
    } catch (error) {
        console.error('❌ Error:', error.message);
        throw error;
    }
}

async function getEmailBody(accessToken, emailUuid, emailId) {
    console.log('📧 Fetching email body with uuid:', emailUuid, 'email_id:', emailId);

    try {
        const response = await cloudscraper({
            method: 'POST',
            url: TMAILOR_API,
            json: {
                action: 'read',
                accesstoken: accessToken,
                email_token: emailId,
                email_code: emailUuid,
                wat: '',
                f: ''
            },
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
                'Origin': 'https://tmailor.com',
                'Referer': 'https://tmailor.com/'
            }
        });

        let data;
        if (typeof response === 'string') {
            if (response.trim() === '') return { body: '', links: [] };
            try {
                data = JSON.parse(response);
            } catch (parseErr) {
                console.log('📧 Failed to parse JSON:', parseErr.message);
                return { body: '', links: [] };
            }
        } else {
            data = response;
        }

        if (data?.msg === 'ok' && data?.data) {
            let body = data.data.body || data.data.content || 
                       data.data.text_body || data.data.textBody ||
                       data.data.message || data.data.text || '';

            const extractedLinks = [];

            if (body) {
                body = body
                    .replace(/<style[^>]*>.*?<\/style>/gis, '')
                    .replace(/<script[^>]*>.*?<\/script>/gis, '')
                    .replace(/<head[^>]*>.*?<\/head>/gis, '')
                    .replace(/<div[^>]*style="[^"]*display:\s*none[^"]*"[^>]*>.*?<\/div>/gis, '')
                    .replace(/<!--\[if[^\]]*\]>.*?<!\[endif\]-->/gis, '')
                    .replace(/<!--.*?-->/gs, '');

                body = body
                    .replace(/&nbsp;/g, ' ')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&quot;/g, '"')
                    .replace(/&#39;/g, "'")
                    .replace(/&#x27;/g, "'")
                    .replace(/&apos;/g, "'")
                    .replace(/&#(\d+);/g, '')
                    .replace(/&amp;/g, '&');

                body = body.replace(/<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/gis, (match, url, text) => {
                    const cleanText = text.replace(/<[^>]*>/g, '').trim();

                    if (url.match(/twitter\.com|facebook\.com|instagram\.com|linkedin\.com|youtube\.com|tiktok\.com|unsubscribe|preferences/i)) {
                        return '';
                    }

                    if (url.length > 40 || url.match(/verify|action|confirm|reset|activate|login|signin|code/i)) {
                        extractedLinks.push({ url, text: cleanText });
                        return `[LINK_${extractedLinks.length - 1}]`;
                    }

                    return cleanText || '';
                });

                body = body
                    .replace(/<\/tr>/gi, '\n')
                    .replace(/<\/td>/gi, ' ')
                    .replace(/<br\s*\/?>/gi, '\n')
                    .replace(/<\/p>/gi, '\n\n')
                    .replace(/<p[^>]*>/gi, '')
                    .replace(/<\/div>/gi, '\n')
                    .replace(/<div[^>]*>/gi, '')
                    .replace(/<\/h[1-6]>/gi, '\n\n')
                    .replace(/<h[1-6][^>]*>/gi, '\n');

                body = body.replace(/<[^>]*>/g, '');

                body = body
                    .replace(/[\u200B-\u200D\uFEFF\u2060\u2063\u180E]/g, '')
                    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
                    .replace(/[\u200E\u200F\u202A-\u202E]/g, '')
                    .replace(/[\u2028\u2029]/g, '\n')
                    .replace(/[\uFE00-\uFE0F]/g, '')
                    .replace(/[\u0300-\u036F]/g, '');

                const lines = body.split('\n');
                const filteredLines = [];
                let footerStarted = false;

                for (let line of lines) {
                    const trimmed = line.trim().toLowerCase();

                    if (trimmed.match(/^sent by |^this email was sent|^you're receiving this|^©.*all rights reserved/i)) {
                        footerStarted = true;
                        continue;
                    }

                    if (footerStarted) continue;

                    if (trimmed.match(/^\d{1,5}.*?(street|st\.|blvd\.?|ave\.?|road|rd\.?|suite|ste\.?|floor|fl\.?)/i)) {
                        continue;
                    }

                    if (trimmed.match(/unsubscribe|manage.*preferences|update.*settings/i)) {
                        continue;
                    }

                    filteredLines.push(line);
                }

                body = filteredLines.join('\n');

                extractedLinks.forEach((link, index) => {
                    body = body.replace(`[LINK_${index}]`, '');
                });

                body = body
                    .replace(/\r\n/g, '\n')
                    .replace(/\r/g, '\n')
                    .replace(/\t/g, ' ')
                    .replace(/[ ]{2,}/g, ' ')
                    .replace(/^ +/gm, '')
                    .replace(/ +$/gm, '')
                    .replace(/\n{4,}/g, '\n\n')
                    .trim();

                console.log('📧 Cleaned body length:', body.length);
                console.log('📧 Important links found:', extractedLinks.length);
            }

            return { body, links: extractedLinks };
        }

        return { body: '', links: [] };
    } catch (error) {
        console.error('❌ Error fetching email body:', error.message);
        return { body: '', links: [] };
    }
}

async function handleViewEmail(chatId, messageId, emailUuid) {
    await safeEditMessage(chatId, messageId, '📖 Sedang memuat email...');

    const cached = userInboxCache.get(chatId);

    if (!cached || !cached.emails) {
        await safeEditMessage(
            chatId,
            messageId,
            '❌ *Email tidak ditemukan.*\n\nSilakan cek inbox lagi.',
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔍 Cek Inbox', callback_data: 'check_email' }],
                        [{ text: '🏠 Kembali ke Menu', callback_data: 'main_menu' }]
                    ]
                }
            }
        );
        return;
    }

    const email = cached.emails.find(e => e.uuid === emailUuid || e.id === emailUuid);

    if (!email) {
        await safeEditMessage(
            chatId,
            messageId,
            '❌ *Email tidak ditemukan.*\n\nMungkin sudah kadaluarsa.',
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔍 Cek Inbox', callback_data: 'check_email' }],
                        [{ text: '🏠 Kembali ke Menu', callback_data: 'main_menu' }]
                    ]
                }
            }
        );
        return;
    }

    try {
        const result = await getEmailBody(cached.token, email.uuid || email.id, email.email_id);
        const { body, links } = result;

        const sender = email.sender_name || email.sender_email || 'Unknown';
        const senderEmail = email.sender_email || '';
        const subject = email.subject || '(No Subject)';
        const timestamp = email.receive_time || email.rtime;
        const date = timestamp ? new Date(timestamp * 1000).toLocaleString('id-ID') : '-';

        let messageText = `📧 <b>Detail Email</b>\n\n`;
        messageText += `<b>Subject:</b> ${escapeHtml(subject)}\n`;
        messageText += `<b>Dari:</b> ${escapeHtml(sender)}\n`;
        if (senderEmail) messageText += `<b>Email:</b> ${escapeHtml(senderEmail)}\n`;
        messageText += `<b>Waktu:</b> ${date}\n\n`;
        messageText += `━━━━━━━━━━━━━━━━━━\n\n`;

        if (body && body.trim()) {
            const bodyPreview = escapeHtml(body.substring(0, 3000));
            messageText += bodyPreview;
            if (body.length > 3000) {
                messageText += '\n\n<i>...pesan terpotong...</i>';
            }
        } else {
            messageText += '<i>Email ini tidak memiliki isi teks atau gagal dimuat.</i>';
        }

        const keyboard = [];

        if (links && links.length > 0) {
            links.slice(0, 3).forEach(link => {
                const buttonText = link.text || 'Open Link';
                const displayText = buttonText.length > 30 ? buttonText.substring(0, 27) + '...' : buttonText;

                keyboard.push([{ 
                    text: `ᯓ➤ ${displayText} 𓀐`, 
                    web_app: { url: link.url }
                }]);
            });

            if (links.length > 3) {
                messageText += '\n\n<b>Link tambahan:</b>\n';
                links.slice(3).forEach((link, index) => {
                    messageText += `${index + 4}. ${escapeHtml(link.url)}\n`;
                });
            }
        }

        keyboard.push([{ text: '◀️ Kembali ke Inbox', callback_data: 'back_to_inbox' }]);
        keyboard.push([{ text: '🏠 Menu Utama', callback_data: 'main_menu' }]);

        await safeEditMessage(chatId, messageId, messageText, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: keyboard
            }
        });

    } catch (error) {
        console.error('Error viewing email:', error.message);
        await safeEditMessage(
            chatId,
            messageId,
            '❌ *Gagal memuat email!*\n\nCoba lagi nanti.',
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '◀️ Kembali ke Inbox', callback_data: 'back_to_inbox' }],
                        [{ text: '🏠 Menu Utama', callback_data: 'main_menu' }]
                    ]
                }
            }
        );
    }
}

function escapeHtml(text) {
    if (!text) return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

async function checkEmails(email, accessToken) {
    try {
        const response = await cloudscraper.post(`${TMAILOR_API}`, {
            json: {
                action: 'listinbox',
                accesstoken: accessToken
            },
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
                'Origin': 'https://tmailor.com',
                'Referer': 'https://tmailor.com/'
            }
        });

        const data = typeof response === 'string' ? JSON.parse(response) : response;
        console.log('✉️ Check emails response for', email + ':', JSON.stringify(data));

        if (data?.msg === 'ok') {
            if (data?.data === null || data?.data === undefined) {
                console.log('  → Inbox empty (data is null)');
                return [];
            }

            if (typeof data?.data === 'object' && !Array.isArray(data?.data)) {
                const emailsArray = Object.values(data.data);
                console.log('  → Found', emailsArray.length, 'emails (from object format)');
                return emailsArray;
            }

            if (Array.isArray(data?.data)) {
                console.log('  → Found', data.data.length, 'emails');
                return data.data;
            }
            console.log('  → Unexpected data format:', typeof data?.data);
            return [];
        } else {
            console.log('  ❌ API error:', data?.msg);
            return [];
        }
    } catch (error) {
        console.error('❌ Error checking emails:', error.message);
        return [];
    }
}

function showMainMenu(chatId, messageId = null, userId = null) {
    const welcomeMessage = 
        '📧 *TempMail Bot*\n\n' +
        'Bot untuk membuat email sementara (disposable email).\n\n' +
        'Pilih menu di bawah ini:';

    const menu = getMainMenuKeyboard(userId || chatId);

    if (messageId) {
        return bot.editMessageText(welcomeMessage, {
            chat_id: chatId,
            message_id: messageId,
            ...menu
        });
    } else {
        return bot.sendMessage(chatId, welcomeMessage, menu);
    }
}

// =================== HANDLER COMMAND ===================

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    console.log(`📱 User ${chatId} memulai bot`);
    showMainMenu(chatId);
});

bot.onText(/\/menu/, (msg) => {
    const chatId = msg.chat.id;
    showMainMenu(chatId);
});

// =================== CALLBACK QUERY HANDLER ===================

bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const action = callbackQuery.data;

    await bot.answerCallbackQuery(callbackQuery.id);

    if (action.startsWith('view_email:')) {
        const emailUuid = action.split(':')[1];
        await handleViewEmail(chatId, messageId, emailUuid);
        return;
    }

    switch (action) {
        case 'main_menu':
            await showMainMenu(chatId, messageId, callbackQuery.from.id);
            break;

        case 'new_email':
            await handleNewEmail(chatId, messageId);
            break;

        case 'check_email':
            await handleCheckEmail(chatId, messageId);
            break;

        case 'back_to_inbox':
            await handleCheckEmail(chatId, messageId);
            break;

        case 'list_emails':
            await handleListEmails(chatId, messageId);
            break;

        case 'help':
            await handleHelp(chatId, messageId);
            break;

        case 'broadcast_start':
            await handleBroadcastStart(chatId, messageId, callbackQuery.from.id);
            break;

        case 'broadcast_confirm':
            await handleBroadcastConfirm(chatId, callbackQuery.from.id);
            break;

        case 'broadcast_cancel':
            await handleBroadcastCancel(chatId);
            break;
    }
});

// =================== HANDLER FUNCTIONS ===================

async function handleNewEmail(chatId, messageId) {
    await safeEditMessage(chatId, messageId, '⏳ Sedang membuat email sementara...');

    try {
        const emailData = await createTempEmail();

        await deleteOldEmails(chatId);

        await saveEmail(chatId, emailData.email, emailData.code, emailData.token);

        const successMessage = 
            '✅ *Email berhasil dibuat!*\n\n' +
            `📧 *Alamat Email:*\n\`${emailData.email}\`\n\n` +
            `📅 *Dibuat:* ${new Date().toLocaleString('id-ID')}\n\n` +
            '*Cara penggunaan:*\n' +
            '1. Salin email di atas\n' +
            '2. Gunakan untuk registrasi website\n' +
            '3. Klik "Cek Email Masuk" untuk melihat email\n\n' +
            '⚠️ Email akan kadaluarsa setelah 15 menit tanpa aktivitas.';

        await safeEditMessage(chatId, messageId, successMessage, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔍 Cek Email Masuk', callback_data: 'check_email' }],
                    [{ text: '🏠 Kembali ke Menu', callback_data: 'main_menu' }]
                ]
            }
        });

    } catch (error) {
        console.error(`Error creating email for ${chatId}:`, error.message);
        await safeEditMessage(chatId, messageId, '❌ *Gagal membuat email!*\n\nSilakan coba beberapa saat lagi.', {
            parse_mode: 'Markdown',
            reply_markup: backToMenuKeyboard.reply_markup
        });
    }
}

async function handleCheckEmail(chatId, messageId) {
    const latestEmail = await getLatestEmail(chatId);

    if (!latestEmail) {
        await safeEditMessage(
            chatId,
            messageId,
            '❌ *Anda belum memiliki email.*\n\nBuat email terlebih dahulu.',
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📧 Buat Email Baru', callback_data: 'new_email' }],
                        [{ text: '🏠 Kembali ke Menu', callback_data: 'main_menu' }]
                    ]
                }
            }
        );
        return;
    }

    await safeEditMessage(chatId, messageId, '🔍 Sedang memeriksa email...');

    try {
        const result = await checkEmails(latestEmail.email, latestEmail.token);

        await updateLastChecked(latestEmail.id);

        if (Array.isArray(result) && result.length > 0) {
            const messages = result;

            userInboxCache.set(chatId, {
                emails: messages,
                token: latestEmail.token,
                emailAddress: latestEmail.email
            });

            let messageText = `📬 *${messages.length} Email Masuk*\n\n`;
            messageText += `Klik email untuk membaca isi:\n\n`;

            const emailButtons = [];
            messages.slice(0, 5).forEach((msg, index) => {
                const sender = msg.sender_name || msg.sender_email || 'Unknown';
                const subject = msg.subject || '(No Subject)';
                const shortSubject = subject.length > 25 ? subject.substring(0, 25) + '...' : subject;

                messageText += `*${index + 1}.* ${shortSubject}\n`;
                messageText += `   👤 ${sender}\n\n`;

                emailButtons.push([{ 
                    text: `📩 ${index + 1}. ${shortSubject}`, 
                    callback_data: `view_email:${msg.uuid || msg.id}` 
                }]);
            });

            if (messages.length > 5) {
                messageText += `...dan ${messages.length - 5} email lainnya.\n`;
            }

            messageText += `\n📧 \`${latestEmail.email}\``;

            emailButtons.push([{ text: '🔄 Refresh', callback_data: 'check_email' }]);
            emailButtons.push([{ text: '📧 Buat Email Baru', callback_data: 'new_email' }]);
            emailButtons.push([{ text: '🏠 Kembali ke Menu', callback_data: 'main_menu' }]);

            await safeEditMessage(chatId, messageId, messageText, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: emailButtons
                }
            });

        } else {
            await safeEditMessage(
                chatId,
                messageId,
                '📭 *Kotak masuk kosong*\n\nBelum ada email yang masuk.\n\n' +
                `📧 *Email:* \`${latestEmail.email}\``,
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔄 Refresh', callback_data: 'check_email' }],
                            [{ text: '📧 Buat Email Baru', callback_data: 'new_email' }],
                            [{ text: '🏠 Kembali ke Menu', callback_data: 'main_menu' }]
                        ]
                    }
                }
            );
        }

    } catch (error) {
        console.error(`Error checking email for ${chatId}:`, error.message);
        await safeEditMessage(
            chatId,
            messageId,
            '❌ *Gagal memeriksa email!*\n\n' +
            'Mungkin email sudah kadaluarsa atau terjadi kesalahan server.\n' +
            'Coba buat email baru.',
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📧 Buat Email Baru', callback_data: 'new_email' }],
                        [{ text: '🏠 Kembali ke Menu', callback_data: 'main_menu' }]
                    ]
                }
            }
        );
    }
}

async function handleListEmails(chatId, messageId) {
    const emails = await getUserEmails(chatId);

    if (emails.length === 0) {
        await safeEditMessage(
            chatId,
            messageId,
            '📭 *Anda belum memiliki email.*\n\nBuat email pertama Anda.',
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📧 Buat Email Baru', callback_data: 'new_email' }],
                        [{ text: '🏠 Kembali ke Menu', callback_data: 'main_menu' }]
                    ]
                }
            }
        );
        return;
    }

    let messageText = `📋 *Daftar Email Anda (${emails.length})*\n\n`;

    emails.forEach((email, index) => {
        const date = new Date(email.created_at).toLocaleString('id-ID');
        messageText += `${index + 1}. \`${email.email}\`\n`;
        messageText += `   📅 ${date}\n\n`;
    });

    await safeEditMessage(chatId, messageId, messageText, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '🔍 Cek Email Masuk', callback_data: 'check_email' }],
                [{ text: '📧 Buat Email Baru', callback_data: 'new_email' }],
                [{ text: '🏠 Kembali ke Menu', callback_data: 'main_menu' }]
            ]
        }
    });
}

async function handleHelp(chatId, messageId) {
    const helpMessage = 
        '🆘 *Bantuan TempMail Bot*\n\n' +
        '*Cara penggunaan:*\n' +
        '1. Klik "Buat Email Baru"\n' +
        '2. Salin email yang diberikan\n' +
        '3. Gunakan untuk registrasi website\n' +
        '4. Klik "Cek Email Masuk" untuk melihat email\n\n' +
        '*Fitur:*\n' +
        '• Buat unlimited email sementara\n' +
        '• Cek email masuk secara real-time\n' +
        '• Auto-check setiap 1 menit\n' +
        '• Data tersimpan di database\n\n' +
        '⚠️ *Perhatian:*\n' +
        '• Email bersifat sementara\n' +
        '• Saat membuat email baru, email lama akan dihapus\n' +
        '• Jangan gunakan untuk data penting';

    await safeEditMessage(chatId, messageId, helpMessage, {
        parse_mode: 'Markdown',
        reply_markup: backToMenuKeyboard.reply_markup
    });
}

async function handleBroadcastStart(chatId, messageId, userId) {
    const userCount = await getAllUsers().then(users => users.length);

    if (userCount === 0) {
        await safeEditMessage(chatId, messageId, '❌ Tidak ada user yang terdaftar untuk broadcast.');
        return;
    }

    broadcastState.set(chatId, {
        status: 'waiting_for_message',
        adminId: userId,
        userCount: userCount
    });

    await safeEditMessage(chatId, messageId, 
        '📢 <b>Broadcast Mode</b>\n\n' +
        'Silakan kirim pesan atau media yang ingin Anda broadcast:\n\n' +
        `👥 Target: ${userCount} user\n\n` +
        '<i>Atau klik /menu untuk membatalkan</i>',
        { parse_mode: 'HTML' }
    );
}

async function handleBroadcastConfirm(chatId, userId) {
    const state = broadcastState.get(chatId);
    if (!state || !state.message) {
        return bot.sendMessage(chatId, '❌ Tidak ada pesan broadcast yang siap.');
    }

    const message = state.message;
    const entities = state.entities || [];
    const users = await getAllUsers();

    if (users.length === 0) {
        broadcastState.delete(chatId);
        return bot.sendMessage(chatId, '❌ Tidak ada user untuk di-broadcast.');
    }

    await bot.sendMessage(chatId, '⏳ Sedang mengirim broadcast...');

    const broadcaster = new SmartBroadcaster(bot, BROADCAST_RATE_LIMIT);
    const result = await broadcaster.broadcast(users, state.type || 'text', message, state.mediaInfo || null, entities);

    try {
        const broadcastType = state.type === 'media' ? 'media' : 'text';
        await dbClient.query(
            'INSERT INTO broadcasts (admin_id, broadcast_type, content_text, total_users, success_count, failed_count) VALUES ($1, $2, $3, $4, $5, $6)',
            [userId, broadcastType, message, users.length, result.successCount || 0, result.failedCount || 0]
        );
    } catch (error) {
        console.error('Error saving broadcast:', error.message);
    }

    const reportMessage = 
        '📊 <b>Hasil Broadcast</b>\n\n' +
        `✅ Berhasil: ${result.successCount || 0}\n` +
        `❌ Gagal: ${result.failedCount || 0}\n` +
        `🚫 Blokir: ${result.blockedCount || 0}`;

    await bot.sendMessage(chatId, reportMessage, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard(userId).reply_markup });
    broadcastState.delete(chatId);
}

async function handleBroadcastCancel(chatId) {
    broadcastState.delete(chatId);
    await bot.sendMessage(chatId, '❌ Broadcast dibatalkan.', { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard(chatId).reply_markup });
}

// =================== BROADCAST COMMANDS ===================

function isAdmin(userId) {
    return ADMIN_IDS.includes(userId);
}

async function getAllUsers() {
    try {
        const result = await dbClient.query('SELECT user_id FROM bot_users ORDER BY user_id');
        return result.rows.map(row => row.user_id);
    } catch (error) {
        console.error('Error getting users:', error.message);
        return [];
    }
}

async function trackUser(userId, username = null) {
    try {
        await dbClient.query(
            `INSERT INTO bot_users (user_id, username, last_interaction) 
             VALUES ($1, $2, CURRENT_TIMESTAMP)
             ON CONFLICT (user_id) DO UPDATE SET last_interaction = CURRENT_TIMESTAMP`,
            [userId, username]
        );
        
        await dbClient.query(
            `UPDATE user_emails SET last_activity = CURRENT_TIMESTAMP WHERE user_id = $1`,
            [userId]
        ).catch(() => {});
    } catch (error) {
        console.error('Error tracking user:', error.message);
    }
}

bot.onText(/\/broadcast\s+(.+)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!isAdmin(userId)) {
        return bot.sendMessage(chatId, '❌ Anda tidak memiliki akses untuk broadcast.');
    }

    const message = match[1];
    const userCount = await getAllUsers().then(users => users.length);

    if (userCount === 0) {
        return bot.sendMessage(chatId, '❌ Tidak ada user yang terdaftar.');
    }

    broadcastState.set(chatId, {
        type: 'text',
        message: message,
        adminId: userId,
        userCount: userCount
    });

    await bot.sendMessage(chatId, `📋 *Preview Pesan:*\n\n${message}`, { parse_mode: 'Markdown' });

    await bot.sendMessage(chatId, 
        `📢 *KONFIRMASI BROADCAST*\n\n` +
        `👥 *Target:* ${userCount} user\n` +
        `📝 *Tipe:* Teks\n\n` +
        `⚠️ *Kirim broadcast ke semua user?*`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    { text: '✅ Ya, Kirim', callback_data: 'broadcast_confirm' },
                    { text: '❌ Batal', callback_data: 'broadcast_cancel' }
                ]]
            }
        }
    );
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    const state = broadcastState.get(chatId);
    if (state && state.status === 'waiting_for_message' && isAdmin(userId)) {
        if (msg.text && !msg.text.startsWith('/')) {
            const entities = msg.entities || [];

            broadcastState.set(chatId, {
                ...state,
                type: 'text',
                message: msg.text,
                entities: entities
            });

            await bot.sendMessage(chatId, '📋 <b>Preview Pesan:</b>', { parse_mode: 'HTML' });

            if (entities.length > 0) {
                await bot.sendMessage(chatId, msg.text, { entities: entities });
            } else {
                await bot.sendMessage(chatId, msg.text);
            }

            const entityInfo = entities.length > 0 ? `\n🎨 <b>Format:</b> ${entities.length} formatting entities preserved` : '';

            await bot.sendMessage(chatId, 
                `📢 <b>KONFIRMASI BROADCAST</b>\n\n` +
                `👥 <b>Target:</b> ${state.userCount} user\n` +
                `📝 <b>Tipe:</b> Teks${entityInfo}\n\n` +
                `⚠️ <b>Kirim broadcast ke semua user?</b>\n\n` +
                `<i>✅ Formatting akan terkirim PERSIS seperti preview di atas</i>`,
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '✅ Ya, Kirim', callback_data: 'broadcast_confirm' },
                            { text: '❌ Batal', callback_data: 'broadcast_cancel' }
                        ]]
                    }
                }
            );
            return;
        }
    }

    if (!isAdmin(userId)) return;

    let mediaInfo = null;
    let mediaCaption = msg.caption || null;

    if (msg.photo) {
        mediaInfo = { type: 'photo', file_id: msg.photo[msg.photo.length - 1].file_id };
    } else if (msg.video) {
        mediaInfo = { type: 'video', file_id: msg.video.file_id };
    } else if (msg.document) {
        mediaInfo = { type: 'document', file_id: msg.document.file_id };
    } else if (msg.audio) {
        mediaInfo = { type: 'audio', file_id: msg.audio.file_id };
    } else if (msg.voice) {
        mediaInfo = { type: 'voice', file_id: msg.voice.file_id };
    } else if (msg.animation) {
        mediaInfo = { type: 'animation', file_id: msg.animation.file_id };
    }

    if (mediaInfo && (mediaCaption || msg.text)) {
        const caption = mediaCaption || msg.text || '';
        const userCount = await getAllUsers().then(users => users.length);

        if (userCount === 0) {
            return bot.sendMessage(chatId, '❌ Tidak ada user yang terdaftar.');
        }

        broadcastState.set(chatId, {
            type: 'media',
            message: caption,
            mediaInfo: mediaInfo,
            adminId: userId,
            userCount: userCount
        });

        try {
            switch (mediaInfo.type) {
                case 'photo':
                    await bot.sendPhoto(chatId, mediaInfo.file_id, { caption: caption || 'No caption' });
                    break;
                case 'video':
                    await bot.sendVideo(chatId, mediaInfo.file_id, { caption: caption || 'No caption' });
                    break;
                case 'document':
                    await bot.sendDocument(chatId, mediaInfo.file_id, { caption: caption || 'No caption' });
                    break;
                case 'audio':
                    await bot.sendAudio(chatId, mediaInfo.file_id, { caption: caption || 'No caption' });
                    break;
                case 'animation':
                    await bot.sendAnimation(chatId, mediaInfo.file_id, { caption: caption || 'No caption' });
                    break;
            }
        } catch (error) {
            console.error('Error sending preview:', error.message);
        }

        const typeText = { photo: '📸 Foto', video: '🎥 Video', document: '📄 Dokumen', audio: '🎵 Audio', voice: '🎤 Voice', animation: '🎬 GIF' };

        await bot.sendMessage(chatId, 
            `📢 *KONFIRMASI BROADCAST MEDIA*\n\n` +
            `👥 *Target:* ${userCount} user\n` +
            `📎 *Tipe:* ${typeText[mediaInfo.type] || mediaInfo.type}\n\n` +
            `⚠️ *Kirim broadcast media ke semua user?*`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        { text: '✅ Ya, Kirim', callback_data: 'broadcast_confirm' },
                        { text: '❌ Batal', callback_data: 'broadcast_cancel' }
                    ]]
                }
            }
        );
    }
});

bot.on('callback_query', async (callbackQuery) => {
    if (callbackQuery.data === 'broadcast_confirm') {
        const chatId = callbackQuery.message.chat.id;
        const state = broadcastState.get(chatId);

        if (!state) {
            return bot.answerCallbackQuery(callbackQuery.id, { text: 'Broadcast state tidak ditemukan', show_alert: true });
        }

        await bot.answerCallbackQuery(callbackQuery.id);
        await bot.editMessageText('🔄 Mempersiapkan broadcast...', {
            chat_id: chatId,
            message_id: callbackQuery.message.message_id,
            reply_markup: { inline_keyboard: [] }
        });

        const userArray = await getAllUsers();

        if (userArray.length === 0) {
            return bot.editMessageText('❌ Tidak ada user untuk broadcast.', {
                chat_id: chatId,
                message_id: callbackQuery.message.message_id
            });
        }

        const broadcaster = new SmartBroadcaster(bot, dbClient);
        broadcaster.broadcast(userArray, state.message, state.mediaInfo || null, state.message);

        let lastProgress = 0;
        const progressInterval = setInterval(async () => {
            try {
                const progress = broadcaster.getProgress();

                const percent = progress.progressPercent;
                if (percent !== lastProgress && percent % 10 === 0) {
                    lastProgress = percent;

                    const statusText = 
                        `🚀 *BROADCAST BERJALAN*\n\n` +
                        `📊 Progress: ${progress.progressPercent}% (${progress.processed}/${progress.total})\n` +
                        `✅ Berhasil: ${progress.success}\n` +
                        `❌ Gagal: ${progress.failed}\n` +
                        `🚫 Blocked: ${progress.blocked}\n` +
                        `⏱️ Waktu: ${progress.elapsedTime}s`;

                    await safeEditMessage(chatId, callbackQuery.message.message_id, statusText, {
                        parse_mode: 'Markdown'
                    });
                }

                if (!progress.isProcessing && progress.remaining === 0) {
                    clearInterval(progressInterval);

                    const finalStatus = 
                        `✅ *BROADCAST SELESAI*\n\n` +
                        `📊 *Hasil:*\n` +
                        `✅ Berhasil: ${progress.success}\n` +
                        `❌ Gagal: ${progress.failed}\n` +
                        `🚫 Blocked: ${progress.blocked}\n` +
                        `⏱️ Total waktu: ${progress.elapsedTime}s\n\n` +
                        `📈 *Success Rate:* ${Math.round((progress.success / progress.total) * 100)}%`;

                    await safeEditMessage(chatId, callbackQuery.message.message_id, finalStatus, {
                        parse_mode: 'Markdown'
                    });

                    broadcastState.delete(chatId);
                }
            } catch (error) {
                console.error('Progress update error:', error.message);
            }
        }, 2000);

    } else if (callbackQuery.data === 'broadcast_cancel') {
        await bot.answerCallbackQuery(callbackQuery.id);
        await bot.editMessageText('❌ Broadcast dibatalkan.', {
            chat_id: callbackQuery.message.chat.id,
            message_id: callbackQuery.message.message_id,
            reply_markup: { inline_keyboard: [] }
        });
        broadcastState.delete(callbackQuery.message.chat.id);
    }
});

// =================== PESAN BIASA ===================
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    trackUser(msg.from.id, msg.from.username);

    if (text && !text.startsWith('/')) {
        showMainMenu(chatId);
    }
});

// =================== SMART AUTO CHECK WITH CIRCUIT BREAKER ===================
const MAX_RETRIES = 3;
let isProcessingAutoCheck = false;
let lastCheckStats = { total: 0, checked: 0, failed: 0, newEmails: 0, skipped: 0 };
let adaptiveConcurrency = CONCURRENT_CHECKS;

async function checkEmailWithTimeout(userId, latestEmail, retries = 0) {
    if (!circuitBreaker.canRequest()) {
        lastCheckStats.skipped++;
        return false;
    }
    
    try {
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Check timeout')), CHECK_TIMEOUT)
        );
        
        const result = await Promise.race([
            checkEmails(latestEmail.email, latestEmail.token),
            timeoutPromise
        ]);

        circuitBreaker.recordSuccess();

        if (Array.isArray(result) && result.length > 0) {
            const lastCheckTime = new Date(latestEmail.last_checked);
            const newMessages = result.filter(msg => 
                msg.time && new Date(msg.time * 1000) > lastCheckTime
            );

            if (newMessages.length > 0) {
                lastCheckStats.newEmails++;
                bot.sendMessage(
                    userId,
                    `📬 *${newMessages.length} Email Baru Masuk!*\n\n` +
                    `📧 Email: \`${latestEmail.email}\``,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '🔍 Lihat Email', callback_data: 'check_email' }]
                            ]
                        }
                    }
                ).catch(err => console.error(`Notification failed for ${userId}:`, err.message));

                await updateLastChecked(latestEmail.id);
            }
        }
        
        await dbClient.query('UPDATE user_emails SET check_count = check_count + 1 WHERE id = $1', [latestEmail.id]).catch(() => {});
        
        lastCheckStats.checked++;
        return true;
    } catch (error) {
        circuitBreaker.recordFailure();
        
        if (retries < MAX_RETRIES && circuitBreaker.canRequest()) {
            const delay = Math.pow(2, retries) * 500;
            await new Promise(resolve => setTimeout(resolve, delay));
            return checkEmailWithTimeout(userId, latestEmail, retries + 1);
        }
        lastCheckStats.failed++;
        return false;
    }
}

async function processBatch(emailBatch) {
    const promises = emailBatch.map(({ userId, email }) => 
        checkEmailWithTimeout(userId, email).catch(err => {
            lastCheckStats.failed++;
        })
    );
    await Promise.all(promises);
}

async function getActiveEmails() {
    const query = `
        SELECT ue.id, ue.user_id, ue.email, ue.code, ue.token, ue.last_checked,
               ue.created_at, ue.last_activity
        FROM user_emails ue
        WHERE ue.is_active = true 
          AND ue.last_activity > NOW() - INTERVAL '${ACTIVE_USER_HOURS} hours'
        ORDER BY ue.last_activity DESC
        LIMIT 50000
    `;
    
    try {
        const result = await dbClient.query(query);
        return result.rows;
    } catch (error) {
        console.log('⚠️ Fallback to legacy query');
        const result = await dbClient.query('SELECT * FROM user_emails ORDER BY created_at DESC LIMIT 10000');
        return result.rows;
    }
}

async function autoCheckEmails() {
    if (isProcessingAutoCheck) {
        console.log('⏳ Previous auto-check still running, skipping...');
        return;
    }

    if (!circuitBreaker.canRequest()) {
        console.log('🔴 Circuit breaker open, skipping auto-check...');
        return;
    }

    isProcessingAutoCheck = true;
    const startTime = Date.now();
    console.log('🔍 Smart auto-check running...');

    try {
        const activeEmails = await getActiveEmails();
        const totalActive = activeEmails.length;
        
        const totalResult = await dbClient.query('SELECT COUNT(*) as count FROM user_emails');
        const totalUsers = parseInt(totalResult.rows[0].count);
        
        lastCheckStats = { total: totalActive, checked: 0, failed: 0, newEmails: 0, skipped: totalUsers - totalActive };

        console.log(`📧 Checking ${totalActive} active users (${lastCheckStats.skipped} inactive skipped) of ${totalUsers} total`);

        const emailsList = activeEmails.map(email => ({
            userId: email.user_id,
            email: email
        }));

        if (lastCheckStats.failed > lastCheckStats.checked * 0.3) {
            adaptiveConcurrency = Math.max(3, adaptiveConcurrency - 2);
            console.log(`⚠️ High failure rate, reducing concurrency to ${adaptiveConcurrency}`);
        } else if (lastCheckStats.failed < lastCheckStats.checked * 0.05 && adaptiveConcurrency < CONCURRENT_CHECKS) {
            adaptiveConcurrency = Math.min(CONCURRENT_CHECKS, adaptiveConcurrency + 1);
        }

        for (let i = 0; i < emailsList.length; i += adaptiveConcurrency) {
            if (!circuitBreaker.canRequest()) {
                console.log('🔴 Circuit breaker opened during check, stopping...');
                break;
            }
            
            const batch = emailsList.slice(i, i + adaptiveConcurrency);
            await processBatch(batch);
            
            if (i + adaptiveConcurrency < emailsList.length) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            
            if (emailsList.length > 1000 && (i % 500 === 0)) {
                const progress = ((i / emailsList.length) * 100).toFixed(0);
                console.log(`📊 Progress: ${progress}% (${i}/${emailsList.length})`);
            }
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`✅ Auto-check completed in ${duration}s - Checked: ${lastCheckStats.checked}/${lastCheckStats.total}, New: ${lastCheckStats.newEmails}, Failed: ${lastCheckStats.failed}, Skipped: ${lastCheckStats.skipped}`);

    } catch (error) {
        console.error('❌ Auto-check database error:', error.message);
    } finally {
        isProcessingAutoCheck = false;
    }
}

setInterval(autoCheckEmails, CHECK_INTERVAL);

// Show stats on startup
setTimeout(() => {
    console.log(`⚙️ Scale settings: Pool=${DB_POOL_SIZE}, Concurrent=${CONCURRENT_CHECKS}, Timeout=${CHECK_TIMEOUT}ms, Interval=${CHECK_INTERVAL}ms, ActiveHours=${ACTIVE_USER_HOURS}h, CacheMax=${CACHE_MAX_SIZE}`);
}, 1000);

// =================== STARTUP MESSAGE ===================
console.log('✅ Bot berhasil dijalankan!');
console.log(`⏱️ Auto-check interval: ${CHECK_INTERVAL / 1000} detik`);
console.log('📧 API TMailor: ' + TMAILOR_API);
console.log('\n🔥 Bot siap digunakan! Ketik /start di Telegram');
'use strict';
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const TelegramBot = require('node-telegram-bot-api');
const express     = require('express');

const cfg         = require('./lib/config');
const db          = require('./lib/database');
const emailApi    = require('./lib/emailApi');
const helpers     = require('./lib/helpers');
const menus       = require('./lib/menus');
const state       = require('./lib/state');
const emailH      = require('./lib/handlers/email');
const donasiH     = require('./lib/handlers/donasi');
const broadcastH  = require('./lib/handlers/broadcast');
const autoCheck   = require('./lib/autoCheck');
const saweria     = require('./saweria');

// =================== VALIDATE TOKEN ===================
if (!cfg.TELEGRAM_TOKEN || cfg.TELEGRAM_TOKEN === 'your_telegram_bot_token_here') {
    console.error('❌ ERROR: Token Telegram bot belum diatur!');
    console.error('1. Buat bot di @BotFather di Telegram');
    console.error('2. Dapatkan token');
    console.error('3. Masukkan token ke file .env');
    process.exit(1);
}

// =================== BOT + EXPRESS ===================
const bot = new TelegramBot(cfg.TELEGRAM_TOKEN, {
    polling: {
        interval: 2000,
        autoStart: true,
        params: { timeout: 10 }
    }
});

console.log('🤖 Bot Telegram TempMail sedang diinisialisasi...');

const app = express();
app.use(express.json());
app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(cfg.WEBHOOK_PORT, '0.0.0.0', () => {
    console.log(`🚀 Health check server running on port ${cfg.WEBHOOK_PORT}`);
});

// =================== INIT DB ===================
(async () => {
    try {
        await db.initDb();
    } catch (err) {
        console.error('❌ Database connection error:', err.message);
        process.exit(1);
    }
})();

// =================== WIRE MODULES ===================
helpers.init({ bot });
menus.init({ bot });

emailH.init({
    bot,
    safeEditMessage:  helpers.safeEditMessage,
    escapeHtml:       helpers.escapeHtml,
    backToMenuKeyboard: menus.backToMenuKeyboard,
    createTempEmail:  emailApi.createTempEmail,
    checkEmails:      emailApi.checkEmails,
    getEmailBody:     emailApi.getEmailBody,
    saveEmail:        db.saveEmail,
    deleteOldEmails:  db.deleteOldEmails,
    getLatestEmail:   db.getLatestEmail,
    getUserEmails:    db.getUserEmails,
    updateLastChecked: db.updateLastChecked,
    userInboxCache:   state.userInboxCache,
    saweria,
});

donasiH.init({
    bot,
    safeEditMessage:         helpers.safeEditMessage,
    saweria,
    donationSessions:        state.donationSessions,
    activeDonationPollers:   state.activeDonationPollers,
    DONATION_NOMINAL_OPTIONS: state.DONATION_NOMINAL_OPTIONS,
});

broadcastH.init({
    bot,
    dbClient:          db.dbClient,
    safeEditMessage:   helpers.safeEditMessage,
    getMainMenuKeyboard: menus.getMainMenuKeyboard,
    broadcastState:    state.broadcastState,
});

autoCheck.init({
    bot,
    dbClient:         db.dbClient,
    checkEmails:      emailApi.checkEmails,
    updateLastChecked: db.updateLastChecked,
});

// =================== TEST BOT AUTH ===================
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
        });
}

// =================== BOT ERROR HANDLERS ===================
bot.on('error',          (error) => console.error('❌ Bot error:', error.message));
bot.on('polling_error',  (error) => console.error('❌ Polling error:', error.message));
bot.on('webhook_error',  (error) => console.error('❌ Webhook error:', error.message));

process.on('unhandledRejection', (reason) => console.error('❌ Unhandled Rejection:', reason));
process.on('uncaughtException',  (error)  => console.error('❌ Uncaught Exception:', error.message));

process.on('SIGINT',  () => _gracefulShutdown());
process.on('SIGTERM', () => _gracefulShutdown());

function _gracefulShutdown() {
    for (const [donationId, interval] of state.activeDonationPollers.entries()) {
        clearInterval(interval);
        saweria.deleteQRFile(donationId);
    }
    process.exit(0);
}

// =================== COMMAND HANDLERS ===================
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    console.log(`📱 User ${chatId} memulai bot`);
    menus.showMainMenu(chatId);
});

bot.onText(/\/menu/, (msg) => {
    menus.showMainMenu(msg.chat.id);
});

bot.onText(/\/donasi/, async (msg) => {
    const chatId  = msg.chat.id;
    const sentMsg = await bot.sendMessage(chatId, '⏳ Loading...', { parse_mode: 'Markdown' });
    await donasiH.handleDonasiStart(chatId, sentMsg.message_id);
});

bot.onText(/\/broadcast\s+(.+)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!broadcastH.isAdmin(userId)) {
        return bot.sendMessage(chatId, '❌ Anda tidak memiliki akses untuk broadcast.');
    }

    const message   = match[1];
    const userCount = await broadcastH.getAllUsers().then(users => users.length);

    if (userCount === 0) {
        return bot.sendMessage(chatId, '❌ Tidak ada user yang terdaftar.');
    }

    state.broadcastState.set(chatId, {
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
                    { text: '❌ Batal',    callback_data: 'broadcast_cancel'  }
                ]]
            }
        }
    );
});

// =================== CALLBACK QUERY HANDLER ===================
bot.on('callback_query', async (callbackQuery) => {
    const chatId    = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const action    = callbackQuery.data;
    const fromUser  = callbackQuery.from;

    await bot.answerCallbackQuery(callbackQuery.id);

    if (action.startsWith('view_email:')) {
        const emailUuid = action.split(':')[1];
        await emailH.handleViewEmail(chatId, messageId, emailUuid);
        return;
    }

    switch (action) {
        case 'main_menu':
            state.donationSessions.delete(chatId);
            await menus.showMainMenu(chatId, messageId, fromUser.id);
            break;

        case 'new_email':
            await emailH.handleNewEmail(chatId, messageId);
            break;

        case 'check_email':
        case 'back_to_inbox':
            await emailH.handleCheckEmail(chatId, messageId);
            break;

        case 'list_emails':
            await emailH.handleListEmails(chatId, messageId);
            break;

        case 'help':
            await emailH.handleHelp(chatId, messageId);
            break;

        case 'broadcast_start':
            await broadcastH.handleBroadcastStart(chatId, messageId, fromUser.id);
            break;

        case 'broadcast_confirm':
            await broadcastH.handleBroadcastConfirm(chatId, fromUser.id);
            break;

        case 'broadcast_cancel':
            await broadcastH.handleBroadcastCancel(chatId);
            break;

        case 'donasi_start':
            await donasiH.handleDonasiStart(chatId, messageId);
            break;

        case 'donasi_nominal':
            await donasiH.handleDonasiNominal(chatId, messageId);
            break;

        case 'donasi_custom':
            state.donationSessions.set(chatId, { step: 'custom_amount', fromUser });
            await helpers.safeEditMessage(chatId, messageId,
                '✏️ *Masukkan Nominal Donasi*\n\nKetik jumlah (angka saja, min. Rp 1.000):\n\n_Contoh:_ `25000`',
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'donasi_nominal' }]]
                    }
                }
            );
            break;

        case 'donasi_confirm': {
            const session = state.donationSessions.get(chatId);
            if (session && session.step === 'confirm') {
                state.donationSessions.delete(chatId);
                await donasiH.processDonasiPayment(chatId, session.amount, session.name, session.email, session.message);
            }
            break;
        }

        default:
            if (action.startsWith('donasi_amount_')) {
                const amount = parseInt(action.replace('donasi_amount_', ''));
                await donasiH.handleDonasiAmountSelected(chatId, messageId, amount, fromUser);
            } else if (action.startsWith('donasi_cancel_')) {
                const donationId = action.replace('donasi_cancel_', '');
                await donasiH.handleDonasiCancelPayment(chatId, messageId, donationId);
            }
            break;
    }
});

// =================== MESSAGE HANDLER ===================
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text   = msg.text;

    broadcastH.trackUser(userId, msg.from.username);

    const bState = state.broadcastState.get(chatId);
    if (bState && bState.status === 'waiting_for_message' && broadcastH.isAdmin(userId)) {
        if (msg.text && !msg.text.startsWith('/')) {
            const entities = msg.entities || [];

            state.broadcastState.set(chatId, {
                ...bState,
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

            const entityInfo = entities.length > 0
                ? `\n🎨 <b>Format:</b> ${entities.length} formatting entities preserved`
                : '';

            await bot.sendMessage(chatId,
                `📢 <b>KONFIRMASI BROADCAST</b>\n\n` +
                `👥 <b>Target:</b> ${bState.userCount} user\n` +
                `📝 <b>Tipe:</b> Teks${entityInfo}\n\n` +
                `⚠️ <b>Kirim broadcast ke semua user?</b>\n\n` +
                `<i>✅ Formatting akan terkirim PERSIS seperti preview di atas</i>`,
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '✅ Ya, Kirim', callback_data: 'broadcast_confirm' },
                            { text: '❌ Batal',    callback_data: 'broadcast_cancel'  }
                        ]]
                    }
                }
            );
            return;
        }
    }

    const donationSession = state.donationSessions.get(chatId);
    if (donationSession && text && !text.startsWith('/')) {
        await donasiH.handleDonasiTextInput(chatId, userId, text, donationSession);
        return;
    }

    if (!broadcastH.isAdmin(userId)) {
        if (text && !text.startsWith('/')) menus.showMainMenu(chatId);
        return;
    }

    let mediaInfo    = null;
    let mediaCaption = msg.caption || null;

    if (msg.photo)     mediaInfo = { type: 'photo',     file_id: msg.photo[msg.photo.length - 1].file_id };
    else if (msg.video)     mediaInfo = { type: 'video',     file_id: msg.video.file_id     };
    else if (msg.document)  mediaInfo = { type: 'document',  file_id: msg.document.file_id  };
    else if (msg.audio)     mediaInfo = { type: 'audio',     file_id: msg.audio.file_id     };
    else if (msg.voice)     mediaInfo = { type: 'voice',     file_id: msg.voice.file_id     };
    else if (msg.animation) mediaInfo = { type: 'animation', file_id: msg.animation.file_id };

    if (mediaInfo && (mediaCaption || msg.text)) {
        const caption   = mediaCaption || msg.text || '';
        const userCount = await broadcastH.getAllUsers().then(users => users.length);

        if (userCount === 0) {
            return bot.sendMessage(chatId, '❌ Tidak ada user yang terdaftar.');
        }

        state.broadcastState.set(chatId, {
            type: 'media',
            message: caption,
            mediaInfo: mediaInfo,
            adminId: userId,
            userCount: userCount
        });

        try {
            switch (mediaInfo.type) {
                case 'photo':    await bot.sendPhoto(chatId,     mediaInfo.file_id, { caption: caption || 'No caption' }); break;
                case 'video':    await bot.sendVideo(chatId,     mediaInfo.file_id, { caption: caption || 'No caption' }); break;
                case 'document': await bot.sendDocument(chatId,  mediaInfo.file_id, { caption: caption || 'No caption' }); break;
                case 'audio':    await bot.sendAudio(chatId,     mediaInfo.file_id, { caption: caption || 'No caption' }); break;
                case 'animation':await bot.sendAnimation(chatId, mediaInfo.file_id, { caption: caption || 'No caption' }); break;
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
                        { text: '❌ Batal',    callback_data: 'broadcast_cancel'  }
                    ]]
                }
            }
        );
        return;
    }

    if (text && !text.startsWith('/')) {
        menus.showMainMenu(chatId);
    }
});

// =================== AUTO CHECK ===================
setInterval(autoCheck.autoCheckEmails, cfg.CHECK_INTERVAL);

setTimeout(() => {
    console.log(`⚙️ Scale settings: Pool=${cfg.DB_POOL_SIZE}, Concurrent=${cfg.CONCURRENT_CHECKS}, Timeout=${cfg.CHECK_TIMEOUT}ms, Interval=${cfg.CHECK_INTERVAL}ms, ActiveHours=${cfg.ACTIVE_USER_HOURS}h, CacheMax=${cfg.CACHE_MAX_SIZE}`);
}, 1000);

// =================== STARTUP ===================
console.log('✅ Bot berhasil dijalankan!');
console.log(`⏱️ Auto-check interval: ${cfg.CHECK_INTERVAL / 1000} detik`);
console.log('📧 API TMailor: ' + cfg.TMAILOR_API);
testBotAuth();
console.log('\n🔥 Bot siap digunakan! Ketik /start di Telegram');

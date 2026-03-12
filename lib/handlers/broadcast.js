'use strict';
const SmartBroadcaster = require('../../smartBroadcaster');
const { ADMIN_IDS } = require('../config');

let _bot, _dbClient, _safeEditMessage, _getMainMenuKeyboard, _broadcastState;

function init({ bot, dbClient, safeEditMessage, getMainMenuKeyboard, broadcastState }) {
    _bot = bot;
    _dbClient = dbClient;
    _safeEditMessage = safeEditMessage;
    _getMainMenuKeyboard = getMainMenuKeyboard;
    _broadcastState = broadcastState;
}

function isAdmin(userId) {
    return ADMIN_IDS.includes(userId);
}

async function getAllUsers() {
    try {
        const result = await _dbClient.query('SELECT user_id FROM bot_users ORDER BY user_id');
        return result.rows.map(row => row.user_id);
    } catch (error) {
        console.error('Error getting users:', error.message);
        return [];
    }
}

async function trackUser(userId, username = null) {
    try {
        await _dbClient.query(
            `INSERT INTO bot_users (user_id, username, last_interaction) 
             VALUES ($1, $2, CURRENT_TIMESTAMP)
             ON CONFLICT (user_id) DO UPDATE SET last_interaction = CURRENT_TIMESTAMP`,
            [userId, username]
        );

        await _dbClient.query(
            `UPDATE user_emails SET last_activity = CURRENT_TIMESTAMP WHERE user_id = $1`,
            [userId]
        ).catch(() => {});
    } catch (error) {
        console.error('Error tracking user:', error.message);
    }
}

async function handleBroadcastStart(chatId, messageId, userId) {
    const userCount = await getAllUsers().then(users => users.length);

    if (userCount === 0) {
        await _safeEditMessage(chatId, messageId, '❌ Tidak ada user yang terdaftar untuk broadcast.');
        return;
    }

    _broadcastState.set(chatId, {
        status: 'waiting_for_message',
        adminId: userId,
        userCount: userCount
    });

    await _safeEditMessage(chatId, messageId,
        '📢 <b>Broadcast Mode</b>\n\n' +
        'Silakan kirim pesan atau media yang ingin Anda broadcast:\n\n' +
        `👥 Target: ${userCount} user\n\n` +
        '<i>Atau klik /menu untuk membatalkan</i>',
        { parse_mode: 'HTML' }
    );
}

async function handleBroadcastConfirm(chatId, userId) {
    const state = _broadcastState.get(chatId);
    if (!state || !state.message) {
        return _bot.sendMessage(chatId, '❌ Tidak ada pesan broadcast yang siap.');
    }

    const message = state.message;
    const entities = state.entities || [];
    const users = await getAllUsers();

    if (users.length === 0) {
        _broadcastState.delete(chatId);
        return _bot.sendMessage(chatId, '❌ Tidak ada user untuk di-broadcast.');
    }

    await _bot.sendMessage(chatId, '⏳ Sedang mengirim broadcast...');

    const broadcaster = new SmartBroadcaster(_bot, _dbClient);
    const result = await broadcaster.broadcast(users, message, state.mediaInfo || null, message, entities);

    try {
        const broadcastType = state.type === 'media' ? 'media' : 'text';
        await _dbClient.query(
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

    await _bot.sendMessage(chatId, reportMessage, { parse_mode: 'HTML', reply_markup: _getMainMenuKeyboard(userId).reply_markup });
    _broadcastState.delete(chatId);
}

async function handleBroadcastCancel(chatId) {
    _broadcastState.delete(chatId);
    await _bot.sendMessage(chatId, '❌ Broadcast dibatalkan.', { parse_mode: 'HTML', reply_markup: _getMainMenuKeyboard(chatId).reply_markup });
}

module.exports = {
    init,
    isAdmin,
    getAllUsers,
    trackUser,
    handleBroadcastStart,
    handleBroadcastConfirm,
    handleBroadcastCancel,
};

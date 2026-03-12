'use strict';
const { ADMIN_IDS } = require('./config');

let _bot = null;

function init({ bot }) {
    _bot = bot;
}

function isAdmin(userId) {
    return ADMIN_IDS.includes(userId);
}

function getMainMenuKeyboard(userId) {
    const buttons = [
        [{ text: '📧 Buat Email Baru', callback_data: 'new_email' }],
        [{ text: '🔍 Cek Email Masuk', callback_data: 'check_email' }],
        [{ text: '📋 Daftar Email Saya', callback_data: 'list_emails' }],
        [{ text: '💝 Dukung Bot — Tetap Online!', callback_data: 'donasi_start' }],
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

function showMainMenu(chatId, messageId = null, userId = null) {
    const welcomeMessage =
        '📧 *TempMail Bot*\n\n' +
        'Bot untuk membuat email sementara (disposable email).\n\n' +
        'Pilih menu di bawah ini:';

    const menu = getMainMenuKeyboard(userId || chatId);

    if (messageId) {
        return _bot.editMessageText(welcomeMessage, {
            chat_id: chatId,
            message_id: messageId,
            ...menu
        });
    } else {
        return _bot.sendMessage(chatId, welcomeMessage, menu);
    }
}

module.exports = { init, isAdmin, getMainMenuKeyboard, backToMenuKeyboard, showMainMenu };

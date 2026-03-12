'use strict';

let _bot, _safeEditMessage, _escapeHtml, _backToMenuKeyboard;
let _createTempEmail, _checkEmails, _getEmailBody;
let _saveEmail, _deleteOldEmails, _getLatestEmail, _getUserEmails, _updateLastChecked;
let _userInboxCache;
let _saweria;

function init({ bot, safeEditMessage, escapeHtml, backToMenuKeyboard,
                createTempEmail, checkEmails, getEmailBody,
                saveEmail, deleteOldEmails, getLatestEmail, getUserEmails, updateLastChecked,
                userInboxCache, saweria }) {
    _bot = bot;
    _safeEditMessage = safeEditMessage;
    _escapeHtml = escapeHtml;
    _backToMenuKeyboard = backToMenuKeyboard;
    _createTempEmail = createTempEmail;
    _checkEmails = checkEmails;
    _getEmailBody = getEmailBody;
    _saveEmail = saveEmail;
    _deleteOldEmails = deleteOldEmails;
    _getLatestEmail = getLatestEmail;
    _getUserEmails = getUserEmails;
    _updateLastChecked = updateLastChecked;
    _userInboxCache = userInboxCache;
    _saweria = saweria;
}

async function handleNewEmail(chatId, messageId) {
    await _safeEditMessage(chatId, messageId, '⏳ Sedang membuat email sementara...');

    try {
        const emailData = await _createTempEmail();

        await _deleteOldEmails(chatId);
        await _saveEmail(chatId, emailData.email, emailData.code, emailData.token);

        const successMessage =
            '✅ *Email berhasil dibuat!*\n\n' +
            `📧 *Alamat Email:*\n\`${emailData.email}\`\n\n` +
            `📅 *Dibuat:* ${new Date().toLocaleString('id-ID')}\n\n` +
            '*Cara penggunaan:*\n' +
            '1. Salin email di atas\n' +
            '2. Gunakan untuk registrasi website\n' +
            '3. Klik "Cek Email Masuk" untuk melihat email\n\n' +
            '⚠️ Email akan kadaluarsa setelah 15 menit tanpa aktivitas.';

        await _safeEditMessage(chatId, messageId, successMessage, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔍 Cek Email Masuk', callback_data: 'check_email' }],
                    [{ text: '💝 Support Biar Bot Tetap Ada', callback_data: 'donasi_start' }],
                    [{ text: '🏠 Kembali ke Menu', callback_data: 'main_menu' }]
                ]
            }
        });

        setTimeout(() => {
            _bot.sendMessage(chatId,
                `💡 *Tau nggak?*\n\n` +
                `Bot ini bisa hilang kapan aja kalau nggak ada yang support.\n` +
                `Ribuan orang sudah pake, tapi cuma _sedikit_ yang peduli buat jaga-jaga.\n\n` +
                `Kamu termasuk yang peduli? → /donasi`,
                { parse_mode: 'Markdown' }
            ).catch(() => {});
        }, 8000);

    } catch (error) {
        console.error(`Error creating email for ${chatId}:`, error.message);
        await _safeEditMessage(chatId, messageId, '❌ *Gagal membuat email!*\n\nSilakan coba beberapa saat lagi.', {
            parse_mode: 'Markdown',
            reply_markup: _backToMenuKeyboard.reply_markup
        });
    }
}

async function handleCheckEmail(chatId, messageId) {
    const latestEmail = await _getLatestEmail(chatId);

    if (!latestEmail) {
        await _safeEditMessage(
            chatId, messageId,
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

    await _safeEditMessage(chatId, messageId, '🔍 Sedang memeriksa email...');

    try {
        const result = await _checkEmails(latestEmail.email, latestEmail.token);
        await _updateLastChecked(latestEmail.id);

        if (Array.isArray(result) && result.length > 0) {
            const messages = result;

            _userInboxCache.set(chatId, {
                emails: messages,
                token: latestEmail.token,
                emailAddress: latestEmail.email
            });

            let messageText = `📬 *${messages.length} Email Masuk*\n\nKlik email untuk membaca isi:\n\n`;

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

            await _safeEditMessage(chatId, messageId, messageText, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: emailButtons }
            });

        } else {
            await _safeEditMessage(
                chatId, messageId,
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
        await _safeEditMessage(
            chatId, messageId,
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
    const emails = await _getUserEmails(chatId);

    if (emails.length === 0) {
        await _safeEditMessage(
            chatId, messageId,
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

    await _safeEditMessage(chatId, messageId, messageText, {
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

    await _safeEditMessage(chatId, messageId, helpMessage, {
        parse_mode: 'Markdown',
        reply_markup: _backToMenuKeyboard.reply_markup
    });
}

async function handleViewEmail(chatId, messageId, emailUuid) {
    await _safeEditMessage(chatId, messageId, '📖 Sedang memuat email...');

    const cached = _userInboxCache.get(chatId);

    if (!cached || !cached.emails) {
        await _safeEditMessage(chatId, messageId, '❌ *Email tidak ditemukan.*\n\nSilakan cek inbox lagi.', {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔍 Cek Inbox', callback_data: 'check_email' }],
                    [{ text: '🏠 Kembali ke Menu', callback_data: 'main_menu' }]
                ]
            }
        });
        return;
    }

    const email = cached.emails.find(e => e.uuid === emailUuid || e.id === emailUuid);

    if (!email) {
        await _safeEditMessage(chatId, messageId, '❌ *Email tidak ditemukan.*\n\nMungkin sudah kadaluarsa.', {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔍 Cek Inbox', callback_data: 'check_email' }],
                    [{ text: '🏠 Kembali ke Menu', callback_data: 'main_menu' }]
                ]
            }
        });
        return;
    }

    try {
        const result = await _getEmailBody(cached.token, email.uuid || email.id, email.email_id);
        const { body, links } = result;

        const sender = email.sender_name || email.sender_email || 'Unknown';
        const senderEmail = email.sender_email || '';
        const subject = email.subject || '(No Subject)';
        const timestamp = email.receive_time || email.rtime;
        const date = timestamp ? new Date(timestamp * 1000).toLocaleString('id-ID') : '-';

        let messageText = `📧 <b>Detail Email</b>\n\n`;
        messageText += `<b>Subject:</b> ${_escapeHtml(subject)}\n`;
        messageText += `<b>Dari:</b> ${_escapeHtml(sender)}\n`;
        if (senderEmail) messageText += `<b>Email:</b> ${_escapeHtml(senderEmail)}\n`;
        messageText += `<b>Waktu:</b> ${date}\n\n`;
        messageText += `━━━━━━━━━━━━━━━━━━\n\n`;

        if (body && body.trim()) {
            const bodyPreview = _escapeHtml(body.substring(0, 3000));
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
                    messageText += `${index + 4}. ${_escapeHtml(link.url)}\n`;
                });
            }
        }

        keyboard.push([{ text: '◀️ Kembali ke Inbox', callback_data: 'back_to_inbox' }]);
        keyboard.push([{ text: '🏠 Menu Utama', callback_data: 'main_menu' }]);

        await _safeEditMessage(chatId, messageId, messageText, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: keyboard }
        });

    } catch (error) {
        console.error('Error viewing email:', error.message);
        await _safeEditMessage(chatId, messageId, '❌ *Gagal memuat email!*\n\nCoba lagi nanti.', {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '◀️ Kembali ke Inbox', callback_data: 'back_to_inbox' }],
                    [{ text: '🏠 Menu Utama', callback_data: 'main_menu' }]
                ]
            }
        });
    }
}

module.exports = {
    init,
    handleNewEmail,
    handleCheckEmail,
    handleListEmails,
    handleHelp,
    handleViewEmail,
};

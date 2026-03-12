'use strict';

const { DONATION_MAX_MINUTES, DONATION_CHECK_INTERVAL } = require('../config');

const RANDOM_MESSAGES = [
    'Semangat terus! Bot-nya keren banget 🔥',
    'Keep it up! Support dari aku ya 💪',
    'Terima kasih sudah buat bot yang berguna 🙏',
    'Jaga terus bot-nya! Semoga makin berkembang ⚡',
    'Bot terbaik! Terus berkarya 🚀',
    'Dari pengguna setia, tetap semangat! 🌟',
    'Bot ini sering banget aku pake, makasih ya! ❤️',
];

let _bot, _safeEditMessage, _saweria, _donationSessions, _activeDonationPollers, _DONATION_NOMINAL_OPTIONS;

function init({ bot, safeEditMessage, saweria, donationSessions, activeDonationPollers, DONATION_NOMINAL_OPTIONS }) {
    _bot = bot;
    _safeEditMessage = safeEditMessage;
    _saweria = saweria;
    _donationSessions = donationSessions;
    _activeDonationPollers = activeDonationPollers;
    _DONATION_NOMINAL_OPTIONS = DONATION_NOMINAL_OPTIONS;
}

async function handleDonasiStart(chatId, messageId) {
    const text =
        `🤫 *Hal Yang Jarang Diketahui Pengguna Bot Ini...*\n\n` +
        `Bot email gratis yang kamu pakai sekarang — yang bantu kamu bypass verifikasi dalam hitungan detik — dijaga oleh *1 orang*.\n\n` +
        `Bukan perusahaan besar.\n` +
        `Bukan tim developer.\n` +
        `*Satu orang.* Yang tiap bulan rogoh kocek sendiri buat bayar server.\n\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `💔 Bot ini sudah dipakai ribuan orang.\n` +
        `Tapi hanya *segelintir* yang pernah bilang _"terima kasih"_.\n\n` +
        `⚡ *Fakta yang bikin kaget:*\n` +
        `Tanpa support → server mati → kamu kehilangan akses email gratis *selamanya*.\n\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `Kamu nggak perlu banyak.\n` +
        `*Secangkir kopi — Rp 5.000 — sudah cukup* buat server ini menyala besok.\n\n` +
        `🙏 Apakah kamu mau jadi salah satu dari sedikit orang\nyang peduli bot ini tetap ada? 👇`;

    await _safeEditMessage(chatId, messageId, text, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '💸 Ya! Aku Mau Support Bot Ini', callback_data: 'donasi_nominal' }],
                [{ text: '🏠 Kembali ke Menu', callback_data: 'main_menu' }],
            ]
        }
    });
}

async function handleDonasiNominal(chatId, messageId) {
    const rows = [];
    const opts = _DONATION_NOMINAL_OPTIONS;
    for (let i = 0; i < opts.length; i += 2) {
        const row = [{ text: opts[i].label, callback_data: `donasi_amount_${opts[i].value}` }];
        if (opts[i + 1]) row.push({ text: opts[i + 1].label, callback_data: `donasi_amount_${opts[i + 1].value}` });
        rows.push(row);
    }
    rows.push([{ text: '✏️ Nominal Sendiri (bebas)', callback_data: 'donasi_custom' }]);
    rows.push([{ text: '🔙 Kembali', callback_data: 'donasi_start' }]);

    await _safeEditMessage(chatId, messageId,
        `💰 *Pilih Nominal Donasi*\n\n` +
        `Untuk: *${_saweria.SAWERIA_USERNAME}* via Saweria\n` +
        `Metode: QRIS (semua e-wallet & m-banking)\n\n` +
        `_Pilih nominal atau masukkan sendiri:_`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } }
    );
}

async function handleDonasiAmountSelected(chatId, messageId, amount, fromUser) {
    const name    = fromUser?.first_name || fromUser?.username || 'Donatur';
    const email   = `${fromUser?.id || chatId}@gmail.com`;
    const message = RANDOM_MESSAGES[Math.floor(Math.random() * RANDOM_MESSAGES.length)];

    _donationSessions.set(chatId, { step: 'confirm', amount, name, email, message });

    await _safeEditMessage(chatId, messageId,
        `🧾 *Konfirmasi Donasi*\n\n` +
        `💰 Nominal: *${_saweria.formatRupiah(amount)}*\n` +
        `👤 Nama: *${name}*\n` +
        `📧 Email: \`${email}\`\n` +
        `💬 Pesan: _${message}_\n\n` +
        `Lanjut ke pembayaran?`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '✅ Ya, Proses Pembayaran!', callback_data: 'donasi_confirm' }],
                    [{ text: '🔙 Ganti Nominal', callback_data: 'donasi_nominal' }],
                    [{ text: '🏠 Menu Utama', callback_data: 'main_menu' }],
                ]
            }
        }
    );
}

async function handleDonasiCancelPayment(chatId, messageId, donationId) {
    if (_activeDonationPollers.has(donationId)) {
        clearInterval(_activeDonationPollers.get(donationId));
        _activeDonationPollers.delete(donationId);
    }
    _saweria.deleteQRFile(donationId);
    await _safeEditMessage(chatId, messageId,
        `❌ *Pembayaran Dibatalkan*\n\nKamu bisa donasi lagi kapan saja. Bot ini masih menunggumu! 🙏`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '💝 Donasi Lagi', callback_data: 'donasi_start' }],
                    [{ text: '🏠 Menu Utama', callback_data: 'main_menu' }],
                ]
            }
        }
    );
}

async function handleDonasiTextInput(chatId, userId, text, session) {
    if (session.step === 'custom_amount') {
        const amount = parseInt(text.replace(/\D/g, ''));
        if (isNaN(amount) || amount < 1000) {
            return _bot.sendMessage(chatId, '⚠️ Nominal tidak valid. Min Rp 1.000 (angka saja).');
        }

        const fromUser = session.fromUser || { id: userId };
        const name    = fromUser.first_name || fromUser.username || 'Donatur';
        const email   = `${fromUser.id || userId}@gmail.com`;
        const message = RANDOM_MESSAGES[Math.floor(Math.random() * RANDOM_MESSAGES.length)];

        _donationSessions.set(chatId, { step: 'confirm', amount, name, email, message });

        return _bot.sendMessage(chatId,
            `🧾 *Konfirmasi Donasi*\n\n` +
            `💰 Nominal: *${_saweria.formatRupiah(amount)}*\n` +
            `👤 Nama: *${name}*\n` +
            `📧 Email: \`${email}\`\n` +
            `💬 Pesan: _${message}_\n\n` +
            `Lanjut ke pembayaran?`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '✅ Ya, Proses Pembayaran!', callback_data: 'donasi_confirm' }],
                        [{ text: '🔙 Ganti Nominal', callback_data: 'donasi_nominal' }],
                    ]
                }
            }
        );
    }
}

async function processDonasiPayment(chatId, amount, name, email, message) {
    _donationSessions.delete(chatId);
    const processingMsg = await _bot.sendMessage(chatId,
        `⏳ *Memproses donasi...*\n💰 ${_saweria.formatRupiah(amount)} untuk *${_saweria.SAWERIA_USERNAME}*`,
        { parse_mode: 'Markdown' }
    );

    try {
        await _saweria.checkEligible(amount);
        const calcData = await _saweria.calculateAmount(amount, email, name, message);
        const { amount_to_pay, pg_fee, platform_fee } = calcData.data;

        const donationData = await _saweria.createDonation(amount, email, name, message, amount_to_pay, pg_fee, platform_fee);
        const donation = donationData.data;
        const qrPath = await _saweria.generateQRImage(donation.qr_string, donation.id);

        await _bot.deleteMessage(chatId, processingMsg.message_id).catch(() => {});

        await _bot.sendPhoto(chatId, { source: qrPath }, {
            caption:
                `🧾 *Detail Donasi*\n\n` +
                `👤 Nama: *${name}*\n` +
                `💰 Nominal: ${_saweria.formatRupiah(amount)}\n` +
                `💳 Biaya PG: ${_saweria.formatRupiah(pg_fee)}\n` +
                `💵 *Total Bayar: ${_saweria.formatRupiah(amount_to_pay)}*\n` +
                (message ? `💬 Pesan: _${message}_\n` : '') +
                `\n📱 *Scan QR pakai e-wallet / m-banking*\n` +
                `⏰ Berlaku ${DONATION_MAX_MINUTES} menit`,
            parse_mode: 'Markdown',
        });

        const statusMsg = await _bot.sendMessage(chatId,
            `⏳ *Menunggu Pembayaran...*\n\n` +
            `🆔 ID: \`${donation.id}\`\n` +
            `⏱ Sisa waktu: *${DONATION_MAX_MINUTES}:00*\n\n` +
            `_Otomatis update setelah bayar_`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '❌ Batalkan', callback_data: `donasi_cancel_${donation.id}` }]]
                }
            }
        );

        startDonationPolling(chatId, statusMsg.message_id, donation.id, amount_to_pay);

    } catch (err) {
        console.error('❌ [Donasi] Error:', err.message);

        const isCloudflare = err.message === 'CLOUDFLARE_BLOCK' ||
            (typeof err?.response?.data === 'string' && err.response.data.includes('Cloudflare'));

        const userMsg = isCloudflare
            ? `⚠️ *Server donasi sedang tidak bisa diakses*\n\nSaweria memblokir koneksi dari server bot ini sementara.\n\nCoba beberapa menit lagi atau kunjungi langsung:\n👉 saweria.co/${_saweria.SAWERIA_USERNAME}`
            : `❌ *Gagal membuat donasi*\n\n${err?.response?.data?.message || err.message}`;

        await _bot.editMessageText(userMsg, {
            chat_id: chatId,
            message_id: processingMsg.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔄 Coba Lagi', callback_data: 'donasi_start' }],
                    [{ text: '🏠 Menu Utama', callback_data: 'main_menu' }],
                ]
            }
        });
    }
}

function startDonationPolling(chatId, statusMsgId, donationId, amountToPay) {
    const totalSeconds = DONATION_MAX_MINUTES * 60;
    let attempts       = 0;
    let lastMinute     = DONATION_MAX_MINUTES;

    const interval = setInterval(async () => {
        attempts++;
        const secondsElapsed = attempts * (DONATION_CHECK_INTERVAL / 1000);
        const secondsLeft    = Math.max(0, totalSeconds - secondsElapsed);

        const result = await _saweria.checkPaymentStatus(donationId);
        const status = result?.status || '';

        if (['SUCCESS', 'SETTLEMENT', 'PAID'].includes(status)) {
            clearInterval(interval);
            _activeDonationPollers.delete(donationId);
            _saweria.deleteQRFile(donationId);
            await _bot.editMessageText(
                `✅ *Pembayaran Berhasil! Kamu Luar Biasa!* 🎉\n\n` +
                `💰 ${_saweria.formatRupiah(amountToPay)}\n` +
                `🙏 Terima kasih sudah jaga bot ini tetap hidup!\n` +
                `Karena kamu, ribuan pengguna lain masih bisa menikmati email gratis.\n\n` +
                `_ID:_ \`${donationId}\``,
                {
                    chat_id: chatId,
                    message_id: statusMsgId,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '💝 Donasi Lagi', callback_data: 'donasi_start' }],
                            [{ text: '🏠 Menu Utama', callback_data: 'main_menu' }],
                        ]
                    }
                }
            ).catch(() => {});
            return;
        }

        if (['FAILED', 'EXPIRED', 'CANCEL', 'FAILURE', 'DENY'].includes(status)) {
            clearInterval(interval);
            _activeDonationPollers.delete(donationId);
            _saweria.deleteQRFile(donationId);
            await _bot.editMessageText(
                `❌ *Pembayaran Gagal/Dibatalkan*\n\nNggak apa-apa. Kamu bisa coba lagi kapan saja. 🙏`,
                {
                    chat_id: chatId,
                    message_id: statusMsgId,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '💝 Donasi Lagi', callback_data: 'donasi_start' }],
                            [{ text: '🏠 Menu Utama', callback_data: 'main_menu' }],
                        ]
                    }
                }
            ).catch(() => {});
            return;
        }

        if (secondsLeft <= 0) {
            clearInterval(interval);
            _activeDonationPollers.delete(donationId);
            _saweria.deleteQRFile(donationId);
            await _bot.editMessageText(
                `⏰ *Waktu Habis*\n\nQR sudah tidak valid (${DONATION_MAX_MINUTES} menit berlalu).\nBuat donasi baru ya!`,
                {
                    chat_id: chatId,
                    message_id: statusMsgId,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '💝 Donasi Lagi', callback_data: 'donasi_start' }],
                            [{ text: '🏠 Menu Utama', callback_data: 'main_menu' }],
                        ]
                    }
                }
            ).catch(() => {});
            return;
        }

        const currentMinute = Math.floor(secondsLeft / 60);
        if (currentMinute < lastMinute) {
            lastMinute = currentMinute;
            await _bot.editMessageText(
                `⏳ *Menunggu Pembayaran...*\n\n` +
                `🆔 ID: \`${donationId}\`\n` +
                `⏱ Sisa waktu: *${_saweria.formatCountdown(Math.floor(secondsLeft))}*\n\n` +
                `_Otomatis update setelah bayar_`,
                {
                    chat_id: chatId,
                    message_id: statusMsgId,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[{ text: '❌ Batalkan', callback_data: `donasi_cancel_${donationId}` }]]
                    }
                }
            ).catch(() => {});
        }
    }, DONATION_CHECK_INTERVAL);

    _activeDonationPollers.set(donationId, interval);
}

module.exports = {
    init,
    handleDonasiStart,
    handleDonasiNominal,
    handleDonasiAmountSelected,
    handleDonasiCancelPayment,
    handleDonasiTextInput,
    processDonasiPayment,
    startDonationPolling,
};

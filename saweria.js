// saweria.js - Modul integrasi Saweria QRIS untuk bot TempMail
const axios = require('axios');
const https = require('https');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

const SAWERIA_USERNAME = process.env.SAWERIA_USERNAME;
const SAWERIA_USER_ID  = process.env.SAWERIA_USER_ID;
const SAWERIA_API      = 'https://backend.saweria.co';
const SAWERIA_HEADERS  = {
    'Content-Type': 'application/json',
    'Origin': 'https://saweria.co',
};

const keepAliveAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 10000,
    maxSockets: 10,
    timeout: 30000,
});

const axiosInstance = axios.create({
    timeout: 30000,
    httpsAgent: keepAliveAgent,
});

async function withRetry(fn, retries = 3, delayMs = 2000) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (err) {
            if (i === retries - 1) throw err;
            const wait = delayMs * Math.pow(2, i);
            console.log(`⚠️ [Saweria] Retry ${i + 1}/${retries} setelah ${wait}ms... (${err.message})`);
            await new Promise(r => setTimeout(r, wait));
        }
    }
}

let _buildId = null;
let _buildIdFetching = false;

async function getSaweriaBuildId() {
    if (_buildId) return _buildId;
    if (_buildIdFetching) {
        await new Promise(r => setTimeout(r, 500));
        return _buildId;
    }
    _buildIdFetching = true;
    try {
        const res = await axiosInstance.get(`https://saweria.co/${SAWERIA_USERNAME}`, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        const match = res.data.match(/"buildId"\s*:\s*"([^"]+)"/);
        if (match) {
            _buildId = match[1];
            console.log('✅ [Saweria] Build ID:', _buildId);
        }
    } catch (e) {
        console.error('[Saweria] Gagal ambil build ID:', e.message);
    } finally {
        _buildIdFetching = false;
    }
    return _buildId;
}

function buildDonationPayload(amount, email, name, message) {
    return {
        agree: true,
        notUnderage: true,
        message: message || '-',
        amount,
        payment_type: 'qris',
        vote: '',
        giphy: null,
        yt: '',
        ytStart: 0,
        mediaType: null,
        image_guess: null,
        image_guess_answer: '',
        amountToPay: '',
        currency: 'IDR',
        pgFee: '',
        platformFee: '',
        customer_info: {
            first_name: name || email,
            email: email,
            phone: '',
        },
    };
}

async function checkEligible(amount) {
    return withRetry(async () => {
        const res = await axiosInstance.post(
            `${SAWERIA_API}/reward/check-eligible/${SAWERIA_USERNAME}`,
            {
                agree: false, notUnderage: false,
                amount, payment_type: '', currency: 'IDR',
                message: '', vote: '', giphy: null,
                yt: '', ytStart: 0, mediaType: null,
                image_guess: null, image_guess_answer: '',
                amountToPay: '', pgFee: '', platformFee: '',
                customer_info: { first_name: '', email: '', phone: '' },
            },
            { headers: SAWERIA_HEADERS }
        );
        return res.data;
    });
}

async function calculateAmount(amount, email, name, message) {
    return withRetry(async () => {
        const res = await axiosInstance.post(
            `${SAWERIA_API}/donations/${SAWERIA_USERNAME}/calculate_pg_amount`,
            buildDonationPayload(amount, email, name, message),
            { headers: SAWERIA_HEADERS }
        );
        return res.data;
    });
}

async function createDonation(amount, email, name, message, amountToPay, pgFee, platformFee) {
    return withRetry(async () => {
        const payload = {
            ...buildDonationPayload(amount, email, name, message),
            amountToPay: String(amountToPay),
            pgFee: String(pgFee),
            platformFee: String(platformFee ?? 0),
        };
        const res = await axiosInstance.post(
            `${SAWERIA_API}/donations/snap/${SAWERIA_USER_ID}`,
            payload,
            { headers: SAWERIA_HEADERS }
        );
        return res.data;
    });
}

async function checkPaymentStatus(donationId) {
    try {
        const buildId = await getSaweriaBuildId();
        if (buildId) {
            const res = await axiosInstance.get(
                `https://saweria.co/_next/data/${buildId}/id/qris/snap/${donationId}.json`,
                { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://saweria.co/' } }
            );
            const d = res.data?.pageProps?.data;
            if (d) {
                return {
                    id: d.id,
                    status: (d.transaction_status || '').toUpperCase(),
                    amount: d.amount_raw,
                };
            }
        }
    } catch (e) {
        if (e.response?.status === 404) {
            _buildId = null;
        }
    }
    try {
        const res = await axiosInstance.get(`${SAWERIA_API}/donations/${donationId}`, {
            headers: SAWERIA_HEADERS,
        });
        const d = res.data?.data;
        if (d) {
            return {
                id: d.id,
                status: (d.status || '').toUpperCase(),
                amount: d.amount,
            };
        }
    } catch (e) {
        return null;
    }
    return null;
}

async function generateQRImage(qrString, donationId) {
    const filePath = path.join('/tmp', `qr_${donationId}.png`);
    await QRCode.toFile(filePath, qrString, {
        width: 500,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
    });
    return filePath;
}

function deleteQRFile(donationId) {
    const qrFile = path.join('/tmp', `qr_${donationId}.png`);
    try {
        if (fs.existsSync(qrFile)) fs.unlinkSync(qrFile);
    } catch (_) {}
}

function formatRupiah(amount) {
    return new Intl.NumberFormat('id-ID', {
        style: 'currency',
        currency: 'IDR',
        minimumFractionDigits: 0,
    }).format(amount);
}

function formatCountdown(secondsLeft) {
    const m = Math.floor(secondsLeft / 60);
    const s = secondsLeft % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

module.exports = {
    checkEligible,
    calculateAmount,
    createDonation,
    checkPaymentStatus,
    generateQRImage,
    deleteQRFile,
    formatRupiah,
    formatCountdown,
    SAWERIA_USERNAME,
};

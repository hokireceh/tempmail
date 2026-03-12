# 📖 Dokumentasi Integrasi Saweria Payment — Telegram Bot

> **Versi:** 1.0.0  
> **Dibuat:** 2026  
> **Stack:** Node.js + Telegraf v4 + Saweria API  
> **Tujuan:** Panduan lengkap mengintegrasikan pembayaran QRIS Saweria ke bot Telegram manapun

---

## 📋 Daftar Isi

1. [Cara Kerja Sistem](#1-cara-kerja-sistem)
2. [Saweria API — Endpoint & Request](#2-saweria-api--endpoint--request)
3. [Struktur Response](#3-struktur-response)
4. [Cara Dapat Saweria User ID](#4-cara-dapat-saweria-user-id)
5. [Network Fixes — Wajib untuk Indonesia](#5-network-fixes--wajib-untuk-indonesia)
6. [Template Fungsi Siap Pakai](#6-template-fungsi-siap-pakai)
7. [Polling Status Pembayaran](#7-polling-status-pembayaran)
8. [Generate QR Code dari QR String](#8-generate-qr-code-dari-qr-string)
9. [Flow Lengkap — Dari Klik ke Pembayaran](#9-flow-lengkap--dari-klik-ke-pembayaran)
10. [Konfigurasi .env](#10-konfigurasi-env)
11. [Error Handling](#11-error-handling)
12. [Checklist Deploy](#12-checklist-deploy)

---

## 1. Cara Kerja Sistem

```
User Telegram
    │
    ▼
Bot Telegram (Telegraf)
    │
    ├─► [1] POST /reward/check-eligible/{username}   → Cek kelayakan donasi
    │
    ├─► [2] POST /donations/{username}/calculate_pg_amount  → Hitung biaya PG
    │
    ├─► [3] POST /donations/snap/{user_id}           → Buat transaksi, dapat QR string
    │
    ├─► Generate QR image dari qr_string
    │
    ├─► Kirim QR image ke user via Telegram
    │
    └─► Loop polling status tiap N detik
            │
            ├─ "Pending"  → lanjut tunggu
            ├─ "Success"  → kirim notif sukses ✅
            ├─ "Failed"   → kirim notif gagal ❌
            └─ timeout    → kirim notif expired ⏰
```

---

## 2. Saweria API — Endpoint & Request

### Base URL
```
https://backend.saweria.co
```

### Header Wajib (semua request)
```javascript
{
  "Content-Type": "application/json",
  "Origin": "https://saweria.co"
}
```
> ⚠️ **Tanpa header Origin, request akan ditolak CORS.**

---

### Endpoint 1 — Cek Kelayakan
```
POST /reward/check-eligible/{SAWERIA_USERNAME}
```

**Request Body:**
```json
{
  "agree": false,
  "notUnderage": false,
  "message": "",
  "amount": 35000,
  "payment_type": "",
  "vote": "",
  "giphy": null,
  "yt": "",
  "ytStart": 0,
  "mediaType": null,
  "image_guess": null,
  "image_guess_answer": "",
  "amountToPay": "",
  "currency": "IDR",
  "pgFee": "",
  "platformFee": "",
  "customer_info": {
    "first_name": "",
    "email": "",
    "phone": ""
  }
}
```

**Response:**
```json
{ "data": { "is_eligible": false } }
```

> 📝 **Catatan:** `agree` dan `notUnderage` diisi `false` di step ini (hanya cek eligibility).

---

### Endpoint 2 — Hitung Biaya Payment Gateway
```
POST /donations/{SAWERIA_USERNAME}/calculate_pg_amount
```

**Request Body:** (sama seperti endpoint 1, tapi `agree: true`, `notUnderage: true`, dan `payment_type` diisi)
```json
{
  "agree": true,
  "notUnderage": true,
  "message": "Pesan dari user",
  "amount": 35000,
  "payment_type": "qris",
  "vote": "",
  "giphy": null,
  "yt": "",
  "ytStart": 0,
  "mediaType": null,
  "image_guess": null,
  "image_guess_answer": "",
  "amountToPay": "",
  "currency": "IDR",
  "pgFee": "",
  "platformFee": "",
  "customer_info": {
    "first_name": "Nama User",
    "email": "email@user.com",
    "phone": ""
  }
}
```

**Response:**
```json
{
  "data": {
    "amount_to_pay": 35248,
    "pg_fee": 248,
    "platform_fee": 0
  }
}
```

| Field | Keterangan |
|-------|-----------|
| `amount_to_pay` | Total yang harus dibayar user (sudah termasuk biaya PG) |
| `pg_fee` | Biaya payment gateway |
| `platform_fee` | Biaya platform (biasanya 0 untuk QRIS) |

---

### Endpoint 3 — Buat Transaksi (Dapat QR)
```
POST /donations/snap/{SAWERIA_USER_ID}
```

> ⚠️ **Perhatian:** Path ini menggunakan **User ID** (UUID), **bukan username**.  
> Contoh: `/donations/snap/d8e876df-405c-4e08-9708-9808b9037ea5`

**Request Body:**
```json
{
  "agree": true,
  "notUnderage": true,
  "message": "Pesan dari user",
  "amount": 35000,
  "payment_type": "qris",
  "vote": "",
  "currency": "IDR",
  "customer_info": {
    "first_name": "Nama User",
    "email": "email@user.com",
    "phone": ""
  }
}
```

**Response (201 Created):**
```json
{
  "data": {
    "id": "08e1e8c5-7c85-445d-9b7b-085241d8b27c",
    "amount": 35248,
    "amount_raw": 35248,
    "created_at": "Wed, 11 Mar 2026 21:32:18 GMT",
    "currency": "IDR",
    "donator": {
      "email": "email@user.com",
      "first_name": "Nama User",
      "phone": null
    },
    "message": "Pesan dari user",
    "payment_type": "qris",
    "qr_string": "00020101021226650013CO.XENDIT.WWW...",
    "status": "PENDING",
    "type": "donation",
    "user_id": "d8e876df-405c-4e08-9708-9808b9037ea5"
  }
}
```

| Field | Keterangan |
|-------|-----------|
| `id` | ID unik transaksi — simpan ini untuk polling status |
| `qr_string` | String QRIS standar — convert ke gambar QR |
| `status` | Status awal selalu `"PENDING"` |

---

### Endpoint 4 — Cek Status Transaksi

**Cara Utama** (Frontend Saweria — lebih akurat):
```
GET https://saweria.co/_next/data/{BUILD_ID}/id/qris/snap/{DONATION_ID}.json
```

**Cara Fallback** (Backend API):
```
GET https://backend.saweria.co/donations/{DONATION_ID}
```

**Response status dari frontend:**
```json
{
  "pageProps": {
    "data": {
      "id": "08e1e8c5-...",
      "transaction_status": "Pending",
      "amount_raw": 35248,
      "qr_string": "...",
      "username": "zahwafe"
    }
  }
}
```

### Nilai `transaction_status` yang Mungkin

| Status | Arti | Aksi Bot |
|--------|------|----------|
| `Pending` | Menunggu pembayaran | Lanjut polling |
| `Success` | Pembayaran berhasil ✅ | Kirim notif sukses |
| `Failed` | Pembayaran gagal ❌ | Kirim notif gagal |
| `Expired` | QR kedaluwarsa ⏰ | Kirim notif expired |
| `Cancel` | Dibatalkan | Kirim notif batal |

> ⚠️ **Penting:** Status bisa huruf besar, kecil, atau campur (`"PENDING"`, `"Pending"`, `"pending"`).  
> Selalu normalize dengan `.toUpperCase()` sebelum dibandingkan.

---

## 3. Struktur Response

### Payload Donasi — Builder Function
```javascript
function buildDonationPayload(amount, email, name, message) {
  return {
    agree: true,
    notUnderage: true,
    message: message || "-",
    amount,                    // integer, dalam Rupiah
    payment_type: "qris",      // selalu "qris" untuk QRIS
    vote: "",
    giphy: null,
    yt: "",
    ytStart: 0,
    mediaType: null,
    image_guess: null,
    image_guess_answer: "",
    amountToPay: "",           // biarkan kosong, akan dihitung server
    currency: "IDR",
    pgFee: "",                 // biarkan kosong
    platformFee: "",           // biarkan kosong
    customer_info: {
      first_name: name || email,
      email: email,
      phone: "",
    },
  };
}
```

---

## 4. Cara Dapat Saweria User ID

User ID Saweria berbeda dengan username. Ini cara mendapatkannya:

**Cara 1 — DevTools (paling mudah):**
1. Buka `https://saweria.co/{username}` di browser
2. Tekan `F12` → tab **Network**
3. Refresh halaman, lalu cari request ke `backend.saweria.co`
4. Lihat path request: `/donations/snap/XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX`
5. UUID panjang itu adalah **User ID** kamu

**Cara 2 — Dari response transaksi:**
Field `user_id` di response endpoint 3 berisi User ID pemilik akun.

---

## 5. Network Fixes — Wajib untuk Indonesia

ISP Indonesia sering memblokir IPv6 dan koneksi ke `api.telegram.org`. Tambahkan ini di **paling atas** file bot kamu:

```javascript
require("dotenv").config();

// ✅ Fix 1: Force IPv4 — hindari IPv6 timeout
const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

const https = require("https");
const axios = require("axios");

// ✅ Fix 2: Keep-Alive HTTPS Agent — jaga koneksi tetap aktif
const keepAliveAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 10000,
  maxSockets: 10,
  timeout: 30000,
});

// ✅ Fix 3: Axios instance dengan timeout 30 detik
const axiosInstance = axios.create({
  timeout: 30000,
  httpsAgent: keepAliveAgent,
});

// ✅ Fix 4: Retry logic — exponential backoff (2s → 4s → 8s)
async function withRetry(fn, retries = 3, delayMs = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) throw err;
      const wait = delayMs * Math.pow(2, i);
      console.log(`⚠️ Retry ${i + 1}/${retries - 1} setelah ${wait}ms...`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

// ✅ Fix 5: Telegraf dengan Keep-Alive agent + proper polling
const { Telegraf } = require("telegraf");
const bot = new Telegraf(process.env.BOT_TOKEN, {
  telegram: {
    agent: keepAliveAgent,
    apiRoot: "https://api.telegram.org",
  },
});

// ✅ Fix 6: Launch dengan proper polling config
bot.launch({
  polling: {
    timeout: 30,    // long polling 30 detik
    limit: 100,     // max 100 update per request
  },
});
```

---

## 6. Template Fungsi Siap Pakai

Copy-paste langsung ke bot kamu. Ganti variabel config sesuai kebutuhan.

```javascript
// ============================================================
// SAWERIA PAYMENT MODULE — Copy ini ke bot kamu
// ============================================================

const SAWERIA_USERNAME = process.env.SAWERIA_USERNAME;
const SAWERIA_USER_ID  = process.env.SAWERIA_USER_ID;
const SAWERIA_API      = "https://backend.saweria.co";
const SAWERIA_HEADERS  = {
  "Content-Type": "application/json",
  "Origin": "https://saweria.co",
};

// --- 1. Cek Kelayakan ---
async function saweria_checkEligible(amount) {
  return withRetry(async () => {
    const res = await axiosInstance.post(
      `${SAWERIA_API}/reward/check-eligible/${SAWERIA_USERNAME}`,
      {
        agree: false, notUnderage: false,
        amount, payment_type: "", currency: "IDR",
        message: "", vote: "", giphy: null,
        yt: "", ytStart: 0, mediaType: null,
        image_guess: null, image_guess_answer: "",
        amountToPay: "", pgFee: "", platformFee: "",
        customer_info: { first_name: "", email: "", phone: "" },
      },
      { headers: SAWERIA_HEADERS }
    );
    return res.data;
  });
}

// --- 2. Hitung Biaya PG ---
async function saweria_calculateFee(amount, email, name, message) {
  return withRetry(async () => {
    const res = await axiosInstance.post(
      `${SAWERIA_API}/donations/${SAWERIA_USERNAME}/calculate_pg_amount`,
      buildDonationPayload(amount, email, name, message),
      { headers: SAWERIA_HEADERS }
    );
    return res.data; // { amount_to_pay, pg_fee, platform_fee }
  });
}

// --- 3. Buat Transaksi & Dapat QR ---
async function saweria_createTransaction(amount, email, name, message) {
  return withRetry(async () => {
    const res = await axiosInstance.post(
      `${SAWERIA_API}/donations/snap/${SAWERIA_USER_ID}`,
      buildDonationPayload(amount, email, name, message),
      { headers: SAWERIA_HEADERS }
    );
    return res.data; // { id, qr_string, status, amount, ... }
  });
}

// --- 4. Cache Build ID Saweria (untuk polling status) ---
let _buildId = null;
async function saweria_getBuildId() {
  if (_buildId) return _buildId;
  try {
    const res = await axiosInstance.get(
      `https://saweria.co/${SAWERIA_USERNAME}`,
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    const match = res.data.match(/"buildId"\s*:\s*"([^"]+)"/);
    if (match) _buildId = match[1];
  } catch (e) {
    console.error("Gagal ambil buildId:", e.message);
  }
  return _buildId;
}

// --- 5. Cek Status Transaksi ---
async function saweria_checkStatus(donationId) {
  // Coba frontend endpoint (lebih akurat)
  try {
    const buildId = await saweria_getBuildId();
    if (buildId) {
      const res = await axiosInstance.get(
        `https://saweria.co/_next/data/${buildId}/id/qris/snap/${donationId}.json`,
        { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://saweria.co/" } }
      );
      const d = res.data?.pageProps?.data;
      if (d) return { id: d.id, status: d.transaction_status, amount: d.amount_raw };
    }
  } catch (e) {
    if (e.response?.status === 404) _buildId = null; // reset cache jika expired
  }

  // Fallback: backend API
  try {
    const res = await axiosInstance.get(
      `${SAWERIA_API}/donations/${donationId}`,
      { headers: SAWERIA_HEADERS }
    );
    const d = res.data?.data;
    return { id: d.id, status: d.status, amount: d.amount };
  } catch (e) {
    return null;
  }
}
// ============================================================
```

---

## 7. Polling Status Pembayaran

### Konfigurasi yang Direkomendasikan

```javascript
const CHECK_INTERVAL_MS = 7000;   // Cek tiap 7 detik
const MAX_WAIT_MINUTES  = 15;     // Maksimal tunggu 15 menit
// = ~128 kali pengecekan total
```

> ⚠️ **Jangan terlalu cepat polling** (< 5 detik) — bisa kena rate limit Saweria.

### Template Polling Function

```javascript
const activePollers = {}; // Simpan interval ID agar bisa dibatalkan

async function startPolling(ctx, donationId, chatId, msgId, amountToPay) {
  const totalSeconds  = MAX_WAIT_MINUTES * 60;
  let   attempts      = 0;
  let   lastMinute    = MAX_WAIT_MINUTES;

  const interval = setInterval(async () => {
    attempts++;
    const secondsLeft = Math.max(0, totalSeconds - attempts * (CHECK_INTERVAL_MS / 1000));
    const result      = await saweria_checkStatus(donationId);

    if (!result) return; // skip jika request gagal, coba lagi berikutnya

    const status = (result.status || "").toUpperCase();

    // ✅ Sukses
    if (["SUCCESS", "SETTLEMENT", "PAID"].includes(status)) {
      clearInterval(interval);
      delete activePollers[donationId];
      await ctx.telegram.editMessageText(
        chatId, msgId, null,
        `✅ Pembayaran berhasil!\n💰 ${formatRupiah(amountToPay)}`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    // ❌ Gagal/Batal
    if (["FAILED", "EXPIRED", "CANCEL", "FAILURE", "DENY"].includes(status)) {
      clearInterval(interval);
      delete activePollers[donationId];
      await ctx.telegram.editMessageText(
        chatId, msgId, null,
        `❌ Pembayaran gagal/dibatalkan.`
      );
      return;
    }

    // ⏰ Timeout
    if (secondsLeft <= 0) {
      clearInterval(interval);
      delete activePollers[donationId];
      await ctx.telegram.editMessageText(
        chatId, msgId, null,
        `⏰ Waktu habis (${MAX_WAIT_MINUTES} menit).`
      );
      return;
    }

    // ⏳ Update countdown tiap menit
    const currentMinute = Math.floor(secondsLeft / 60);
    if (currentMinute < lastMinute) {
      lastMinute = currentMinute;
      const mm = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
      const ss = String(Math.floor(secondsLeft % 60)).padStart(2, "0");
      try {
        await ctx.telegram.editMessageText(
          chatId, msgId, null,
          `⏳ Menunggu pembayaran...\nSisa waktu: ${mm}:${ss}`,
          { parse_mode: "Markdown" }
        );
      } catch (_) {} // abaikan error edit (pesan mungkin sudah dihapus)
    }

  }, CHECK_INTERVAL_MS);

  activePollers[donationId] = interval;
  return interval;
}

// Batalkan polling secara manual
function stopPolling(donationId) {
  if (activePollers[donationId]) {
    clearInterval(activePollers[donationId]);
    delete activePollers[donationId];
  }
}
```

---

## 8. Generate QR Code dari QR String

### Install
```bash
npm install qrcode
```

### Fungsi Generate
```javascript
const QRCode = require("qrcode");
const path   = require("path");

async function generateQR(qrString, donationId) {
  const filePath = path.join("/tmp", `qr_${donationId}.png`);
  await QRCode.toFile(filePath, qrString, {
    width:  500,          // ukuran gambar px
    margin: 2,            // margin tepi
    color: {
      dark:  "#000000",   // warna kotak QR
      light: "#ffffff",   // warna latar
    },
  });
  return filePath;
}

// Cara kirim via Telegram:
const qrPath = await generateQR(donation.qr_string, donation.id);
await ctx.replyWithPhoto(
  { source: qrPath },
  { caption: "Scan QR ini untuk membayar", parse_mode: "Markdown" }
);

// Hapus file setelah selesai (opsional, hemat disk)
const fs = require("fs");
if (fs.existsSync(qrPath)) fs.unlinkSync(qrPath);
```

---

## 9. Flow Lengkap — Dari Klik ke Pembayaran

```javascript
async function handleDonasiFlow(ctx, amount, email, name, message) {
  const chatId = ctx.chat.id;

  // Tampilkan loading
  const loadingMsg = await ctx.reply("⏳ Memproses...");

  try {
    // Step 1: Cek eligible
    await saweria_checkEligible(amount);

    // Step 2: Hitung biaya
    const feeData = await saweria_calculateFee(amount, email, name, message);
    const { amount_to_pay, pg_fee } = feeData.data;

    // Step 3: Buat transaksi
    const txData   = await saweria_createTransaction(amount, email, name, message);
    const donation = txData.data;

    // Step 4: Generate QR
    const qrPath   = await generateQR(donation.qr_string, donation.id);

    // Hapus loading
    await ctx.telegram.deleteMessage(chatId, loadingMsg.message_id);

    // Step 5: Kirim QR ke user
    await ctx.replyWithPhoto(
      { source: qrPath },
      {
        caption:
          `🧾 *Detail Pembayaran*\n\n` +
          `💰 Nominal: ${formatRupiah(amount)}\n` +
          `💳 Biaya PG: ${formatRupiah(pg_fee)}\n` +
          `💵 *Total: ${formatRupiah(amount_to_pay)}*\n\n` +
          `📱 Scan QR di atas\n⏰ Berlaku ${MAX_WAIT_MINUTES} menit`,
        parse_mode: "Markdown",
      }
    );

    // Step 6: Kirim pesan status
    const statusMsg = await ctx.reply(
      `⏳ Menunggu pembayaran...\nSisa waktu: ${MAX_WAIT_MINUTES}:00`
    );

    // Step 7: Mulai polling
    await startPolling(ctx, donation.id, chatId, statusMsg.message_id, amount_to_pay);

  } catch (err) {
    console.error("Donasi error:", err?.response?.data || err.message);
    await ctx.telegram.editMessageText(
      chatId, loadingMsg.message_id, null,
      `❌ Gagal: ${err?.response?.data?.message || err.message}`
    );
  }
}
```

---

## 10. Konfigurasi .env

```env
# === TELEGRAM ===
BOT_TOKEN=1234567890:AABBccDDeeFFggHHiiJJkkLLmmNNoo

# === SAWERIA ===
# Username Saweria (tanpa @, tanpa saweria.co/)
SAWERIA_USERNAME=username_kamu

# User ID Saweria (UUID panjang)
# Cara dapat: DevTools → Network → cari path /donations/snap/XXXX
SAWERIA_USER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# === OPSIONAL ===
# Proxy HTTPS jika koneksi ke Telegram diblokir ISP
# HTTPS_PROXY=http://127.0.0.1:7890
```

---

## 11. Error Handling

### Error Umum & Solusinya

| Error | Penyebab | Solusi |
|-------|----------|--------|
| `ETIMEDOUT` saat connect ke `api.telegram.org` | ISP blokir akses Telegram | Tambahkan proxy di `.env`, atau aktifkan VPN |
| `404` di endpoint status | Build ID Next.js Saweria expired setelah deploy baru | Reset cache: `_buildId = null` (sudah otomatis di kode) |
| `400 Bad Request` dari Saweria | Payload salah format atau field kosong | Pastikan semua field required terisi |
| `is_eligible: false` | Saweria streamer menonaktifkan donasi | Cek status akun Saweria |
| `FetchError` / `socket hang up` | Koneksi unstable | Sudah ditangani retry 3x otomatis |

### Pattern Error Handling yang Baik
```javascript
try {
  const result = await saweria_createTransaction(...);
  // proses hasil
} catch (err) {
  const msg = err?.response?.data?.message  // pesan error dari Saweria API
           || err?.response?.data?.error
           || err.message                    // error koneksi
           || "Terjadi kesalahan";

  const code = err?.response?.status;       // HTTP status code

  if (code === 429) {
    // Rate limited — tunggu sebelum retry
  } else if (code >= 500) {
    // Server error Saweria — coba lagi nanti
  } else {
    // Client error — tampilkan ke user
  }
  
  await ctx.reply(`❌ ${msg}`);
}
```

---

## 12. Checklist Deploy

Sebelum deploy ke production, pastikan semua ini sudah:

### Setup
- [ ] File `.env` sudah dibuat dan diisi semua variabel
- [ ] `BOT_TOKEN` valid (test: `https://api.telegram.org/bot{TOKEN}/getMe`)
- [ ] `SAWERIA_USER_ID` sudah benar (UUID format)
- [ ] `npm install` sudah dijalankan
- [ ] Semua dependencies terinstall: `telegraf`, `axios`, `qrcode`, `dotenv`

### Network
- [ ] `dns.setDefaultResultOrder("ipv4first")` ada di paling atas file
- [ ] Keep-Alive agent dipakai untuk Telegraf dan axios
- [ ] Retry logic aktif untuk semua request Saweria
- [ ] Polling interval tidak terlalu cepat (min. 5 detik)

### Keamanan
- [ ] File `.env` masuk ke `.gitignore` (jangan di-commit ke GitHub!)
- [ ] BOT_TOKEN tidak hardcode di kode
- [ ] SAWERIA_USER_ID tidak hardcode di kode

### Fungsionalitas
- [ ] Test flow donasi dari awal sampai QR muncul
- [ ] Test polling status (bayar sungguhan atau tunggu expired)
- [ ] Test tombol Batalkan
- [ ] Test input nominal custom
- [ ] Test cek status manual dengan ID transaksi

---

## 📦 Dependencies

```json
{
  "dependencies": {
    "telegraf": "^4.16.3",
    "axios": "^1.7.2",
    "qrcode": "^1.5.3",
    "dotenv": "^17.0.0"
  }
}
```

Install semua sekaligus:
```bash
npm install telegraf axios qrcode dotenv
```

---

## 📝 Catatan Penting

1. **Saweria Build ID berubah** setiap kali Saweria deploy update ke servernya. Kode sudah handle otomatis dengan reset cache dan fallback ke backend API.

2. **QR QRIS hanya valid sekali** — setiap transaksi baru menghasilkan QR baru yang unik.

3. **Minimum donasi Rp 1.000** — request di bawah ini akan ditolak Saweria.

4. **QRIS maksimum Rp 10.000.000** per transaksi.

5. **Biaya PG QRIS** sekitar 0.7% dari nominal (contoh: Rp 35.000 → biaya Rp 248).

---

*Dokumentasi ini dibuat berdasarkan hasil reverse engineering Saweria API pada Maret 2026.*

require("dotenv").config();

// ✅ Fix 1: Force IPv4 (avoid IPv6 timeout issues di Indonesia)
const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

const { Telegraf, Markup, session } = require("telegraf");
const axios = require("axios");
const https = require("https");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");

// ===================== CONFIG =====================
const BOT_TOKEN = process.env.BOT_TOKEN || "ISI_BOT_TOKEN_KAMU";
const SAWERIA_USERNAME = process.env.SAWERIA_USERNAME || "zahwafe";
const SAWERIA_USER_ID = process.env.SAWERIA_USER_ID || "d8e876df-405c-4e08-9708-9808b9037ea5";
const CHECK_INTERVAL_MS = 7000;
const MAX_WAIT_MINUTES = 15;
const MAX_CHECK_ATTEMPTS = Math.floor((MAX_WAIT_MINUTES * 60 * 1000) / CHECK_INTERVAL_MS);
// ==================================================

// ✅ Fix 2: Keep-Alive HTTPS Agent (jaga koneksi tetap aktif)
const keepAliveAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 10000,
  maxSockets: 10,
  timeout: 30000,
});

// ✅ Fix 3: Axios instance dengan timeout & keep-alive
const axiosInstance = axios.create({
  timeout: 30000,
  httpsAgent: keepAliveAgent,
});

// ✅ Fix 4: Retry logic dengan exponential backoff
async function withRetry(fn, retries = 3, delayMs = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const isLast = i === retries - 1;
      if (isLast) throw err;
      const wait = delayMs * Math.pow(2, i); // 2s → 4s → 8s
      console.log(`⚠️ Retry ${i + 1}/${retries} setelah ${wait}ms... (${err.message})`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

// ✅ Fix 5: Telegraf dengan polling yang proper
const bot = new Telegraf(BOT_TOKEN, {
  telegram: {
    agent: keepAliveAgent,
    apiRoot: "https://api.telegram.org",
  },
});
bot.use(session());

const SAWERIA_API = "https://backend.saweria.co";

const NOMINAL_OPTIONS = [
  { label: "⚡ Rp 5.000",   value: 5000 },
  { label: "⚡ Rp 10.000",  value: 10000 },
  { label: "⚡ Rp 20.000",  value: 20000 },
  { label: "⚡ Rp 35.000",  value: 35000 },
  { label: "⚡ Rp 50.000",  value: 50000 },
  { label: "⚡ Rp 100.000", value: 100000 },
];

// ===================== SAWERIA API =====================

async function checkEligible(payload) {
  return withRetry(async () => {
    const res = await axiosInstance.post(
      `${SAWERIA_API}/reward/check-eligible/${SAWERIA_USERNAME}`,
      payload,
      { headers: { "Content-Type": "application/json", Origin: "https://saweria.co" } }
    );
    return res.data;
  });
}

async function calculateAmount(payload) {
  return withRetry(async () => {
    const res = await axiosInstance.post(
      `${SAWERIA_API}/donations/${SAWERIA_USERNAME}/calculate_pg_amount`,
      payload,
      { headers: { "Content-Type": "application/json", Origin: "https://saweria.co" } }
    );
    return res.data;
  });
}

async function createDonation(payload) {
  return withRetry(async () => {
    const res = await axiosInstance.post(
      `${SAWERIA_API}/donations/snap/${SAWERIA_USER_ID}`,
      payload,
      { headers: { "Content-Type": "application/json", Origin: "https://saweria.co" } }
    );
    return res.data;
  });
}

let _saweriaBuildId = null;
let _saweriaBuildIdFetching = false;

async function getSaweriaBuildId() {
  if (_saweriaBuildId) return _saweriaBuildId;
  if (_saweriaBuildIdFetching) {
    // tunggu sampai fetch selesai, lalu return hasilnya
    await new Promise((r) => setTimeout(r, 500));
    return _saweriaBuildId;
  }
  _saweriaBuildIdFetching = true;
  try {
    const res = await axiosInstance.get(`https://saweria.co/${SAWERIA_USERNAME}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const match = res.data.match(/"buildId"\s*:\s*"([^"]+)"/);
    if (match) {
      _saweriaBuildId = match[1];
      console.log("✅ Saweria Build ID:", _saweriaBuildId);
    }
  } catch (e) {
    console.error("Gagal ambil build ID:", e.message);
  } finally {
    _saweriaBuildIdFetching = false;
  }
  return _saweriaBuildId;
}

async function checkPaymentStatus(donationId) {
  try {
    const buildId = await getSaweriaBuildId();
    if (buildId) {
      const res = await axiosInstance.get(
        `https://saweria.co/_next/data/${buildId}/id/qris/snap/${donationId}.json`,
        { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://saweria.co/" } }
      );
      const data = res.data?.pageProps?.data;
      if (data) {
        return {
          data: {
            id: data.id,
            status: data.transaction_status,
            amount: data.amount_raw,
            created_at: data.created_at,
          },
        };
      }
    }
  } catch (e) {
    if (e.response?.status === 404) {
      console.log("⚠️ Build ID expired, reset cache...");
      _saweriaBuildId = null;
    }
  }
  try {
    const res = await axiosInstance.get(`${SAWERIA_API}/donations/${donationId}`, {
      headers: { Origin: "https://saweria.co" },
    });
    return res.data;
  } catch (e) {
    return null;
  }
}

async function generateQRImage(qrString, donationId) {
  const filePath = path.join("/tmp", `qr_${donationId}.png`);
  await QRCode.toFile(filePath, qrString, {
    width: 500,
    margin: 2,
    color: { dark: "#000000", light: "#ffffff" },
  });
  return filePath;
}

// ===================== HELPERS =====================

function formatRupiah(amount) {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    minimumFractionDigits: 0,
  }).format(amount);
}

function formatCountdown(secondsLeft) {
  const m = Math.floor(secondsLeft / 60);
  const s = secondsLeft % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function buildDonationPayload(amount, email, name, message) {
  return {
    agree: true,
    notUnderage: true,
    message: message || "-",
    amount,
    payment_type: "qris",
    vote: "",
    giphy: null,
    yt: "",
    ytStart: 0,
    mediaType: null,
    image_guess: null,
    image_guess_answer: "",
    amountToPay: "",
    currency: "IDR",
    pgFee: "",
    platformFee: "",
    customer_info: {
      first_name: name || email,
      email: email,
      phone: "",
    },
  };
}

// ===================== MENU =====================

function showMainMenu(ctx, edit = false) {
  const text =
    `🏠 *Menu Utama*\n\n` +
    `Halo *${ctx.from?.first_name || "Kamu"}*! 👋\n` +
    `Selamat datang di bot donasi *${SAWERIA_USERNAME}*\n\n` +
    `Silakan pilih menu di bawah:`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("💸 Donasi Sekarang", "menu_donasi")],
    [Markup.button.callback("🔍 Cek Status Pembayaran", "menu_cek_status")],
    [Markup.button.callback("ℹ️ Tentang Bot", "menu_info")],
  ]);

  if (edit) return ctx.editMessageText(text, { parse_mode: "Markdown", ...keyboard });
  return ctx.replyWithMarkdown(text, keyboard);
}

function showNominalMenu(ctx, edit = false) {
  const buttons = NOMINAL_OPTIONS.map((opt) =>
    Markup.button.callback(opt.label, `amount_${opt.value}`)
  );
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([Markup.button.callback("✏️ Nominal Lain", "amount_custom")]);
  rows.push([Markup.button.callback("🔙 Kembali", "back_main")]);

  const text = `💰 *Pilih Nominal Donasi*\n\nUntuk: *${SAWERIA_USERNAME}*\nPilih nominal atau masukkan sendiri:`;
  const keyboard = Markup.inlineKeyboard(rows);

  if (edit) return ctx.editMessageText(text, { parse_mode: "Markdown", ...keyboard });
  return ctx.replyWithMarkdown(text, keyboard);
}

// ===================== HELPERS =====================

function deleteQRFile(donationId) {
  const qrFile = path.join("/tmp", `qr_${donationId}.png`);
  try {
    if (fs.existsSync(qrFile)) fs.unlinkSync(qrFile);
  } catch (_) {}
}

// ===================== POLLING =====================

const activeIntervals = {};
const processingUsers = new Set();

async function pollPaymentStatus(ctx, donationId, chatId, msgId, amountRaw) {
  let attempts = 0;
  const totalSeconds = MAX_WAIT_MINUTES * 60;
  let lastEditedMinute = MAX_WAIT_MINUTES;

  const interval = setInterval(async () => {
    attempts++;
    const secondsElapsed = attempts * (CHECK_INTERVAL_MS / 1000);
    const secondsLeft = Math.max(0, totalSeconds - secondsElapsed);

    const data = await checkPaymentStatus(donationId);
    const rawStatus = data?.data?.status || "";
    const status = rawStatus.toUpperCase();

    if (["SUCCESS", "SETTLEMENT", "PAID"].includes(status)) {
      clearInterval(interval);
      delete activeIntervals[donationId];
      deleteQRFile(donationId);
      try {
        await ctx.telegram.editMessageText(
          chatId, msgId, null,
          `✅ *Pembayaran Berhasil!*\n\n` +
          `💰 Jumlah: ${formatRupiah(amountRaw)}\n` +
          `🎉 Terima kasih sudah support *${SAWERIA_USERNAME}*!\n\n` +
          `_ID:_ \`${donationId}\``,
          {
            parse_mode: "Markdown",
            ...Markup.inlineKeyboard([
              [Markup.button.callback("💸 Donasi Lagi", "menu_donasi_new")],
              [Markup.button.callback("🏠 Menu Utama", "back_main_new")],
            ]),
          }
        );
      } catch (_) {}

    } else if (["FAILED", "EXPIRED", "CANCEL", "FAILURE", "DENY"].includes(status)) {
      clearInterval(interval);
      delete activeIntervals[donationId];
      deleteQRFile(donationId);
      try {
        await ctx.telegram.editMessageText(
          chatId, msgId, null,
          `❌ *Pembayaran Gagal / Dibatalkan*\n\nSilakan coba donasi lagi.`,
          {
            parse_mode: "Markdown",
            ...Markup.inlineKeyboard([
              [Markup.button.callback("💸 Donasi Lagi", "menu_donasi_new")],
              [Markup.button.callback("🏠 Menu Utama", "back_main_new")],
            ]),
          }
        );
      } catch (_) {}

    } else if (secondsLeft <= 0) {
      clearInterval(interval);
      delete activeIntervals[donationId];
      deleteQRFile(donationId);
      try {
        await ctx.telegram.editMessageText(
          chatId, msgId, null,
          `⏰ *Waktu Habis*\n\nQR sudah tidak valid (${MAX_WAIT_MINUTES} menit berlalu).\nBuat donasi baru ya!`,
          {
            parse_mode: "Markdown",
            ...Markup.inlineKeyboard([
              [Markup.button.callback("💸 Donasi Lagi", "menu_donasi_new")],
              [Markup.button.callback("🏠 Menu Utama", "back_main_new")],
            ]),
          }
        );
      } catch (_) {}

    } else {
      // Update tampilan countdown tiap 1 menit
      const currentMinute = Math.floor(secondsLeft / 60);
      if (currentMinute < lastEditedMinute) {
        lastEditedMinute = currentMinute;
        try {
          await ctx.telegram.editMessageText(
            chatId, msgId, null,
            `⏳ *Menunggu Pembayaran...*\n\n` +
            `🆔 ID: \`${donationId}\`\n` +
            `⏱ Sisa waktu: *${formatCountdown(Math.floor(secondsLeft))}*\n\n` +
            `_Otomatis update setelah bayar_`,
            {
              parse_mode: "Markdown",
              ...Markup.inlineKeyboard([
                [Markup.button.callback("❌ Batalkan", `cancel_${donationId}`)],
              ]),
            }
          );
        } catch (_) {}
      }
    }
  }, CHECK_INTERVAL_MS);

  return interval;
}

// ===================== BOT ACTIONS =====================

bot.start((ctx) => { ctx.session = {}; showMainMenu(ctx); });

bot.action("back_main", async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = {};
  showMainMenu(ctx, true);
});
bot.action("back_main_new", async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = {};
  showMainMenu(ctx, false);
});

bot.action("menu_info", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `ℹ️ *Tentang Bot Donasi*\n\n` +
    `🎯 Creator: [${SAWERIA_USERNAME}](https://saweria.co/${SAWERIA_USERNAME})\n` +
    `💳 Metode: QRIS (semua e-wallet & m-banking)\n` +
    `🔒 Aman via Saweria\n` +
    `⏰ Waktu bayar: *${MAX_WAIT_MINUTES} menit*`,
    {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Kembali", "back_main")]]),
    }
  );
});

bot.action("menu_cek_status", async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = { step: "input_cek_id" };
  await ctx.editMessageText(
    `🔍 *Cek Status Pembayaran*\n\nKetik *ID Transaksi* kamu:\n\n_Contoh:_\n\`08e1e8c5-7c85-445d-9b7b-085241d8b27c\``,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Kembali", "back_main")]]),
    }
  );
});

bot.action("menu_donasi", async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = { step: "choose_amount" };
  showNominalMenu(ctx, true);
});
bot.action("menu_donasi_new", async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = { step: "choose_amount" };
  showNominalMenu(ctx, false);
});

bot.action(/^amount_(\d+)$/, async (ctx) => {
  const amount = parseInt(ctx.match[1]);
  ctx.session = { step: "input_name", amount };
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `✅ Nominal: *${formatRupiah(amount)}*\n\n👤 Masukkan *nama* kamu:`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🔙 Ganti Nominal", "menu_donasi")],
        [Markup.button.callback("🏠 Menu Utama", "back_main")],
      ]),
    }
  );
});

bot.action("amount_custom", async (ctx) => {
  ctx.session = { step: "input_custom_amount" };
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `✏️ *Masukkan Nominal*\n\nKetik jumlah donasi (angka saja, min. Rp 1.000):\n\n_Contoh:_ \`25000\``,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Kembali", "menu_donasi")]]),
    }
  );
});

bot.action("skip_message", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  await processMessage(ctx, "");
});

bot.action(/^cancel_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery("Transaksi dibatalkan");
  const donationId = ctx.match[1];
  if (activeIntervals[donationId]) {
    clearInterval(activeIntervals[donationId]);
    delete activeIntervals[donationId];
  }
  await ctx.editMessageText(
    `❌ *Transaksi Dibatalkan*`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("💸 Donasi Lagi", "menu_donasi_new")],
        [Markup.button.callback("🏠 Menu Utama", "back_main_new")],
      ]),
    }
  );
});

// ===================== HANDLER TEKS =====================

bot.on("text", async (ctx) => {
  const session = ctx.session || {};
  const text = ctx.message.text.trim();

  if (session.step === "input_cek_id") {
    const loadingMsg = await ctx.reply("🔍 Mengecek status...");
    const data = await checkPaymentStatus(text);
    await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id);

    if (!data?.data) {
      ctx.session = {};
      return ctx.replyWithMarkdown(
        `❌ *Transaksi tidak ditemukan*\n\nPastikan ID transaksi benar.`,
        Markup.inlineKeyboard([
          [Markup.button.callback("🔍 Cek Lagi", "menu_cek_status")],
          [Markup.button.callback("🏠 Menu Utama", "back_main_new")],
        ])
      );
    }

    const d = data.data;
    const normalStatus = (d.status || "").toUpperCase();
    const statusEmoji = ["SUCCESS", "SETTLEMENT", "PAID"].includes(normalStatus)
      ? "✅" : normalStatus === "PENDING" ? "⏳" : "❌";

    ctx.session = {};
    return ctx.replyWithMarkdown(
      `${statusEmoji} *Status Pembayaran*\n\n` +
      `🆔 ID: \`${d.id}\`\n` +
      `💰 Jumlah: ${formatRupiah(d.amount)}\n` +
      `📌 Status: *${d.status}*\n` +
      `📅 Tanggal: ${d.created_at}`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🔍 Cek Lagi", "menu_cek_status")],
        [Markup.button.callback("🏠 Menu Utama", "back_main_new")],
      ])
    );
  }

  if (session.step === "input_custom_amount") {
    const amount = parseInt(text.replace(/\D/g, ""));
    if (isNaN(amount) || amount < 1000) {
      return ctx.reply("⚠️ Nominal tidak valid. Min Rp 1.000 (angka saja).",
        Markup.inlineKeyboard([[Markup.button.callback("🔙 Kembali", "menu_donasi_new")]])
      );
    }
    ctx.session.amount = amount;
    ctx.session.step = "input_name";
    return ctx.replyWithMarkdown(
      `✅ Nominal: *${formatRupiah(amount)}*\n\n👤 Masukkan *nama* kamu:`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🔙 Ganti Nominal", "menu_donasi_new")],
        [Markup.button.callback("🏠 Menu Utama", "back_main_new")],
      ])
    );
  }

  if (session.step === "input_name") {
    if (text.length < 2) return ctx.reply("⚠️ Nama minimal 2 karakter.");
    ctx.session.name = text;
    ctx.session.step = "input_email";
    return ctx.replyWithMarkdown(
      `👤 Nama: *${text}*\n\n📧 Masukkan *email* kamu:`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🔙 Ganti Nominal", "menu_donasi_new")],
        [Markup.button.callback("🏠 Menu Utama", "back_main_new")],
      ])
    );
  }

  if (session.step === "input_email") {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
      return ctx.reply("⚠️ Format email tidak valid. Coba lagi:");
    }
    ctx.session.email = text;
    ctx.session.step = "input_message";
    return ctx.replyWithMarkdown(
      `📧 Email: *${text}*\n\n💬 Tulis *pesan* untuk *${SAWERIA_USERNAME}*:`,
      Markup.inlineKeyboard([
        [Markup.button.callback("⏭ Skip Pesan", "skip_message")],
        [Markup.button.callback("🏠 Menu Utama", "back_main_new")],
      ])
    );
  }

  if (session.step === "input_message") {
    await processMessage(ctx, text === "-" ? "" : text);
  }
});

// ===================== PROSES DONASI =====================

async function processMessage(ctx, message) {
  const userId = ctx.from?.id;
  if (processingUsers.has(userId)) {
    return ctx.reply("⚠️ Donasi sedang diproses, tunggu sebentar ya.");
  }
  processingUsers.add(userId);

  ctx.session.message = message;
  ctx.session.step = "processing";
  const { amount, name, email } = ctx.session;
  const chatId = ctx.chat.id;

  const processingMsg = await ctx.replyWithMarkdown(
    `⏳ *Memproses donasi...*\n💰 ${formatRupiah(amount)} untuk *${SAWERIA_USERNAME}*`
  );

  try {
    const payload = buildDonationPayload(amount, email, name, message);
    await checkEligible({ ...payload, agree: false, notUnderage: false });
    const calcData = await calculateAmount(payload);
    const { amount_to_pay, pg_fee, platform_fee } = calcData.data;

    const finalPayload = {
      ...payload,
      amountToPay: String(amount_to_pay),
      pgFee: String(pg_fee),
      platformFee: String(platform_fee ?? 0),
    };

    const donationData = await createDonation(finalPayload);
    const donation = donationData.data;
    const qrString = donation.qr_string;
    const donationId = donation.id;
    const qrPath = await generateQRImage(qrString, donationId);

    await ctx.telegram.deleteMessage(chatId, processingMsg.message_id);

    await ctx.replyWithPhoto(
      { source: qrPath },
      {
        caption:
          `🧾 *Detail Donasi*\n\n` +
          `👤 Nama: *${name}*\n` +
          `💰 Nominal: ${formatRupiah(amount)}\n` +
          `💳 Biaya PG: ${formatRupiah(pg_fee)}\n` +
          `💵 *Total Bayar: ${formatRupiah(amount_to_pay)}*\n` +
          `💬 Pesan: ${message || "-"}\n\n` +
          `📱 *Scan QR pakai e-wallet / m-banking*\n` +
          `⏰ Waktu bayar: *${MAX_WAIT_MINUTES} menit*`,
        parse_mode: "Markdown",
      }
    );

    const statusMsg = await ctx.replyWithMarkdown(
      `⏳ *Menunggu Pembayaran...*\n\n` +
      `🆔 ID: \`${donationId}\`\n` +
      `⏱ Sisa waktu: *${MAX_WAIT_MINUTES}:00*\n\n` +
      `_Otomatis update setelah bayar_`,
      Markup.inlineKeyboard([
        [Markup.button.callback("❌ Batalkan", `cancel_${donationId}`)],
      ])
    );

    const intervalId = await pollPaymentStatus(
      ctx, donationId, chatId, statusMsg.message_id, amount_to_pay
    );
    activeIntervals[donationId] = intervalId;
    ctx.session = {};
    processingUsers.delete(userId);

  } catch (err) {
    console.error("Error:", err?.response?.data || err.message);
    await ctx.telegram.editMessageText(
      chatId, processingMsg.message_id, null,
      `❌ *Gagal membuat donasi*\n\n${err?.response?.data?.message || err.message}`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🔄 Coba Lagi", "menu_donasi_new")],
          [Markup.button.callback("🏠 Menu Utama", "back_main_new")],
        ]),
      }
    );
    ctx.session = {};
    processingUsers.delete(userId);
  }
}

// ===================== START =====================

console.log("🤖 Bot Saweria dimulai...");
bot.launch({
  polling: {
    timeout: 30,   // long polling 30 detik
    limit: 100,    // max 100 update per request
  },
}).then(() => console.log("✅ Bot berjalan! Kirim /start ke bot kamu."))
  .catch((err) => {
    console.error("❌ Gagal start bot:", err.message);
    process.exit(1);
  });
function gracefulShutdown(signal) {
  console.log(`\n${signal} diterima, membersihkan dan mematikan bot...`);
  for (const [donationId, intervalId] of Object.entries(activeIntervals)) {
    clearInterval(intervalId);
    deleteQRFile(donationId);
  }
  bot.stop(signal);
}

process.once("SIGINT", () => gracefulShutdown("SIGINT"));
process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));

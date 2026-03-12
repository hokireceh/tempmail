'use strict';
const { CACHE_MAX_SIZE, DONATION_CHECK_INTERVAL, DONATION_MAX_MINUTES } = require('./config');
const { LRUCache } = require('./helpers');

const userInboxCache     = new LRUCache(CACHE_MAX_SIZE);
const broadcastState     = new Map();
const donationSessions   = new Map();
const activeDonationPollers = new Map();

const DONATION_NOMINAL_OPTIONS = [
    { label: '☕ Rp 5.000  – Secangkir kopi',    value: 5000   },
    { label: '🍜 Rp 10.000 – Segelas es teh',     value: 10000  },
    { label: '🧋 Rp 20.000 – Boba buat begadang', value: 20000  },
    { label: '⚡ Rp 35.000 – Server 1 hari',      value: 35000  },
    { label: '💪 Rp 50.000 – Pahlawan bot',       value: 50000  },
    { label: '🦸 Rp 100.000 – Legenda bot',       value: 100000 },
];

module.exports = {
    userInboxCache,
    broadcastState,
    donationSessions,
    activeDonationPollers,
    DONATION_NOMINAL_OPTIONS,
};

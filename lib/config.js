'use strict';
require('dotenv').config();

module.exports = {
    TELEGRAM_TOKEN:          process.env.TELEGRAM_BOT_TOKEN,
    ADMIN_IDS:               process.env.ADMIN_IDS
                                 ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim()))
                                 : [],
    TMAILOR_API:             process.env.TMAILOR_API || 'https://tmailor.com/api',
    CHECK_INTERVAL:          parseInt(process.env.CHECK_INTERVAL)       || 60000,
    BROADCAST_RATE_LIMIT:    parseInt(process.env.BROADCAST_RATE_LIMIT) || 25,
    CONCURRENT_CHECKS:       parseInt(process.env.CONCURRENT_CHECKS)    || 10,
    CHECK_TIMEOUT:           parseInt(process.env.CHECK_TIMEOUT)        || 15000,
    DB_POOL_SIZE:            parseInt(process.env.DB_POOL_SIZE)         || 20,
    CACHE_MAX_SIZE:          parseInt(process.env.CACHE_MAX_SIZE)       || 10000,
    ACTIVE_USER_HOURS:       parseInt(process.env.ACTIVE_USER_HOURS)    || 24,
    WEBHOOK_PORT:            process.env.WEBHOOK_PORT                   || 3000,
    DONATION_CHECK_INTERVAL: 7000,
    DONATION_MAX_MINUTES:    15,
};

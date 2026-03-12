'use strict';
const { CONCURRENT_CHECKS, CHECK_TIMEOUT, ACTIVE_USER_HOURS } = require('./config');
const { circuitBreaker } = require('./emailApi');

const MAX_RETRIES = 3;
let isProcessingAutoCheck = false;
let lastCheckStats = { total: 0, checked: 0, failed: 0, newEmails: 0, skipped: 0 };
let adaptiveConcurrency = CONCURRENT_CHECKS;

let _bot, _dbClient, _checkEmails, _updateLastChecked;

function init({ bot, dbClient, checkEmails, updateLastChecked }) {
    _bot = bot;
    _dbClient = dbClient;
    _checkEmails = checkEmails;
    _updateLastChecked = updateLastChecked;
}

async function checkEmailWithTimeout(userId, latestEmail, retries = 0) {
    if (!circuitBreaker.canRequest()) {
        lastCheckStats.skipped++;
        return false;
    }

    try {
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Check timeout')), CHECK_TIMEOUT)
        );

        const result = await Promise.race([
            _checkEmails(latestEmail.email, latestEmail.token),
            timeoutPromise
        ]);

        circuitBreaker.recordSuccess();

        if (Array.isArray(result) && result.length > 0) {
            const lastCheckTime = new Date(latestEmail.last_checked);
            const newMessages = result.filter(msg =>
                msg.time && new Date(msg.time * 1000) > lastCheckTime
            );

            if (newMessages.length > 0) {
                lastCheckStats.newEmails++;
                _bot.sendMessage(
                    userId,
                    `📬 *${newMessages.length} Email Baru Masuk!*\n\n` +
                    `📧 Email: \`${latestEmail.email}\``,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '🔍 Lihat Email', callback_data: 'check_email' }]
                            ]
                        }
                    }
                ).catch(err => console.error(`Notification failed for ${userId}:`, err.message));

                await _updateLastChecked(latestEmail.id);
            }
        }

        await _dbClient.query('UPDATE user_emails SET check_count = check_count + 1 WHERE id = $1', [latestEmail.id]).catch(() => {});

        lastCheckStats.checked++;
        return true;
    } catch (error) {
        circuitBreaker.recordFailure();

        if (retries < MAX_RETRIES && circuitBreaker.canRequest()) {
            const delay = Math.pow(2, retries) * 500;
            await new Promise(resolve => setTimeout(resolve, delay));
            return checkEmailWithTimeout(userId, latestEmail, retries + 1);
        }
        lastCheckStats.failed++;
        return false;
    }
}

async function processBatch(emailBatch) {
    const promises = emailBatch.map(({ userId, email }) =>
        checkEmailWithTimeout(userId, email).catch(() => {
            lastCheckStats.failed++;
        })
    );
    await Promise.all(promises);
}

async function getActiveEmails() {
    const query = `
        SELECT ue.id, ue.user_id, ue.email, ue.code, ue.token, ue.last_checked,
               ue.created_at, ue.last_activity
        FROM user_emails ue
        WHERE ue.is_active = true 
          AND ue.last_activity > NOW() - ($1 * INTERVAL '1 hour')
        ORDER BY ue.last_activity DESC
        LIMIT 50000
    `;

    try {
        const result = await _dbClient.query(query, [ACTIVE_USER_HOURS]);
        return result.rows;
    } catch (error) {
        console.log('⚠️ Fallback to legacy query');
        const result = await _dbClient.query('SELECT * FROM user_emails ORDER BY created_at DESC LIMIT 10000');
        return result.rows;
    }
}

async function autoCheckEmails() {
    if (isProcessingAutoCheck) {
        console.log('⏳ Previous auto-check still running, skipping...');
        return;
    }

    if (!circuitBreaker.canRequest()) {
        console.log('🔴 Circuit breaker open, skipping auto-check...');
        return;
    }

    isProcessingAutoCheck = true;
    const startTime = Date.now();
    console.log('🔍 Smart auto-check running...');

    try {
        const activeEmails = await getActiveEmails();
        const totalActive  = activeEmails.length;

        const totalResult = await _dbClient.query('SELECT COUNT(*) as count FROM user_emails');
        const totalUsers  = parseInt(totalResult.rows[0].count);

        lastCheckStats = { total: totalActive, checked: 0, failed: 0, newEmails: 0, skipped: totalUsers - totalActive };

        console.log(`📧 Checking ${totalActive} active users (${lastCheckStats.skipped} inactive skipped) of ${totalUsers} total`);

        const emailsList = activeEmails.map(email => ({
            userId: email.user_id,
            email: email
        }));

        if (lastCheckStats.failed > lastCheckStats.checked * 0.3) {
            adaptiveConcurrency = Math.max(3, adaptiveConcurrency - 2);
            console.log(`⚠️ High failure rate, reducing concurrency to ${adaptiveConcurrency}`);
        } else if (lastCheckStats.failed < lastCheckStats.checked * 0.05 && adaptiveConcurrency < CONCURRENT_CHECKS) {
            adaptiveConcurrency = Math.min(CONCURRENT_CHECKS, adaptiveConcurrency + 1);
        }

        for (let i = 0; i < emailsList.length; i += adaptiveConcurrency) {
            if (!circuitBreaker.canRequest()) {
                console.log('🔴 Circuit breaker opened during check, stopping...');
                break;
            }

            const batch = emailsList.slice(i, i + adaptiveConcurrency);
            await processBatch(batch);

            if (i + adaptiveConcurrency < emailsList.length) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            if (emailsList.length > 1000 && (i % 500 === 0)) {
                const progress = ((i / emailsList.length) * 100).toFixed(0);
                console.log(`📊 Progress: ${progress}% (${i}/${emailsList.length})`);
            }
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`✅ Auto-check completed in ${duration}s - Checked: ${lastCheckStats.checked}/${lastCheckStats.total}, New: ${lastCheckStats.newEmails}, Failed: ${lastCheckStats.failed}, Skipped: ${lastCheckStats.skipped}`);

    } catch (error) {
        console.error('❌ Auto-check database error:', error.message);
    } finally {
        isProcessingAutoCheck = false;
    }
}

module.exports = {
    init,
    checkEmailWithTimeout,
    processBatch,
    getActiveEmails,
    autoCheckEmails,
};

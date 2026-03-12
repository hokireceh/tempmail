'use strict';
const { Pool } = require('pg');
const { DB_POOL_SIZE } = require('./config');
const { initializeDatabase } = require('../db-init');

const dbPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: DB_POOL_SIZE,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    maxUses: 7500,
});

dbPool.on('error', (err) => {
    console.error('❌ Unexpected database pool error:', err.message);
});

const dbClient = {
    query: (...args) => dbPool.query(...args)
};

async function initDb() {
    const client = await dbPool.connect();
    console.log('✅ Database pool connected (max connections: ' + DB_POOL_SIZE + ')');
    await initializeDatabase(client);
    client.release();
}

async function saveEmail(userId, email, code, token) {
    try {
        const result = await dbClient.query(
            'INSERT INTO user_emails (user_id, email, code, token) VALUES ($1, $2, $3, $4) RETURNING *',
            [userId, email, code, token]
        );
        return result.rows[0];
    } catch (error) {
        console.error('❌ Error saving email:', error.message);
        throw error;
    }
}

async function getUserEmails(userId) {
    try {
        const result = await dbClient.query(
            'SELECT * FROM user_emails WHERE user_id = $1 ORDER BY created_at DESC',
            [userId]
        );
        return result.rows;
    } catch (error) {
        console.error('❌ Error getting emails:', error.message);
        return [];
    }
}

async function getLatestEmail(userId) {
    try {
        const result = await dbClient.query(
            'SELECT * FROM user_emails WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
            [userId]
        );
        return result.rows[0] || null;
    } catch (error) {
        console.error('❌ Error getting latest email:', error.message);
        return null;
    }
}

async function deleteOldEmails(userId) {
    try {
        const result = await dbClient.query(
            'DELETE FROM user_emails WHERE user_id = $1',
            [userId]
        );
        console.log(`🗑️ Deleted ${result.rowCount} old emails for user ${userId}`);
        return result.rowCount;
    } catch (error) {
        console.error('❌ Error deleting old emails:', error.message);
        throw error;
    }
}

async function updateLastChecked(emailId) {
    try {
        await dbClient.query(
            'UPDATE user_emails SET last_checked = CURRENT_TIMESTAMP WHERE id = $1',
            [emailId]
        );
    } catch (error) {
        console.error('❌ Error updating last_checked:', error.message);
    }
}

module.exports = {
    dbPool,
    dbClient,
    initDb,
    saveEmail,
    getUserEmails,
    getLatestEmail,
    deleteOldEmails,
    updateLastChecked,
};

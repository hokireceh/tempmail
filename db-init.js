// Database initialization script - creates tables if they don't exist
const { Client } = require('pg');

async function initializeDatabase(dbClient) {
    try {
        console.log('🔧 Initializing database tables...');

        // Table 1: user_emails (with additional fields for smart auto-check)
        await dbClient.query(`
            CREATE TABLE IF NOT EXISTS user_emails (
                id SERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL,
                email VARCHAR(255) NOT NULL UNIQUE,
                code VARCHAR(255),
                token TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_checked TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                is_active BOOLEAN DEFAULT true,
                check_count INTEGER DEFAULT 0
            );
        `);
        console.log('✅ Table user_emails initialized');

        // Table 2: bot_users (user tracking)
        await dbClient.query(`
            CREATE TABLE IF NOT EXISTS bot_users (
                user_id BIGINT PRIMARY KEY,
                username VARCHAR(255),
                first_name VARCHAR(255),
                last_name VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_interaction TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ Table bot_users initialized');

        // Table 3: broadcasts (broadcast history)
        await dbClient.query(`
            CREATE TABLE IF NOT EXISTS broadcasts (
                id SERIAL PRIMARY KEY,
                admin_id BIGINT NOT NULL,
                broadcast_type VARCHAR(50),
                content_text TEXT,
                media_file_id VARCHAR(255),
                media_type VARCHAR(50),
                total_users INTEGER DEFAULT 0,
                success_count INTEGER DEFAULT 0,
                failed_count INTEGER DEFAULT 0,
                blocked_count INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                completed_at TIMESTAMP
            );
        `);
        console.log('✅ Table broadcasts initialized');

        // Create indexes for better performance
        await dbClient.query(`CREATE INDEX IF NOT EXISTS idx_user_emails_user_id ON user_emails(user_id);`);
        await dbClient.query(`CREATE INDEX IF NOT EXISTS idx_user_emails_is_active ON user_emails(is_active);`);
        await dbClient.query(`CREATE INDEX IF NOT EXISTS idx_user_emails_last_activity ON user_emails(last_activity);`);
        await dbClient.query(`CREATE INDEX IF NOT EXISTS idx_bot_users_user_id ON bot_users(user_id);`);
        await dbClient.query(`CREATE INDEX IF NOT EXISTS idx_bot_users_last_interaction ON bot_users(last_interaction);`);
        await dbClient.query(`CREATE INDEX IF NOT EXISTS idx_broadcasts_admin_id ON broadcasts(admin_id);`);
        await dbClient.query(`CREATE INDEX IF NOT EXISTS idx_broadcasts_created_at ON broadcasts(created_at);`);

        console.log('✅ Database indexes created');
        console.log('✅ Database initialization completed successfully!');
        return true;

    } catch (error) {
        console.error('❌ Error initializing database:', error.message);
        throw error;
    }
}

module.exports = { initializeDatabase };
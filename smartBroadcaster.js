// smartBroadcaster.js - Service untuk broadcast dengan queue, rate limiting, dan retry

class SmartBroadcaster {
    constructor(bot, rateLimitOrDbClient) {
        this.bot = bot;
        
        // Handle both old and new constructor signatures
        if (typeof rateLimitOrDbClient === 'number') {
            this.rateLimit = rateLimitOrDbClient;
            this.dbClient = null;
        } else {
            this.rateLimit = 25; // default rate limit
            this.dbClient = rateLimitOrDbClient;
        }

        this.queue = [];
        this.processing = false;
        this.stats = {
            total: 0,
            success: 0,
            failed: 0,
            retries: 0,
            blocked: 0,
            processed: 0,
            startTime: null,
            isProcessing: false,
            failedUsers: []
        };
        this.maxRetries = 3;
    }

    async broadcast(targetUserIds, message, mediaInfo = null, mediaCaption = null, entities = []) {
        this.stats = {
            total: targetUserIds.length,
            success: 0,
            failed: 0,
            retries: 0,
            blocked: 0,
            processed: 0,
            startTime: Date.now(),
            isProcessing: true,
            failedUsers: []
        };

        console.log(`🚀 Starting broadcast to ${targetUserIds.length} users (Media: ${mediaInfo ? mediaInfo.type : 'None'}, Entities: ${entities.length})`);

        // Add all users to queue
        for (const userId of targetUserIds) {
            this.queue.push({
                userId,
                message,
                mediaInfo,
                mediaCaption: mediaCaption || message,
                entities: entities || [],
                retries: 0,
                addedAt: Date.now()
            });
        }

        // Start processing dan tunggu selesai
        if (!this.processing) {
            await this.processQueue();
        }

        // Return stats setelah selesai
        return {
            successCount: this.stats.success,
            failedCount: this.stats.failed,
            blockedCount: this.stats.blocked,
            total: this.stats.total
        };
    }

    async processQueue() {
        if (this.processing) return;
        this.processing = true;

        const delayBetweenMessages = 1000 / this.rateLimit;

        console.log(`⚡ Queue processing started: ${this.queue.length} jobs, rate: ${this.rateLimit}/s`);

        while (this.queue.length > 0) {
            const job = this.queue.shift();

            try {
                const result = await this.sendToUser(job);

                if (result === 'success') {
                    this.stats.success++;
                } else if (result === 'blocked') {
                    this.stats.blocked++;
                    this.stats.failed++;
                } else if (result === 'retry' && job.retries < this.maxRetries) {
                    job.retries++;
                    this.stats.retries++;
                    this.queue.push(job);
                    console.log(`🔁 Retry queued for user ${job.userId} (attempt ${job.retries}/${this.maxRetries})`);
                } else {
                    this.stats.failed++;
                    this.stats.failedUsers.push(job.userId);
                }

            } catch (error) {
                console.error(`❌ Unexpected error for ${job.userId}:`, error.message);
                this.stats.failed++;
                this.stats.failedUsers.push(job.userId);
            } finally {
                this.stats.processed++;
            }

            // Rate limiting delay
            await new Promise(resolve => setTimeout(resolve, delayBetweenMessages));
        }

        this.stats.isProcessing = false;
        this.processing = false;

        const duration = ((Date.now() - this.stats.startTime) / 1000).toFixed(1);
        console.log(`✅ Broadcast completed in ${duration}s - Success: ${this.stats.success}, Failed: ${this.stats.failed}, Blocked: ${this.stats.blocked}`);
    }

    async sendToUser(job) {
        try {
            if (job.mediaInfo) {
                // Send media
                const options = {
                    caption: job.mediaCaption || job.message,
                    protect_content: false
                };

                // Add caption entities if exist (for photo, video, document, audio, animation)
                if (job.entities && job.entities.length > 0) {
                    // caption_entities untuk media dengan caption
                    if (['photo', 'video', 'document', 'audio', 'animation'].includes(job.mediaInfo.type)) {
                        options.caption_entities = job.entities;
                    }
                }

                switch (job.mediaInfo.type) {
                    case 'photo':
                        await this.bot.sendPhoto(job.userId, job.mediaInfo.file_id, options);
                        console.log(`✅ Photo sent to user ${job.userId}`);
                        break;
                    case 'video':
                        await this.bot.sendVideo(job.userId, job.mediaInfo.file_id, options);
                        console.log(`✅ Video sent to user ${job.userId}`);
                        break;
                    case 'document':
                        await this.bot.sendDocument(job.userId, job.mediaInfo.file_id, options);
                        console.log(`✅ Document sent to user ${job.userId}`);
                        break;
                    case 'audio':
                        await this.bot.sendAudio(job.userId, job.mediaInfo.file_id, options);
                        console.log(`✅ Audio sent to user ${job.userId}`);
                        break;
                    case 'voice':
                        // Voice tidak support caption, kirim terpisah jika ada caption
                        await this.bot.sendVoice(job.userId, job.mediaInfo.file_id);
                        if (job.mediaCaption && job.mediaCaption.trim()) {
                            const textOptions = {};
                            if (job.entities && job.entities.length > 0) {
                                textOptions.entities = job.entities;
                            }
                            await this.bot.sendMessage(job.userId, job.mediaCaption, textOptions);
                        }
                        console.log(`✅ Voice message sent to user ${job.userId}`);
                        break;
                    case 'animation':
                        await this.bot.sendAnimation(job.userId, job.mediaInfo.file_id, options);
                        console.log(`✅ Animation sent to user ${job.userId}`);
                        break;
                }
            } else {
                // Send text message dengan entities support
                const messageOptions = {};
                if (job.entities && job.entities.length > 0) {
                    messageOptions.entities = job.entities;
                } else {
                    // Fallback to parse_mode jika tidak ada entities
                    messageOptions.parse_mode = 'Markdown';
                }
                
                await this.bot.sendMessage(job.userId, job.message, messageOptions);
                console.log(`✅ Text message sent to user ${job.userId}`);
            }

            return 'success';

        } catch (error) {
            const errorMsg = error.message.toLowerCase();

            // Check if user blocked bot or chat not found
            if ((error.code === 'ETELEGRAM' && error.response?.error_code === 403) ||
                errorMsg.includes('blocked') || 
                errorMsg.includes('bot was blocked') ||
                errorMsg.includes('chat not found') ||
                errorMsg.includes('user is deactivated')) {

                await this.removeUser(job.userId);
                console.log(`🚫 User ${job.userId} blocked/deactivated - auto removed`);
                return 'blocked';
            }

            // Retry on rate limit or network errors
            if ((error.code === 'ETELEGRAM' && error.response?.error_code === 429) ||
                errorMsg.includes('timeout') || 
                errorMsg.includes('network')) {

                console.warn(`⚠️ Retryable error for user ${job.userId}: ${error.message}`);
                return 'retry';
            }

            // Other errors
            console.error(`❌ Failed to send to user ${job.userId}: ${error.message}`);
            return 'failed';
        }
    }

    async removeUser(userId) {
        try {
            // Hanya remove jika dbClient tersedia
            if (this.dbClient) {
                await this.dbClient.query('DELETE FROM bot_users WHERE user_id = $1', [userId]);
                console.log(`🗑️ Removed user ${userId} from database`);
            }
        } catch (error) {
            console.error(`Error removing user ${userId}:`, error.message);
        }
    }

    getProgress() {
        const elapsedTime = this.stats.startTime 
            ? ((Date.now() - this.stats.startTime) / 1000).toFixed(1)
            : 0;

        const progressPercent = this.stats.total > 0
            ? Math.round((this.stats.processed / this.stats.total) * 100)
            : 0;

        return {
            ...this.stats,
            elapsedTime,
            progressPercent,
            remaining: this.queue.length
        };
    }

    reset() {
        this.queue = [];
        this.processing = false;
        this.stats = {
            total: 0,
            success: 0,
            failed: 0,
            retries: 0,
            blocked: 0,
            processed: 0,
            startTime: null,
            isProcessing: false,
            failedUsers: []
        };
    }
}

module.exports = SmartBroadcaster;
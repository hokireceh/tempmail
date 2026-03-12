'use strict';

class LRUCache {
    constructor(maxSize) {
        this.maxSize = maxSize;
        this.cache = new Map();
    }

    get(key) {
        if (!this.cache.has(key)) return undefined;
        const value = this.cache.get(key);
        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
    }

    set(key, value) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        this.cache.set(key, value);
    }

    delete(key) {
        return this.cache.delete(key);
    }

    has(key) {
        return this.cache.has(key);
    }

    size() {
        return this.cache.size;
    }

    clear() {
        this.cache.clear();
    }
}

function escapeHtml(text) {
    if (!text) return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

let _bot = null;

function init({ bot }) {
    _bot = bot;
}

async function safeEditMessage(chatId, messageId, text, options = {}) {
    try {
        await _bot.editMessageText(text, {
            chat_id: chatId,
            message_id: messageId,
            ...options
        });
    } catch (error) {
        if (error.message.includes('message to edit not found') ||
            error.message.includes('message not found') ||
            error.message.includes('MESSAGE_NOT_MODIFIED')) {
            console.log(`⚠️ Message edit failed for ${chatId}, sending new message instead`);
            await _bot.sendMessage(chatId, text, options);
        } else {
            throw error;
        }
    }
}

module.exports = { LRUCache, escapeHtml, safeEditMessage, init };

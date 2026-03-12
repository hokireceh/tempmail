'use strict';
const cloudscraper = require('cloudscraper');
const { TMAILOR_API } = require('./config');

const circuitBreaker = {
    failures: 0,
    lastFailure: 0,
    isOpen: false,
    threshold: 10,
    resetTimeout: 60000,

    recordSuccess() {
        this.failures = 0;
        this.isOpen = false;
    },

    recordFailure() {
        this.failures++;
        this.lastFailure = Date.now();
        if (this.failures >= this.threshold) {
            this.isOpen = true;
            console.warn('🔴 Circuit breaker OPEN - API calls paused for 60s');
        }
    },

    canRequest() {
        if (!this.isOpen) return true;
        if (Date.now() - this.lastFailure > this.resetTimeout) {
            this.isOpen = false;
            this.failures = 0;
            console.log('🟢 Circuit breaker CLOSED - resuming API calls');
            return true;
        }
        return false;
    }
};

async function createTempEmail() {
    try {
        const response = await cloudscraper.post(`${TMAILOR_API}`, {
            json: {
                action: 'newemail',
                curentToken: ''
            },
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
                'Origin': 'https://tmailor.com',
                'Referer': 'https://tmailor.com/'
            }
        });

        const data = typeof response === 'string' ? JSON.parse(response) : response;
        console.log('API Response:', JSON.stringify(data));

        if (data?.msg === 'ok' && data?.email) {
            console.log('✅ Temp email created:', data.email);
            return {
                email: data.email,
                code: data.code,
                token: data.accesstoken,
                created: new Date()
            };
        }
        console.error('Response:', data);
        throw new Error('Invalid response');
    } catch (error) {
        console.error('❌ Error:', error.message);
        throw error;
    }
}

async function getEmailBody(accessToken, emailUuid, emailId) {
    console.log('📧 Fetching email body with uuid:', emailUuid, 'email_id:', emailId);

    try {
        const response = await cloudscraper({
            method: 'POST',
            url: TMAILOR_API,
            json: {
                action: 'read',
                accesstoken: accessToken,
                email_token: emailId,
                email_code: emailUuid,
                wat: '',
                f: ''
            },
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
                'Origin': 'https://tmailor.com',
                'Referer': 'https://tmailor.com/'
            }
        });

        let data;
        if (typeof response === 'string') {
            if (response.trim() === '') return { body: '', links: [] };
            try {
                data = JSON.parse(response);
            } catch (parseErr) {
                console.log('📧 Failed to parse JSON:', parseErr.message);
                return { body: '', links: [] };
            }
        } else {
            data = response;
        }

        if (data?.msg === 'ok' && data?.data) {
            let body = data.data.body || data.data.content ||
                       data.data.text_body || data.data.textBody ||
                       data.data.message || data.data.text || '';

            const extractedLinks = [];

            if (body) {
                body = body
                    .replace(/<style[^>]*>.*?<\/style>/gis, '')
                    .replace(/<script[^>]*>.*?<\/script>/gis, '')
                    .replace(/<head[^>]*>.*?<\/head>/gis, '')
                    .replace(/<div[^>]*style="[^"]*display:\s*none[^"]*"[^>]*>.*?<\/div>/gis, '')
                    .replace(/<!--\[if[^\]]*\]>.*?<!\[endif\]-->/gis, '')
                    .replace(/<!--.*?-->/gs, '');

                body = body
                    .replace(/&nbsp;/g, ' ')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&quot;/g, '"')
                    .replace(/&#39;/g, "'")
                    .replace(/&#x27;/g, "'")
                    .replace(/&apos;/g, "'")
                    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
                    .replace(/&amp;/g, '&');

                body = body.replace(/<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/gis, (match, url, text) => {
                    const cleanText = text.replace(/<[^>]*>/g, '').trim();

                    if (url.match(/twitter\.com|facebook\.com|instagram\.com|linkedin\.com|youtube\.com|tiktok\.com|unsubscribe|preferences/i)) {
                        return '';
                    }

                    if (url.length > 40 || url.match(/verify|action|confirm|reset|activate|login|signin|code/i)) {
                        extractedLinks.push({ url, text: cleanText });
                        return `[LINK_${extractedLinks.length - 1}]`;
                    }

                    return cleanText || '';
                });

                body = body
                    .replace(/<\/tr>/gi, '\n')
                    .replace(/<\/td>/gi, ' ')
                    .replace(/<br\s*\/?>/gi, '\n')
                    .replace(/<\/p>/gi, '\n\n')
                    .replace(/<p[^>]*>/gi, '')
                    .replace(/<\/div>/gi, '\n')
                    .replace(/<div[^>]*>/gi, '')
                    .replace(/<\/h[1-6]>/gi, '\n\n')
                    .replace(/<h[1-6][^>]*>/gi, '\n');

                body = body.replace(/<[^>]*>/g, '');

                body = body
                    .replace(/[\u200B-\u200D\uFEFF\u2060\u2063\u180E]/g, '')
                    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
                    .replace(/[\u200E\u200F\u202A-\u202E]/g, '')
                    .replace(/[\u2028\u2029]/g, '\n')
                    .replace(/[\uFE00-\uFE0F]/g, '')
                    .replace(/[\u0300-\u036F]/g, '');

                const lines = body.split('\n');
                const filteredLines = [];
                let footerStarted = false;

                for (let line of lines) {
                    const trimmed = line.trim().toLowerCase();

                    if (trimmed.match(/^sent by |^this email was sent|^you're receiving this|^©.*all rights reserved/i)) {
                        footerStarted = true;
                        continue;
                    }

                    if (footerStarted) continue;

                    if (trimmed.match(/^\d{1,5}.*?(street|st\.|blvd\.?|ave\.?|road|rd\.?|suite|ste\.?|floor|fl\.?)/i)) {
                        continue;
                    }

                    if (trimmed.match(/unsubscribe|manage.*preferences|update.*settings/i)) {
                        continue;
                    }

                    filteredLines.push(line);
                }

                body = filteredLines.join('\n');

                extractedLinks.forEach((link, index) => {
                    body = body.replace(`[LINK_${index}]`, '');
                });

                body = body
                    .replace(/\r\n/g, '\n')
                    .replace(/\r/g, '\n')
                    .replace(/\t/g, ' ')
                    .replace(/[ ]{2,}/g, ' ')
                    .replace(/^ +/gm, '')
                    .replace(/ +$/gm, '')
                    .replace(/\n{4,}/g, '\n\n')
                    .trim();

                console.log('📧 Cleaned body length:', body.length);
                console.log('📧 Important links found:', extractedLinks.length);
            }

            return { body, links: extractedLinks };
        }

        return { body: '', links: [] };
    } catch (error) {
        console.error('❌ Error fetching email body:', error.message);
        return { body: '', links: [] };
    }
}

async function checkEmails(email, accessToken) {
    try {
        const response = await cloudscraper.post(`${TMAILOR_API}`, {
            json: {
                action: 'listinbox',
                accesstoken: accessToken
            },
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
                'Origin': 'https://tmailor.com',
                'Referer': 'https://tmailor.com/'
            }
        });

        const data = typeof response === 'string' ? JSON.parse(response) : response;
        console.log('✉️ Check emails response for', email + ':', JSON.stringify(data));

        if (data?.msg === 'ok') {
            if (data?.data === null || data?.data === undefined) {
                console.log('  → Inbox empty (data is null)');
                return [];
            }

            if (typeof data?.data === 'object' && !Array.isArray(data?.data)) {
                const emailsArray = Object.values(data.data);
                console.log('  → Found', emailsArray.length, 'emails (from object format)');
                return emailsArray;
            }

            if (Array.isArray(data?.data)) {
                console.log('  → Found', data.data.length, 'emails');
                return data.data;
            }
            console.log('  → Unexpected data format:', typeof data?.data);
            return [];
        } else {
            console.log('  ❌ API error:', data?.msg);
            return [];
        }
    } catch (error) {
        console.error('❌ Error checking emails:', error.message);
        return [];
    }
}

module.exports = { circuitBreaker, createTempEmail, getEmailBody, checkEmails };

# 📧 Telegram TempMail Bot

A powerful Telegram bot for creating and managing temporary/disposable email addresses with built-in admin broadcast functionality.

---

## 🔗 Links & Support

| Link | Description |
|------|-------------|
| **Bot**: [@tempatemailbot](https://t.me/tempatemailbot) | Try the bot on Telegram |
| **GitHub**: [hokireceh/tempmail](https://github.com/hokireceh/tempmail) | Source code repository |

### 💰 Support & Donate

Help support this project:

- **EVM Address**: `0xaFf68fFd9B57720018ea1e34b7B37637C022FACe`
- **TON Address**: `UQAN1eZ0Myj6JZ5nKREDKJjPJiZgRivPFwHpS19vuCa5CXy2`

---

## ✨ Features

### For Users
- ✅ Create temporary email addresses instantly
- ✅ Check incoming emails in real-time (auto-checks every 60 seconds)
- ✅ View email content with action links
- ✅ List and manage saved emails
- ✅ User-friendly menu-based interface

### For Admins
- ✅ Broadcast text messages to all users
- ✅ Broadcast media (photos, videos, documents, audio, animations)
- ✅ Real-time progress tracking
- ✅ Message preview before sending
- ✅ Auto-remove blocked users
- ✅ Smart retry on failed sends (up to 3 attempts)
- ✅ Rate limiting to prevent API issues
- ✅ Complete broadcast history

---

## 🛠️ Tech Stack

- **Runtime**: Node.js v20
- **Bot Framework**: node-telegram-bot-api
- **Database**: PostgreSQL
- **External API**: TMailor for temporary emails

---

## 📋 Commands

### User Commands
- `/start` - Show main menu
- `/menu` - Return to main menu

### Menu Options
1. **📧 Buat Email Baru** - Create new temporary email
2. **🔍 Cek Email Masuk** - Check incoming emails
3. **📋 Daftar Email Saya** - List your emails
4. **❓ Bantuan** - Get help
5. **📢 Broadcast** - Send broadcast (admins only)

### Admin Commands
- `/broadcast [message]` - Send text broadcast
  - Example: `/broadcast 📢 Hello everyone!`

---

## ⚙️ Environment Variables

**Required:**
- `TELEGRAM_BOT_TOKEN` - Get from [@BotFather](https://t.me/BotFather)
- `DATABASE_URL` - PostgreSQL connection (auto-provided by Replit)

**Optional:**
- `ADMIN_IDS` - Comma-separated admin IDs (e.g., "123456789,987654321")
- `TMAILOR_API` - TMailor endpoint (default: https://tmailor.com/api)
- `CHECK_INTERVAL` - Email check interval in ms (default: 60000)
- `BROADCAST_RATE_LIMIT` - Messages/second (default: 25)

---

## 📊 Database Schema

### `user_emails` Table
Stores temporary email accounts

| Column | Type | Description |
|--------|------|-------------|
| id | serial | Primary key |
| user_id | integer | Telegram user ID |
| email | varchar | Temporary email address |
| code | varchar | Email code from API |
| token | varchar | Access token for API |
| created_at | timestamp | Creation time |
| last_checked | timestamp | Last check time |

### `bot_users` Table
Tracks bot users

| Column | Type | Description |
|--------|------|-------------|
| user_id | integer | Primary key (Telegram ID) |
| username | varchar | Telegram username |
| first_name | varchar | User's first name |
| last_name | varchar | User's last name |
| created_at | timestamp | Registration time |
| last_interaction | timestamp | Last activity time |

### `broadcasts` Table
Logs broadcast messages

| Column | Type | Description |
|--------|------|-------------|
| id | serial | Primary key |
| admin_id | integer | Admin who sent broadcast |
| broadcast_type | varchar | 'text' or 'media' |
| content_text | text | Message content |
| media_file_id | varchar | Telegram file ID |
| media_type | varchar | photo, video, document, etc |
| total_users | integer | Users targeted |
| success_count | integer | Successful deliveries |
| failed_count | integer | Failed deliveries |
| created_at | timestamp | Broadcast time |
| completed_at | timestamp | Completion time |

---

## 🚀 Getting Started

### Prerequisites
- Node.js v20
- PostgreSQL database
- Telegram Bot API token

### Installation

1. Clone the repository
```bash
git clone https://github.com/hokireceh/tempmail.git
cd tempmail
```

2. Install dependencies
```bash
npm install
```

3. Set environment variables
```bash
export TELEGRAM_BOT_TOKEN="your_bot_token_here"
export ADMIN_IDS="123456789"  # Your Telegram user ID
```

4. Start the bot
```bash
npm start
```

---

## 📡 Broadcast Flow

1. Admin clicks **📢 Broadcast** button in menu
2. Bot asks for message or media
3. Admin sends text, photo, video, or document
4. Bot shows a preview of the message
5. Admin confirms with **✅ Ya, Kirim** button
6. Bot broadcasts to all users with:
   - Rate limiting (25 msg/sec)
   - Progress tracking (10%, 20%, 30%... 100%)
   - Smart retry on failures
   - Auto-cleanup of blocked users
7. Final report shows:
   - ✅ Successfully delivered
   - ❌ Failed (will retry)
   - 🚫 Blocked users (auto-removed)

---

## 🔐 Security Features

- **Protected Content**: Broadcast media can't be forwarded or downloaded
- **User Isolation**: Users only see their own emails
- **Admin Verification**: Broadcasts require explicit admin confirmation
- **Rate Limiting**: Prevents API abuse and Telegram rate limits
- **Auto-Cleanup**: Blocked users are automatically removed

---

## 📝 Project Structure

```
tempmail/
├── index.js                    # Main bot application
├── smartBroadcaster.js        # Broadcast service with queue & retry
├── db-init.js                 # Database initialization
├── package.json               # Dependencies
├── README.md                  # This file
└── replit.md                  # Technical documentation
```

---

## 🐛 Troubleshooting

**Bot not responding?**
- Check `TELEGRAM_BOT_TOKEN` is correct
- Verify bot is running: `npm start`

**Broadcast not working?**
- Ensure `ADMIN_IDS` contains your Telegram user ID
- Check user database isn't empty

**Email not checking?**
- Verify TMailor API is accessible
- Check `CHECK_INTERVAL` setting

---

## 📄 License

This project is open source. Feel free to use, modify, and distribute.

---

## 🙏 Contributors

Special thanks to all users and contributors!

**Made with ❤️** **HOKIRECEH**

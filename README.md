# MEE6 Rank Lookup Bot 📊 (Hybrid Edition)

A production-ready Discord bot that provides **instant rank lookups** with **real-time XP data** for servers with 250,000+ members using a hybrid database + live API approach.

## ✨ Features

- **⚡ Instant Rank**: <50ms rank lookup from database
- **🔴 Real-Time XP**: Live XP/Level data fetched on-demand
- **🎯 Smart Syncing**: Full sync every 60 mins + new user scans every 5 mins
- **💾 Hybrid Approach**: Database for ranks + API for fresh XP
- **📊 No Stale Data**: XP is always current from MEE6
- **🚀 Efficient**: Only 1 API call per user lookup (not 2500 pages!)
- **Dual Commands**: `/irank` (slash) and `irank!` (prefix)
- **Production Ready**: Handles 250K+ users with zero rate limiting issues

## ✨ Features

- **Dual Command Support**: `/irank` (slash) and `irank!` (prefix)
- **Smart Caching**: 60-second cache to minimize API calls
- **Request Throttling**: Queue system prevents API overload
- **Optimized Search**: Stops pagination once user is found
- **Error Handling**: Graceful handling of rate limits, private leaderboards, and API failures
- **Channel Restriction**: Configurable to work in specific channels only
- **Production Ready**: Logging, error recovery, and Docker support

## 🚀 Quick Start

### Prerequisites

- Node.js v16.11.0 or higher
- A Discord Bot Token ([Get one here](https://discord.com/developers/applications))
- Your Discord Server (Guild) ID
- MEE6 must be enabled on your server with a public leaderboard

### Installation

1. **Clone or download this project**

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**
   
   Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
   
   Edit `.env` with your values:
   ```env
   BOT_TOKEN=your_bot_token_here
   GUILD_ID=your_guild_id_here
   ALLOWED_CHANNEL_ID=your_channel_id_here
   ```

4. **Start the bot**
   ```bash
   npm start
   ```

## 🔧 Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BOT_TOKEN` | Yes | - | Your Discord bot token |
| `GUILD_ID` | Yes | - | Your Discord server ID |
| `ALLOWED_CHANNEL_ID` | No | All | Channel where bot responds |
| `INITIAL_SYNC_INTERVAL` | No | 60 | Minutes between full leaderboard syncs |
| `NEW_USER_SCAN_INTERVAL` | No | 5 | Minutes between new user scans (top 5K) |
| `DB_PATH` | No | `./mee6_ranks.db` | SQLite database file path |

### Getting IDs

- **Bot Token**: Discord Developer Portal → Your App → Bot → Token
- **Guild ID**: Enable Developer Mode in Discord → Right-click server → Copy ID
- **Channel ID**: Right-click channel → Copy ID

### Bot Permissions

Your bot needs these permissions:
- `Send Messages`
- `Embed Links`
- `Read Message History`
- `Use Slash Commands`

**Permission Integer**: `277025770496`

**Invite Link Template**:
```
https://discord.com/api/oauth2/authorize?client_id=YOUR_BOT_ID&permissions=277025770496&scope=bot%20applications.commands
```

## 📦 Deployment Options

### Option 1: VPS (Ubuntu/Debian)

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Clone your bot
git clone <your-repo-url>
cd mee6-rank-bot

# Install dependencies
npm install

# Create .env file
nano .env
# (paste your configuration)

# Install PM2 for process management
sudo npm install -g pm2

# Start bot with PM2
pm2 start index.js --name mee6-bot

# Auto-restart on server reboot
pm2 startup
pm2 save

# View logs
pm2 logs mee6-bot
```

### Option 2: Docker

```bash
# Build image
docker build -t mee6-rank-bot .

# Run container
docker run -d \
  --name mee6-bot \
  --env-file .env \
  --restart unless-stopped \
  mee6-rank-bot

# View logs
docker logs -f mee6-bot
```

### Option 3: Railway.app

1. Create account at [railway.app](https://railway.app)
2. Click "New Project" → "Deploy from GitHub repo"
3. Select your repository
4. Add environment variables:
   - `BOT_TOKEN`
   - `GUILD_ID`
   - `ALLOWED_CHANNEL_ID`
5. Deploy!

### Option 4: Fly.io

```bash
# Install flyctl
curl -L https://fly.io/install.sh | sh

# Login
flyctl auth login

# Launch app
flyctl launch

# Set secrets
flyctl secrets set BOT_TOKEN=your_token_here
flyctl secrets set GUILD_ID=your_guild_id
flyctl secrets set ALLOWED_CHANNEL_ID=your_channel_id

# Deploy
flyctl deploy
```

Create `fly.toml`:
```toml
app = "mee6-rank-bot"

[build]
  image = "mee6-rank-bot:latest"

[[services]]
  internal_port = 8080
  protocol = "tcp"
```

## 🎯 Usage

### User Commands

**Check your rank (Hybrid: Instant rank + Real-time XP)**
```
/irank
```
or
```
irank!
```

### Response Details

The bot uses a **hybrid approach**:

1. **Rank** 🏆 - From database (instant, <50ms)
2. **Level** ⭐ - Live from MEE6 API (real-time)
3. **XP** 💎 - Live from MEE6 API (real-time)
4. **Messages** 💬 - Live from MEE6 API (real-time)

**Status Indicators:**
- 🟢 **"Live data"** - Just fetched from MEE6 (real-time XP)
- 🟡 **"Updated Xm ago"** - From database (fallback if API fails)

### Example Response
```
📊 MEE6 Rank Lookup
YourName#1234

🏆 Rank: #384       (from database - instant)
⭐ Level: 19        (from MEE6 - real-time)
💎 XP: 15,234       (from MEE6 - real-time)
💬 Messages: 1,542  (from MEE6 - real-time)

🟢 Live data • Hybrid: DB rank + Live XP
```

## 🔍 How It Works

### Caching Strategy
- Results cached for 60 seconds per user
- Automatic cache cleanup every 5 minutes
- Drastically reduces API calls for repeated lookups

### Request Throttling
- Maximum 5 concurrent MEE6 API requests
- 200ms delay between requests
- Queue system prevents rate limiting

### Smart Pagination
- Fetches 100 users per page
- Stops immediately when user is found
- Won't scan entire 250K dataset unnecessarily

### Error Handling
- **User Not Found**: Clear message to gain XP first
- **Rate Limited**: Friendly retry message
- **Private Leaderboard**: Informs user about server settings
- **Wrong Channel**: Guides user to correct channel
- **API Errors**: Generic fallback with retry suggestion

## 📊 Performance

### ⚡ **Instant Lookups**
- **All users**: <50ms response time
- **Database indexed**: Rank, XP, Level for fast queries
- **No API calls**: Everything from local SQLite database

### 🔄 **Background Sync**
The bot automatically syncs the entire MEE6 leaderboard:
- **First sync**: ~10-30 minutes (one-time on startup)
- **250K users**: ~15-20 minutes per sync
- **Runs in background**: Doesn't block user commands
- **Scheduled**: Every 30-60 minutes (configurable)

### 💡 **How It Works**
1. Bot fetches entire MEE6 leaderboard (all pages)
2. Stores in SQLite with indexes
3. User runs `/irank` → instant database lookup
4. Data is 0-60 minutes old (depends on sync interval)

### 📈 **Comparison**

| Method | Speed | Freshness | Rate Limits |
|--------|-------|-----------|-------------|
| **Database (This)** | <50ms | 0-60m old | None |
| API Direct | 1-180s | Real-time | Yes (429 errors) |
| API with Cache | 1-180s first, instant repeat | Real-time | Reduced |

**Result**: This is 100-3600x faster for all users! 🚀

## 🐛 Troubleshooting

### Bot doesn't respond
- Check bot is online: `BOT_TOKEN` is correct
- Verify bot has permissions in channel
- Check `ALLOWED_CHANNEL_ID` matches your test channel

### "Database is being set up" message
- **First startup**: Initial sync takes 10-30 minutes for 250K users
- Check console logs for sync progress
- Shows: `📥 Synced page X | Total users: Y`
- Be patient - this is one-time!

### "User not found" but I'm active
- You might be a new user not yet in database
- Wait 5 minutes for next new user scan
- Or wait for next full sync
- New active users (top 5K) are added every 5 minutes

### XP seems outdated
- Should NEVER happen - XP is fetched live!
- If you see 🟡 "Updated Xm ago" → MEE6 API had issues
- Try command again
- If persists, check MEE6 leaderboard is public

### Slow initial sync (first run)
- Normal for large servers (10-30 minutes for 250K)
- Check console for progress: `📥 Synced page X`
- If stuck, verify MEE6 leaderboard is public
- Visit `https://mee6.xyz/leaderboard/YOUR_GUILD_ID`

### New users not appearing
- New user scan runs every 5 minutes (top 5K)
- Users ranked >5000 need to wait for full sync (60 mins)
- Adjust `NEW_USER_SCAN_INTERVAL` to scan more often
- Or adjust to scan more pages (edit code line ~285)

### Database file growing large
- Normal: ~50-100MB for 250K users
- Stored at `DB_PATH` location
- Can be safely deleted - bot will rebuild
- Consider backing up periodically

## 📝 Customization

### Adjust Sync Intervals

Edit `.env`:

```env
# Full sync every 2 hours (less frequent)
INITIAL_SYNC_INTERVAL=120

# New user scan every 10 minutes (less frequent)
NEW_USER_SCAN_INTERVAL=10
```

**Full Sync Recommendations**:
- **60 minutes**: Balanced (default)
- **120 minutes**: Less API load, ranks may drift slightly
- **30 minutes**: Very up-to-date, more API calls

**New User Scan Recommendations**:
- **5 minutes**: Catches new users quickly (default)
- **10 minutes**: Less frequent, still good
- **2-3 minutes**: Very aggressive, for highly active servers

### Scan More Pages for New Users

Edit `index.js` around line 285:

```javascript
const pagesToScan = 10; // Scan top 10K users instead of 5K
```

**Trade-off**: More pages = longer scan time but catches users ranked lower

### Change Database Location

Edit `.env`:
```env
DB_PATH=/var/data/mee6_ranks.db  # Custom path
```

### Modify Embed Colors

Edit `index.js` around line 305:

```javascript
.setColor(userData.isLive ? '#57F287' : '#5865F2')
// Green for live data, blue for cached
// Try: '#FF6B6B' (red), '#FFD43B' (yellow)
```

## 🤝 Support

For issues or questions:
1. Check this README first
2. Review error messages in console
3. Verify your `.env` configuration
4. Check MEE6 leaderboard is public

## 📄 License

MIT License - feel free to modify and use!

## 🌟 Credits

Built for high-performance Discord servers with large member counts.
const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require('discord.js');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
require('dotenv').config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// ============ CONFIGURATION ============
const BOT_TOKEN = process.env.BOT_TOKEN;
const MEE6_SERVER_ID = process.env.MEE6_SERVER_ID || '1308889840808366110';
const MY_SERVER_ID = process.env.MY_SERVER_ID;
const ALLOWED_CHANNEL_ID = process.env.ALLOWED_CHANNEL_ID;
const INITIAL_SYNC_INTERVAL = parseInt(process.env.INITIAL_SYNC_INTERVAL) || 60;
const NEW_USER_SCAN_INTERVAL = parseInt(process.env.NEW_USER_SCAN_INTERVAL) || 5;
const DB_PATH = process.env.DB_PATH || './mee6_ranks.db';
const MEE6_TOKEN = process.env.MEE6_TOKEN;

let db;
let isSyncing = false;

// ============ DATABASE INITIALIZATION ============
async function initDatabase() {
  db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS leaderboard (
      user_id TEXT PRIMARY KEY, username TEXT, discriminator TEXT, avatar TEXT,
      rank INTEGER, level INTEGER, xp INTEGER, message_count INTEGER,
      last_updated INTEGER, is_live INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_rank ON leaderboard(rank);
    CREATE INDEX IF NOT EXISTS idx_xp ON leaderboard(xp DESC);
    CREATE TABLE IF NOT EXISTS sync_metadata (
      id INTEGER PRIMARY KEY CHECK (id = 1), last_full_sync INTEGER,
      last_new_user_scan INTEGER, total_users INTEGER, status TEXT
    );
    INSERT OR IGNORE INTO sync_metadata (id, last_full_sync, total_users, status)
    VALUES (1, 0, 0, 'pending');
  `);
  console.log('✅ Database initialized');
}

// ============ LIVE XP FETCH (BULLETPROOF VERSION) ============
async function fetchLiveUserData(targetUserId) {
  try {
    // [FIX 1] Cache Busting: Added &bust=${Date.now()} to force fresh data
    const response = await axios.get(
      `https://mee6.xyz/api/plugins/levels/leaderboard/${MEE6_SERVER_ID}?limit=1&user_id=${targetUserId}&bust=${Date.now()}`,
      { timeout: 5000, headers: { 'Authorization': MEE6_TOKEN } }
    );

    // [FIX 2] Strict ID Validation: Only accept data if ID matches exactly
    let player = null;
    // Check the 'players' array first (contains the actual search result)
    if (response.data && response.data.players) {
        player = response.data.players.find(p => p.id === targetUserId);
    }
    // Fallback to 'player' field ONLY if it matches the requested ID
    if (!player && response.data && response.data.player && response.data.player.id === targetUserId) {
        player = response.data.player;
    }

    if (player) {
       return {
        userId: player.id, username: player.username, avatar: player.avatar,
        level: player.level || 0, xp: player.xp || 0, messageCount: player.message_count || 0
       };
    }
    return null;
  } catch (error) {
      // console.error(error); // Uncomment for debugging
      return null;
  }
}

// ============ HYBRID LOOKUP ============
async function hybridUserLookup(userId) {
  try {
    // 1. Always check DB first for speed
    let dbUser = await db.get('SELECT * FROM leaderboard WHERE user_id = ?', userId);
    
    // 2. Try to get live data
    const liveData = await fetchLiveUserData(userId);

    // 3. If live fails, fall back to DB cache
    if (!liveData) {
      if (dbUser) return { ...dbUser, dataAge: Math.floor((Date.now() - dbUser.last_updated)/60000), isLive: false };
      return null;
    }

    // 4. Valid live data found, update DB
    let rank = dbUser ? dbUser.rank : 999999;
    // Only recalculate rank if XP changed significantly (saves CPU)
    if (!dbUser || Math.abs(dbUser.xp - liveData.xp) > 50) {
       const res = await db.get('SELECT COUNT(*) as rank FROM leaderboard WHERE xp > ?', liveData.xp);
       rank = (res.rank || 0) + 1;
    }

    await db.run(`INSERT OR REPLACE INTO leaderboard (user_id, username, avatar, rank, level, xp, message_count, last_updated, is_live) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [liveData.userId, liveData.username, liveData.avatar, rank, liveData.level, liveData.xp, liveData.messageCount, Date.now()]);

    return { ...liveData, rank, isLive: true };
  } catch (e) { console.error(e); return null; }
}

// ============ SYNC & SCAN ============
async function fullLeaderboardSync() {
  if (isSyncing) return; isSyncing = true;
  console.log(`\n🔄 Starting full sync...`);
  try {
    await db.run('UPDATE sync_metadata SET status = ? WHERE id = 1', 'syncing');
    let page = 0, total = 0, rank = 0, hasMore = true;
    await db.run('BEGIN TRANSACTION');
    while (hasMore && page < 2500) {
      try {
        const res = await axios.get(`https://mee6.xyz/api/plugins/levels/leaderboard/${MEE6_SERVER_ID}?page=${page}&limit=1000`, { timeout: 15000, headers: { 'Authorization': MEE6_TOKEN } });
        if (!res.data?.players?.length) { hasMore = false; break; }
        for (const p of res.data.players) {
          rank++; await db.run(`INSERT OR REPLACE INTO leaderboard (user_id, username, avatar, rank, level, xp, message_count, last_updated, is_live) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`, [p.id, p.username, p.avatar, rank, p.level, p.xp, p.message_count, Date.now()]);
        }
        total += res.data.players.length; console.log(`📥 Synced page ${page} | Total: ${total}`);
        if (res.data.players.length < 1000) hasMore = false;
        page++; await new Promise(r => setTimeout(r, 250));
      } catch (e) { if (e.response?.status === 429) await new Promise(r => setTimeout(r, 30000)); else if (e.response?.status === 401) { hasMore = false; break; } else page++; }
    }
    await db.run('COMMIT'); await db.run('UPDATE sync_metadata SET last_full_sync = ?, total_users = ?, status = ? WHERE id = 1', [Date.now(), total, 'completed']);
    console.log(`✅ Sync complete: ${total} users`);
  } catch (e) { await db.run('ROLLBACK'); } finally { isSyncing = false; }
}

async function scanForNewUsers() {
  try {
    for (let page = 0; page < 5; page++) {
      const res = await axios.get(`https://mee6.xyz/api/plugins/levels/leaderboard/${MEE6_SERVER_ID}?page=${page}&limit=1000`, { timeout: 10000, headers: { 'Authorization': MEE6_TOKEN } });
      if (!res.data?.players) break;
      for (const p of res.data.players) {
        if (!(await db.get('SELECT 1 FROM leaderboard WHERE user_id = ?', p.id))) {
           await db.run(`INSERT INTO leaderboard (user_id, username, avatar, rank, level, xp, message_count, last_updated, is_live) VALUES (?, ?, ?, 999999, ?, ?, ?, ?, 0)`, [p.id, p.username, p.avatar, p.level, p.xp, p.message_count, Date.now()]);
        }
      }
      await new Promise(r => setTimeout(r, 250));
    }
  } catch (e) {}
}

// ============ MAIN ============
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await initDatabase();
  const meta = await db.get('SELECT * FROM sync_metadata WHERE id = 1');
  if (!meta || meta.total_users === 0) fullLeaderboardSync();
  setInterval(fullLeaderboardSync, INITIAL_SYNC_INTERVAL * 60000);
  setInterval(scanForNewUsers, NEW_USER_SCAN_INTERVAL * 60000);
  try {
    await new REST({ version: '10' }).setToken(BOT_TOKEN).put(
      Routes.applicationGuildCommands(client.user.id, MY_SERVER_ID),
      { body: [new SlashCommandBuilder().setName('irank').setDescription('Check Rank')] }
    );
    console.log('✅ Commands registered');
  } catch (e) { console.error('Command register failed:', e); }
});

async function handleRankCommand(src, isMsg = false, userId) {
  if (ALLOWED_CHANNEL_ID && src.channelId !== ALLOWED_CHANNEL_ID) return (isMsg ? src.reply : src.reply.bind(src))({ embeds: [new EmbedBuilder().setColor('Red').setDescription(`Use <#${ALLOWED_CHANNEL_ID}>`)], ephemeral: !isMsg });
  
  try { if (!isMsg) await src.deferReply(); } catch (e) { return; } 
  const replyMsg = isMsg ? await src.reply('⚡ Checking...') : null;
  const edit = (d) => isMsg ? replyMsg.edit(d) : src.editReply(d);

  const data = await hybridUserLookup(userId);
  if (!data) return edit({ content: '', embeds: [new EmbedBuilder().setColor('Red').setDescription('You are not ranked yet. Chat more to gain XP!')] });

  const embed = new EmbedBuilder().setColor(data.isLive ? '#57F287' : '#5865F2')
    .setDescription(`**${data.username}**`)
    .addFields({ name: '🏆 Rank', value: `#${data.rank.toLocaleString()}`, inline: true }, { name: '⭐ Level', value: `${data.level}`, inline: true }, { name: '💎 XP', value: `${data.xp.toLocaleString()}`, inline: true })
    .setFooter({ text: data.isLive ? '🟢 Live Data' : `🟡 Cached Data (${data.dataAge}m ago)` }).setTimestamp();
  if (data.avatar) embed.setThumbnail(`https://cdn.discordapp.com/avatars/${data.userId}/${data.avatar}.png`);
  
  edit({ content: '', embeds: [embed] });
}

client.on('interactionCreate', async i => i.isChatInputCommand() && i.commandName === 'irank' && handleRankCommand(i, false, i.user.id));
client.on('messageCreate', async m => !m.author.bot && m.content.toLowerCase().startsWith('irank!') && handleRankCommand(m, true, m.author.id));
client.login(BOT_TOKEN);
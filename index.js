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
// IDs separated: Fetch from Symbiotic, register on YOUR server
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
  db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS leaderboard (
      user_id TEXT PRIMARY KEY,
      username TEXT,
      discriminator TEXT,
      avatar TEXT,
      rank INTEGER,
      level INTEGER,
      xp INTEGER,
      message_count INTEGER,
      last_updated INTEGER,
      is_live INTEGER DEFAULT 0
    );
    
    CREATE INDEX IF NOT EXISTS idx_rank ON leaderboard(rank);
    CREATE INDEX IF NOT EXISTS idx_xp ON leaderboard(xp DESC);
    
    CREATE TABLE IF NOT EXISTS sync_metadata (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_full_sync INTEGER,
      last_new_user_scan INTEGER,
      total_users INTEGER,
      status TEXT
    );
  `);

  await db.run(`
    INSERT OR IGNORE INTO sync_metadata (id, last_full_sync, total_users, status)
    VALUES (1, 0, 0, 'pending')
  `);

  console.log('✅ Database initialized');
}

// ============ LIVE XP FETCH (BULLETPROOF VERSION) ============
async function fetchLiveUserData(targetUserId) {
  try {
    // Added &bust=${Date.now()} to force MEE6 to give fresh data every time
    const response = await axios.get(
      `https://mee6.xyz/api/plugins/levels/leaderboard/${MEE6_SERVER_ID}?limit=1&user_id=${targetUserId}&bust=${Date.now()}`,
      {
        timeout: 5000,
        headers: { 'Authorization': MEE6_TOKEN },
      }
    );

    // Strict ID Validation: Finds the CORRECT user in the response
    let player = null;
    // 1. Check the 'players' array first (this is usually where the search result is)
    if (response.data && response.data.players) {
        player = response.data.players.find(p => p.id === targetUserId);
    }
    // 2. Fallback to 'player' field ONLY if it matches the requested ID exactly
    if (!player && response.data && response.data.player && response.data.player.id === targetUserId) {
        player = response.data.player;
    }

    if (player) {
       return {
        userId: player.id,
        username: player.username,
        avatar: player.avatar,
        level: player.level || 0,
        xp: player.xp || 0,
        messageCount: player.message_count || 0,
       };
    }
    return null;
  } catch (error) {
      return null;
  }
}

// ============ HYBRID LOOKUP ============
async function hybridUserLookup(userId) {
  try {
    // 1. Instant DB check
    let dbUser = await db.get('SELECT * FROM leaderboard WHERE user_id = ?', userId);

    // 2. Live API check
    const liveData = await fetchLiveUserData(userId);

    if (!liveData) {
      // If API fails, use DB cache if we have it
      if (dbUser) {
         return { 
             ...dbUser, 
             dataAge: Math.floor((Date.now() - dbUser.last_updated) / 60000), 
             isLive: false 
         };
      }
      return null;
    }

    // 3. Update DB with fresh data
    let currentRank = 999999;
    if (dbUser) {
        currentRank = dbUser.rank;
    }

    // Recalculate rank if it's a new user OR if XP changed significantly
    if (!dbUser || Math.abs(dbUser.xp - liveData.xp) > 50) {
       const result = await db.get('SELECT COUNT(*) as rank FROM leaderboard WHERE xp > ?', liveData.xp);
       currentRank = (result.rank || 0) + 1;
    }

    await db.run(`
      INSERT OR REPLACE INTO leaderboard 
      (user_id, username, avatar, rank, level, xp, message_count, last_updated, is_live)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      liveData.userId, 
      liveData.username, 
      liveData.avatar, 
      currentRank, 
      liveData.level, 
      liveData.xp, 
      liveData.messageCount, 
      Date.now(), 
      1
    ]);

    return { ...liveData, rank: currentRank, isLive: true };

  } catch (error) {
    console.error('Hybrid lookup error:', error);
    return null;
  }
}

// ============ FULL SYNC (BACKGROUND) ============
async function fullLeaderboardSync() {
  if (isSyncing) return;
  isSyncing = true;
  console.log(`\n🔄 Starting full sync...`);

  try {
    await db.run('UPDATE sync_metadata SET status = ? WHERE id = 1', 'syncing');
    let page = 0;
    let totalUsers = 0;
    let currentRank = 0;
    let hasMore = true;

    await db.run('BEGIN TRANSACTION');

    while (hasMore && page < 2500) {
      try {
        const response = await axios.get(
          `https://mee6.xyz/api/plugins/levels/leaderboard/${MEE6_SERVER_ID}?page=${page}&limit=1000`,
          {
            timeout: 15000,
            headers: { 'Authorization': MEE6_TOKEN },
          }
        );

        if (!response.data || !response.data.players || response.data.players.length === 0) {
          hasMore = false;
          break;
        }

        for (const player of response.data.players) {
          currentRank++;
          await db.run(`
            INSERT OR REPLACE INTO leaderboard 
            (user_id, username, discriminator, avatar, rank, level, xp, message_count, last_updated, is_live)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            player.id,
            player.username,
            player.discriminator || '0',
            player.avatar,
            currentRank,
            player.level,
            player.xp,
            player.message_count,
            Date.now(),
            0
          ]);
        }

        totalUsers += response.data.players.length;
        console.log(`📥 Synced page ${page} | Total users: ${totalUsers}`);

        if (response.data.players.length < 1000) hasMore = false;
        page++;
        await new Promise(resolve => setTimeout(resolve, 250));

      } catch (error) {
        if (error.response && error.response.status === 429) {
            await new Promise(resolve => setTimeout(resolve, 30000));
        } else if (error.response && error.response.status === 401) {
             hasMore = false;
             break;
        } else {
            page++;
        }
      }
    }

    await db.run('COMMIT');
    await db.run('UPDATE sync_metadata SET last_full_sync = ?, total_users = ?, status = ? WHERE id = 1', 
      [Date.now(), totalUsers, 'completed']);
    console.log(`✅ Full sync complete! ${totalUsers} users synced.`);

  } catch (error) {
    await db.run('ROLLBACK');
  } finally {
    isSyncing = false;
  }
}

// ============ NEW USER SCAN (BACKGROUND) ============
async function scanForNewUsers() {
  try {
      for (let page = 0; page < 5; page++) {
        const response = await axios.get(
            `https://mee6.xyz/api/plugins/levels/leaderboard/${MEE6_SERVER_ID}?page=${page}&limit=1000`,
            { timeout: 10000, headers: { 'Authorization': MEE6_TOKEN } }
        );
        if (!response.data?.players) break;
        
        for (const player of response.data.players) {
            const exists = await db.get('SELECT 1 FROM leaderboard WHERE user_id = ?', player.id);
            if (!exists) {
                 await db.run(`INSERT INTO leaderboard (user_id, username, avatar, rank, level, xp, message_count, last_updated, is_live) VALUES (?, ?, ?, 999999, ?, ?, ?, ?, 0)`,
                 [player.id, player.username, player.avatar, player.level, player.xp, player.message_count, Date.now()]);
            }
        }
        await new Promise(r => setTimeout(r, 250));
      }
  } catch (e) { /* Silent fail is fine for scanner */ }
}

// ============ BOT SETUP & COMMANDS ============
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await initDatabase();

  // Start background tasks
  const meta = await db.get('SELECT * FROM sync_metadata WHERE id = 1');
  if (!meta || meta.total_users === 0) fullLeaderboardSync();
  
  setInterval(fullLeaderboardSync, INITIAL_SYNC_INTERVAL * 60 * 1000);
  setInterval(scanForNewUsers, NEW_USER_SCAN_INTERVAL * 60 * 1000);

  // Register commands to YOUR server
  try {
    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, MY_SERVER_ID),
      { body: [new SlashCommandBuilder().setName('irank').setDescription('Check Symbiotic Rank')] }
    );
    console.log('✅ Slash commands registered');
  } catch (error) {
    console.error('❌ Command registration failed:', error);
  }
});

async function handleRankCommand(source, isMessage = false, userId) {
  // 1. Channel Check
  if (ALLOWED_CHANNEL_ID && source.channelId !== ALLOWED_CHANNEL_ID) {
      const err = new EmbedBuilder().setColor('Red').setDescription(`Wrong channel. Use <#${ALLOWED_CHANNEL_ID}>`);
      return isMessage ? source.reply({ embeds: [err] }) : source.reply({ embeds: [err], ephemeral: true });
  }

  // 2. Defer Reply
  try { if (!isMessage) await source.deferReply(); } catch (e) { return; }
  const replyMsg = isMessage ? await source.reply('⚡ Checking...') : null;

  const sendResponse = async (payload) => {
      if (isMessage && replyMsg) return replyMsg.edit(payload);
      return source.editReply(payload);
  };

  // 3. Fetch Data
  const userData = await hybridUserLookup(userId);

  if (!userData) {
      return sendResponse({ 
          content: '', 
          embeds: [new EmbedBuilder().setColor('#ED4245').setDescription('❌ You are not on the Symbiotic leaderboard yet.')] 
      });
  }

  // 4. Send Embed
  const embed = new EmbedBuilder()
    .setColor(userData.isLive ? '#57F287' : '#5865F2')
    .setTitle('📊 Symbiotic Rank Lookup')
    .setDescription(`**${userData.username}**`)
    .addFields(
      { name: '🏆 Rank', value: `#${userData.rank.toLocaleString()}`, inline: true },
      { name: '⭐ Level', value: `${userData.level}`, inline: true },
      { name: '💎 XP', value: `${userData.xp.toLocaleString()}`, inline: true }
    )
    .setFooter({ 
        text: userData.isLive ? '🟢 Live Data' : `🟡 Cached Data (${userData.dataAge}m old)` 
    })
    .setTimestamp();
  
  // Fixed: Uses confirmed userData.userId for avatar
  if (userData.avatar) {
      embed.setThumbnail(`https://cdn.discordapp.com/avatars/${userData.userId}/${userData.avatar}.png`);
  }

  await sendResponse({ content: '', embeds: [embed] });
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'irank') return;
  await handleRankCommand(interaction, false, interaction.user.id);
});

client.on('messageCreate', async (message) => {
  if (!message.author.bot && message.content.toLowerCase().startsWith('irank!')) {
     await handleRankCommand(message, true, message.author.id);
  }
});

client.login(BOT_TOKEN);
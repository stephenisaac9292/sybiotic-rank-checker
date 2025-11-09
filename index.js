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

// [UPDATED] SEPARATE IDs: One for MEE6 data, one for your bot's home
const MEE6_SERVER_ID = process.env.MEE6_SERVER_ID || '1308889840808366110'; // Symbiotic
const MY_SERVER_ID = process.env.MY_SERVER_ID; // Your personal server

const ALLOWED_CHANNEL_ID = process.env.ALLOWED_CHANNEL_ID;
const INITIAL_SYNC_INTERVAL = parseInt(process.env.INITIAL_SYNC_INTERVAL) || 60; // minutes
const NEW_USER_SCAN_INTERVAL = parseInt(process.env.NEW_USER_SCAN_INTERVAL) || 5; // minutes
const DB_PATH = process.env.DB_PATH || './mee6_ranks.db';
const MEE6_TOKEN = process.env.MEE6_TOKEN;

let db;
let lastFullSync = null;
let lastNewUserScan = null;
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
    CREATE INDEX IF NOT EXISTS idx_level ON leaderboard(level DESC);
    CREATE INDEX IF NOT EXISTS idx_updated ON leaderboard(last_updated DESC);

    CREATE TABLE IF NOT EXISTS sync_metadata (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_full_sync INTEGER,
      last_new_user_scan INTEGER,
      total_users INTEGER,
      sync_duration INTEGER,
      status TEXT
    );
  `);

  await db.run(`
    INSERT OR IGNORE INTO sync_metadata (id, last_full_sync, last_new_user_scan, total_users, sync_duration, status)
    VALUES (1, 0, 0, 0, 0, 'pending')
  `);

  console.log('✅ Database initialized');
}

// ============ LIVE XP FETCH (FROM SYMBIOTIC) ============
async function fetchLiveUserData(userId) {
  try {
    console.log(`[LIVE] Fetching real-time data for user ${userId}`);
    // [UPDATED] Uses MEE6_SERVER_ID to get correct data
    const response = await axios.get(
      `https://mee6.xyz/api/plugins/levels/leaderboard/${MEE6_SERVER_ID}?limit=1&user_id=${userId}`,
      {
        timeout: 8000,
        headers: { 'Authorization': MEE6_TOKEN },
      }
    );

    if (response.data && response.data.player) {
      const player = response.data.player;
      return {
        userId: player.id,
        username: player.username || 'Unknown',
        discriminator: player.discriminator || '0',
        avatar: player.avatar || null,
        level: player.level || 0,
        xp: player.xp || 0,
        messageCount: player.message_count || 0,
      };
    }
    return null;
  } catch (error) {
    console.error('[LIVE] Error fetching live data:', error.message);
    if (error.response && error.response.status === 401) {
        console.error('🚨 LIVE FETCH FAILED: MEE6 TOKEN EXPIRED! Update .env file.');
    }
    return null;
  }
}

// ============ HYBRID LOOKUP ============
async function hybridUserLookup(userId) {
  try {
    // 1. Instant DB check
    let dbUser = await db.get('SELECT * FROM leaderboard WHERE user_id = ?', userId);

    // 2. Live API check (on Symbiotic server)
    const liveData = await fetchLiveUserData(userId);

    if (!liveData) {
      // If API fails but we have old data, show it as cached
      if (dbUser) {
         const dataAge = Math.floor((Date.now() - dbUser.last_updated) / 1000 / 60);
         return { 
             rank: dbUser.rank,
             level: dbUser.level,
             xp: dbUser.xp,
             username: dbUser.username,
             avatar: dbUser.avatar,
             messageCount: dbUser.message_count,
             dataAge: dataAge,
             isLive: false 
         };
      }
      return null;
    }

    // 3. Update DB with fresh data
    // Calculate rank if new user, otherwise use existing (will be corrected by next full sync if wrong)
    let currentRank = 999999;
    if (dbUser) {
        currentRank = dbUser.rank;
    }

    if (!dbUser) {
         console.log(`[NEW USER] Adding ${userId} to database`);
         // Calculate actual rank based on XP for new user
         currentRank = await calculateUserRank(liveData.xp);
    } else if (Math.abs(dbUser.xp - liveData.xp) > 10) {
         // Recalculate rank if XP changed significantly
         currentRank = await calculateUserRank(liveData.xp);
    }

    await db.run(`
      INSERT OR REPLACE INTO leaderboard 
      (user_id, username, discriminator, avatar, rank, level, xp, message_count, last_updated, is_live)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      liveData.userId, 
      liveData.username, 
      liveData.discriminator,
      liveData.avatar, 
      currentRank, 
      liveData.level, 
      liveData.xp, 
      liveData.messageCount, 
      Date.now(), 
      1
    ]);

    return {
        rank: currentRank,
        level: liveData.level,
        xp: liveData.xp,
        username: liveData.username,
        avatar: liveData.avatar,
        messageCount: liveData.messageCount,
        dataAge: 0,
        isLive: true,
    };

  } catch (error) {
    console.error('[HYBRID] Lookup error:', error);
    return null;
  }
}

// Calculate user's rank based on their XP
async function calculateUserRank(userXp) {
  try {
    const result = await db.get(
      'SELECT COUNT(*) as rank FROM leaderboard WHERE xp > ?',
      userXp
    );
    return (result.rank || 0) + 1;
  } catch (error) {
    console.error('[RANK CALC] Error:', error);
    return 999999;
  }
}

// ============ FULL LEADERBOARD SYNC ============
async function fullLeaderboardSync() {
  if (isSyncing) {
      console.log('⏭️ Sync already in progress, skipping...');
      return;
  }
  isSyncing = true;
  const startTime = Date.now();
  console.log(`\n🔄 Starting full sync from Symbiotic (${MEE6_SERVER_ID})...`);

  try {
    await db.run('UPDATE sync_metadata SET status = ? WHERE id = 1', 'syncing');
    let page = 0;
    let totalUsers = 0;
    let hasMore = true;
    let currentRank = 0;

    await db.run('BEGIN TRANSACTION');

    while (hasMore && page < 2500) {
      try {
        // [UPDATED] Uses MEE6_SERVER_ID
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

        const players = response.data.players;

        for (const player of players) {
          currentRank++;
          await db.run(`
            INSERT OR REPLACE INTO leaderboard 
            (user_id, username, discriminator, avatar, rank, level, xp, message_count, last_updated, is_live)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            player.id,
            player.username || 'Unknown',
            player.discriminator || '0',
            player.avatar || null,
            currentRank,
            player.level || 0,
            player.xp || 0,
            player.message_count || 0,
            Date.now(),
            0
          ]);
        }

        totalUsers += players.length;
        console.log(`📥 Synced page ${page + 1} | Total users: ${totalUsers} | Rank: #${currentRank}`);

        if (players.length < 1000) hasMore = false;
        page++;
        await new Promise(resolve => setTimeout(resolve, 200)); // Rate limit protection

      } catch (error) {
        console.error(`❌ Error syncing page ${page}:`, error.message);
        if (error.response && error.response.status === 429) {
            console.log('⏸️ Rate limited by MEE6, waiting 30s...');
            await new Promise(resolve => setTimeout(resolve, 30000));
        } else if (error.response && error.response.status === 401) {
             console.error('🚨 SYNC STOPPED: MEE6 TOKEN EXPIRED! Update your .env file.');
             hasMore = false;
             break;
        } else {
            page++;
        }
      }
    }

    await db.run('COMMIT');
    const syncDuration = Math.floor((Date.now() - startTime) / 1000);
    lastFullSync = Date.now();

    await db.run(`
      UPDATE sync_metadata 
      SET last_full_sync = ?, total_users = ?, sync_duration = ?, status = ?
      WHERE id = 1
    `, [lastFullSync, totalUsers, syncDuration, 'completed']);

    console.log(`✅ Full sync completed! ${totalUsers} users synced in ${syncDuration}s`);
    console.log(`⏰ Next full sync in ${INITIAL_SYNC_INTERVAL} minutes\n`);

  } catch (error) {
    await db.run('ROLLBACK');
    await db.run('UPDATE sync_metadata SET status = ? WHERE id = 1', 'failed');
    console.error('❌ Full sync failed:', error.message);
  } finally {
    isSyncing = false;
  }
}

// ============ NEW USER SCANNER ============
async function scanForNewUsers() {
  console.log('\n🔍 Scanning for new users (top 5000)...');
  try {
      let newUsersFound = 0;
      const pagesToScan = 5; // Check top 5000 users
      for (let page = 0; page < pagesToScan; page++) {
        const response = await axios.get(
            `https://mee6.xyz/api/plugins/levels/leaderboard/${MEE6_SERVER_ID}?page=${page}&limit=1000`,
            { timeout: 10000, headers: { 'Authorization': MEE6_TOKEN } }
        );
        if (!response.data || !response.data.players) break;
        
        for (const player of response.data.players) {
            const exists = await db.get('SELECT user_id FROM leaderboard WHERE user_id = ?', player.id);
            if (!exists) {
                 const rank = await calculateUserRank(player.xp || 0);
                 await db.run(`
                    INSERT INTO leaderboard 
                    (user_id, username, discriminator, avatar, rank, level, xp, message_count, last_updated, is_live)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 `, [
                    player.id, player.username || 'Unknown', player.discriminator || '0', player.avatar || null,
                    rank, player.level || 0, player.xp || 0, player.message_count || 0, Date.now(), 0
                 ]);
                 newUsersFound++;
            }
        }
        await new Promise(r => setTimeout(r, 200));
      }
      lastNewUserScan = Date.now();
      await db.run('UPDATE sync_metadata SET last_new_user_scan = ? WHERE id = 1', lastNewUserScan);
      console.log(`✅ New user scan complete. Found ${newUsersFound} new users\n`);

  } catch (error) {
    console.error('❌ New user scan failed:', error.message);
    if (error.response && error.response.status === 401) {
        console.error('🚨 SCAN FAILED: MEE6 TOKEN EXPIRED! Update your .env file.');
    }
  }
}

// ============ EMBED BUILDER ============
function createRankEmbed(userData) {
  const statusEmoji = userData.isLive ? '🟢' : '🟡';
  const statusText = userData.isLive ? 'Live data' : `Updated ${userData.dataAge}m ago`;

  const embed = new EmbedBuilder()
    .setColor(userData.isLive ? '#57F287' : '#5865F2')
    .setTitle('📊 Symbiotic Rank Lookup')
    .setDescription(`**${userData.username}**`)
    .addFields(
      { name: '🏆 Rank', value: `#${userData.rank.toLocaleString()}`, inline: true },
      { name: '⭐ Level', value: `${userData.level}`, inline: true },
      { name: '💎 XP', value: `${userData.xp.toLocaleString()}`, inline: true }
    );

  if (userData.messageCount) {
    embed.addFields({
      name: '💬 Messages',
      value: `${userData.messageCount.toLocaleString()}`,
      inline: true
    });
  }

  embed.setFooter({ 
    text: `${statusEmoji} ${statusText} • Hybrid: DB rank + Live XP` 
  });
  embed.setTimestamp();

  if (userData.avatar) {
    embed.setThumbnail(`https://cdn.discordapp.com/avatars/${userData.userId}/${userData.avatar}.png`);
  }

  return embed;
}

function createErrorEmbed(errorType, extraInfo = '') {
  const embed = new EmbedBuilder()
    .setColor('#ED4245')
    .setTitle('❌ Error');

  switch (errorType) {
    case 'USER_NOT_FOUND':
      embed.setDescription('You are not ranked on the Symbiotic leaderboard yet.');
      break;
    case 'DB_NOT_READY':
      embed.setDescription(`Database is being set up. Please try again in a few minutes.\n\n${extraInfo}`);
      break;
    case 'WRONG_CHANNEL':
      embed.setDescription(`This command can only be used in <#${ALLOWED_CHANNEL_ID}>.`);
      break;
    default:
      embed.setDescription('An error occurred while fetching your rank. Please try again later.');
  }

  return embed;
}

// ============ BOT EVENTS ============
client.once('ready', async () => {
  console.log(`\n✅ Logged in as: ${client.user.tag}`);
  console.log(`📡 Fetching data from Symbiotic Server ID: ${MEE6_SERVER_ID}`);
  console.log(`🏠 Operating in Your Personal Server ID: ${MY_SERVER_ID}`);

  if (!MEE6_TOKEN) console.warn('⚠️ WARNING: MEE6_TOKEN is missing! Sync will fail.');
  if (!MY_SERVER_ID) {
      console.error('❌ FATAL ERROR: MY_SERVER_ID is missing in .env! Cannot register commands.');
      process.exit(1);
  }

  await initDatabase();

  // Start initial sync if DB is empty
  const meta = await db.get('SELECT * FROM sync_metadata WHERE id = 1');
  if (!meta || meta.total_users === 0) {
      console.log('🚀 First run detected. Starting initial full sync...');
      fullLeaderboardSync().catch(console.error);
  } else {
      console.log(`📊 Database loaded: ${meta.total_users} users`);
      console.log('✅ Bot ready for commands!\n');
  }

  // Schedule background tasks
  setInterval(() => {
      console.log(`⏰ Scheduled full sync starting...`);
      fullLeaderboardSync().catch(console.error);
  }, INITIAL_SYNC_INTERVAL * 60 * 1000);

  setInterval(() => {
      console.log(`⏰ Scanning for new users...`);
      scanForNewUsers().catch(console.error);
  }, NEW_USER_SCAN_INTERVAL * 60 * 1000);

  // [UPDATED] Register commands to YOUR personal server
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  try {
    console.log(`🔄 Registering slash commands to YOUR server (${MY_SERVER_ID})...`);
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, MY_SERVER_ID),
      { body: [new SlashCommandBuilder().setName('irank').setDescription('Check Symbiotic Rank')] }
    );
    console.log('✅ Slash commands registered successfully!\n');
  } catch (error) {
    console.error('❌ Command registration failed:', error);
  }

  client.user.setActivity('irank! | /irank', { type: 'WATCHING' });
});

// Unified Command Processor
async function handleRankCommand(source, isMessage = false, userId) {
  if (ALLOWED_CHANNEL_ID && source.channelId !== ALLOWED_CHANNEL_ID) {
      const errEmbed = createErrorEmbed('WRONG_CHANNEL');
      return isMessage ? source.reply({ embeds: [errEmbed] }) : source.reply({ embeds: [errEmbed], ephemeral: true });
  }

  // Defer Reply
  if (isMessage) {
      var loadingMsg = await source.reply('⚡ Fetching rank...');
  } else {
      await source.deferReply();
  }

  // Helper to edit response
  const sendResponse = async (payload) => {
      if (isMessage && loadingMsg) return loadingMsg.edit(payload);
      return isMessage ? source.channel.send(payload) : source.editReply(payload);
  };

  try {
      const metadata = await db.get('SELECT * FROM sync_metadata WHERE id = 1');
      if (!metadata || metadata.total_users === 0) {
          return sendResponse({ embeds: [createErrorEmbed('DB_NOT_READY', 'Initial sync in progress.')] });
      }

      const userData = await hybridUserLookup(userId);
      if (!userData) {
          return sendResponse({ embeds: [createErrorEmbed('USER_NOT_FOUND')] });
      }

      await sendResponse({ content: '', embeds: [createRankEmbed(userData)] });

  } catch (error) {
      console.error('Command error:', error);
      await sendResponse({ embeds: [createErrorEmbed('GENERIC')] });
  }
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

process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down...');
  if (db) {
    await db.close();
    console.log('💾 Database closed');
  }
  process.exit(0);
});

process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled promise rejection:', error);
});

client.login(BOT_TOKEN);
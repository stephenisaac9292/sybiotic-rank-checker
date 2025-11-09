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
    GatewayIntentBits.GuildMembers, // Added this just in case, good for member caching
  ],
});

// ============ CONFIGURATION ============
const BOT_TOKEN = process.env.BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const ALLOWED_CHANNEL_ID = process.env.ALLOWED_CHANNEL_ID;
const INITIAL_SYNC_INTERVAL = parseInt(process.env.INITIAL_SYNC_INTERVAL) || 60; // minutes - full sync
const NEW_USER_SCAN_INTERVAL = parseInt(process.env.NEW_USER_SCAN_INTERVAL) || 5; // minutes - check for new users
const DB_PATH = process.env.DB_PATH || './mee6_ranks.db';
const MEE6_TOKEN = process.env.MEE6_TOKEN; // <--- [IMPLEMENTED]

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
  `);

  console.log('✅ Database initialized');
  
  await db.exec(`
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
}

// ============ LIVE XP FETCH (Real-time from MEE6 API) ============
async function fetchLiveUserData(guildId, userId) {
  try {
    console.log(`[LIVE] Fetching real-time data for user ${userId}`);
    
    // Try direct user lookup endpoint
    const response = await axios.get(
      `https://mee6.xyz/api/plugins/levels/leaderboard/${guildId}?limit=1&user_id=${userId}`,
      {
        timeout: 8000,
        headers: {
          'Authorization': MEE6_TOKEN, // <--- [IMPLEMENTED]
        },
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
        console.error('🚨 MEE6 TOKEN INVALID OR EXPIRED! Check your .env file.');
    }
    return null;
  }
}

// ============ HYBRID LOOKUP: Database Rank + Live XP ============
async function hybridUserLookup(userId) {
  try {
    // Step 1: Get user's rank from database (instant)
    let dbUser = await db.get(
      'SELECT * FROM leaderboard WHERE user_id = ?',
      userId
    );

    // Step 2: Fetch live XP data from MEE6 API
    const liveData = await fetchLiveUserData(GUILD_ID, userId);

    if (!liveData) {
      // If live fetch fails, return database data (if exists)
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
          isLive: false,
        };
      }
      return null;
    }

    // Step 3: Update database with fresh data
    if (!dbUser) {
      // New user - add to database and trigger rank calculation
      console.log(`[NEW USER] Adding ${userId} to database`);
      
      await db.run(`
        INSERT INTO leaderboard 
        (user_id, username, discriminator, avatar, rank, level, xp, message_count, last_updated, is_live)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        liveData.userId,
        liveData.username,
        liveData.discriminator,
        liveData.avatar,
        999999, // Temporary rank, will be calculated
        liveData.level,
        liveData.xp,
        liveData.messageCount,
        Date.now(),
        1
      ]);

      // Calculate actual rank based on XP
      const rank = await calculateUserRank(liveData.xp);
      
      await db.run(
        'UPDATE leaderboard SET rank = ? WHERE user_id = ?',
        [rank, userId]
      );

      dbUser = await db.get('SELECT * FROM leaderboard WHERE user_id = ?', userId);
    } else {
      // Existing user - update with live data
      await db.run(`
        UPDATE leaderboard 
        SET username = ?, avatar = ?, level = ?, xp = ?, message_count = ?, last_updated = ?, is_live = 1
        WHERE user_id = ?
      `, [
        liveData.username,
        liveData.avatar,
        liveData.level,
        liveData.xp,
        liveData.messageCount,
        Date.now(),
        userId
      ]);

      // Recalculate rank if XP changed significantly
      if (Math.abs(dbUser.xp - liveData.xp) > 100) {
        const newRank = await calculateUserRank(liveData.xp);
        await db.run('UPDATE leaderboard SET rank = ? WHERE user_id = ?', [newRank, userId]);
        dbUser.rank = newRank;
      }
    }

    return {
      rank: dbUser.rank,
      level: liveData.level,
      xp: liveData.xp,
      username: liveData.username,
      avatar: liveData.avatar,
      messageCount: liveData.messageCount,
      dataAge: 0, // Real-time data
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

// ============ INITIAL FULL SYNC (One-time or periodic) ============
async function fullLeaderboardSync() {
  if (isSyncing) {
    console.log('⏭️ Sync already in progress, skipping...');
    return;
  }

  isSyncing = true;
  const startTime = Date.now();
  console.log('\n🔄 Starting full leaderboard sync...');

  try {
    await db.run('UPDATE sync_metadata SET status = ? WHERE id = 1', 'syncing');

    let page = 0;
    let totalUsers = 0;
    let hasMore = true;
    let currentRank = 0;

    await db.run('BEGIN TRANSACTION');

    while (hasMore && page < 2500) {
      try {
        const response = await axios.get(
          `https://mee6.xyz/api/plugins/levels/leaderboard/${GUILD_ID}?page=${page}&limit=1000`,
          {
            timeout: 15000,
            headers: {
              'Authorization': MEE6_TOKEN, // <--- [IMPLEMENTED]
            },
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

        if (players.length < 1000) {
          hasMore = false;
        }

        page++;
        await new Promise(resolve => setTimeout(resolve, 200));

      } catch (error) {
        console.error(`❌ Error syncing page ${page}:`, error.message);
        
        if (error.response?.status === 429) {
          console.log('⏸️ Rate limited, waiting 30 seconds...');
          await new Promise(resolve => setTimeout(resolve, 30000));
          continue;
        }
        if (error.response?.status === 401) {
             console.error('🚨 SYNC STOPPED: MEE6 TOKEN EXPIRED! Update your .env file.');
             hasMore = false;
             break;
        }
        
        page++;
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

// ============ SCAN FOR NEW USERS (Top pages only) ============
async function scanForNewUsers() {
  console.log('\n🔍 Scanning for new users (top 5000)...');
  
  try {
    let newUsersFound = 0;
    const pagesToScan = 5; // Check top 5000 users (5 pages × 1000)

    for (let page = 0; page < pagesToScan; page++) {
      const response = await axios.get(
        `https://mee6.xyz/api/plugins/levels/leaderboard/${GUILD_ID}?page=${page}&limit=1000`,
        {
          timeout: 10000,
          headers: {
            'Authorization': MEE6_TOKEN, // <--- [IMPLEMENTED]
          },
        }
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
            player.id,
            player.username || 'Unknown',
            player.discriminator || '0',
            player.avatar || null,
            rank,
            player.level || 0,
            player.xp || 0,
            player.message_count || 0,
            Date.now(),
            0
          ]);

          newUsersFound++;
        }
      }

      await new Promise(resolve => setTimeout(resolve, 200));
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
    .setTitle('📊 MEE6 Rank Lookup')
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
    embed.setThumbnail(`https://cdn.discordapp.com/avatars/${userData.userId || 'default'}/${userData.avatar}.png`);
  }

  return embed;
}

function createErrorEmbed(errorType, extraInfo = '') {
  const embed = new EmbedBuilder()
    .setColor('#ED4245')
    .setTitle('❌ Error');

  switch (errorType) {
    case 'USER_NOT_FOUND':
      embed.setDescription('You are not ranked on the MEE6 leaderboard yet. Send some messages to gain XP!');
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

// ============ COMMAND HANDLER ============
async function handleRankCommand(interaction, userId) {
  if (ALLOWED_CHANNEL_ID && interaction.channelId !== ALLOWED_CHANNEL_ID) {
    return interaction.reply({
      embeds: [createErrorEmbed('WRONG_CHANNEL')],
      ephemeral: true,
    });
  }

  await interaction.deferReply();

  try {
    // Check if initial sync is done
    const metadata = await db.get('SELECT * FROM sync_metadata WHERE id = 1');
    
    if (!metadata || metadata.total_users === 0) {
      return interaction.editReply({
        embeds: [createErrorEmbed('DB_NOT_READY', 'Initial sync in progress. Check console for status.')],
      });
    }

    // Hybrid lookup: DB rank + Live XP
    const userData = await hybridUserLookup(userId);

    if (!userData) {
      return interaction.editReply({
        embeds: [createErrorEmbed('USER_NOT_FOUND')],
      });
    }

    const embed = createRankEmbed(userData);
    await interaction.editReply({
      embeds: [embed],
    });

  } catch (error) {
    console.error('Command error:', error);
    await interaction.editReply({
      embeds: [createErrorEmbed('GENERIC')],
    });
  }
}

// ============ BOT EVENTS ============
client.once('ready', async () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);
  console.log(`📊 Monitoring guild: ${GUILD_ID}`);
  console.log(`📢 Allowed channel: ${ALLOWED_CHANNEL_ID || 'ALL'}`);
  console.log(`🔄 Full sync interval: ${INITIAL_SYNC_INTERVAL} minutes`);
  console.log(`🔍 New user scan interval: ${NEW_USER_SCAN_INTERVAL} minutes`);
  console.log(`💾 Database: ${DB_PATH}`);
  console.log(`⚡ Mode: HYBRID (DB rank + Live XP)\n`);

  if (!MEE6_TOKEN) {
      console.warn('⚠️ WARNING: MEE6_TOKEN is missing from .env! Sync will likely fail with 401 errors.\n');
  }

  await initDatabase();

  // Check if initial sync needed
  const metadata = await db.get('SELECT * FROM sync_metadata WHERE id = 1');
  
  if (!metadata || metadata.total_users === 0) {
    console.log('🚀 First run detected. Starting initial full sync...');
    fullLeaderboardSync().catch(console.error);
  } else {
    console.log(`📊 Database loaded: ${metadata.total_users} users`);
    console.log('✅ Bot ready for commands!\n');
  }

  // Schedule periodic full sync
  setInterval(() => {
    console.log(`⏰ Scheduled full sync starting...`);
    fullLeaderboardSync().catch(console.error);
  }, INITIAL_SYNC_INTERVAL * 60 * 1000);

  // Schedule new user scanning (more frequent)
  setInterval(() => {
    console.log(`⏰ Scanning for new users...`);
    scanForNewUsers().catch(console.error);
  }, NEW_USER_SCAN_INTERVAL * 60 * 1000);

  // Register slash commands
  const commands = [
    new SlashCommandBuilder()
      .setName('irank')
      .setDescription('Check your MEE6 rank (instant!) and level (live!)'),
  ];

  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);

  try {
    console.log('🔄 Registering slash commands...');
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), {
      body: commands,
    });
    console.log('✅ Slash commands registered!\n');
  } catch (error) {
    console.error('❌ Failed to register slash commands:', error);
  }

  client.user.setActivity('irank! | /irank', { type: 'WATCHING' });
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'irank') {
    await handleRankCommand(interaction, interaction.user.id);
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.content.toLowerCase().startsWith('irank!')) return;

  if (ALLOWED_CHANNEL_ID && message.channelId !== ALLOWED_CHANNEL_ID) {
    return message.reply({
      embeds: [createErrorEmbed('WRONG_CHANNEL')],
    });
  }

  const fakeInteraction = {
    channelId: message.channelId,
    deferReply: async () => {
      fakeInteraction.loadingMessage = await message.reply('⚡ Fetching your rank...');
    },
    editReply: async (options) => {
      if (fakeInteraction.loadingMessage) {
        await fakeInteraction.loadingMessage.edit(options);
      }
    },
  };

  await fakeInteraction.deferReply();

  try {
    const metadata = await db.get('SELECT * FROM sync_metadata WHERE id = 1');
    
    if (!metadata || metadata.total_users === 0) {
      return fakeInteraction.editReply({
        embeds: [createErrorEmbed('DB_NOT_READY', 'Initial sync in progress.')],
      });
    }

    const userData = await hybridUserLookup(message.author.id);

    if (!userData) {
      return fakeInteraction.editReply({
        embeds: [createErrorEmbed('USER_NOT_FOUND')],
      });
    }

    const embed = createRankEmbed(userData);
    await fakeInteraction.editReply({
      embeds: [embed],
    });

  } catch (error) {
    console.error('Command error:', error);
    await fakeInteraction.editReply({
      embeds: [createErrorEmbed('GENERIC')],
    });
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
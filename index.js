require('dotenv').config();
const { Telegraf } = require('telegraf');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const bot = new Telegraf(process.env.BOT_TOKEN);
const CHANNEL_ID = process.env.CHANNEL_ID;
const ADMIN_ID = Number(process.env.ADMIN_ID);

const DB_FILE = path.join(__dirname, 'subscriptions.json');

// JSON файлаас дата унших
function loadDb() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: [] }, null, 2));
  }
  const data = fs.readFileSync(DB_FILE, 'utf8');
  try {
    return JSON.parse(data);
  } catch (e) {
    return { users: [] };
  }
}

// JSON файл руу дата хадгалах
function saveDb(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

console.log('📦 JSON өгөгдлийн сан ашиглагдаж байна:', DB_FILE);

bot.command('add', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('Та админ биш байна!');

  const args = ctx.message.text.split(' ');
  if (args.length < 3) {
    return ctx.reply('Ашиглах format: /add <user_id_or_username> <days>');
  }

  const targetUser = args[1].replace('@', '');
  const days = parseInt(args[2]);
  if (isNaN(days)) return ctx.reply('Өдрийн тоо буруу байна!');

  try {
    const link = await ctx.telegram.createChatInviteLink(CHANNEL_ID, {
      member_limit: 1,
      expire_date: Math.floor(Date.now() / 1000) + 86400
    });

    const expireAt = Math.floor(Date.now() / 1000) + (days * 86400);
    const userId = isNaN(targetUser) ? targetUser : Number(targetUser);

    const db = loadDb();
    // Хэрэв өмнө нь байсан бол шинэчлэх, үгүй бол нэмэх
    const existingIndex = db.users.findIndex(u => u.telegram_id === userId || u.username === targetUser);
    
    if (existingIndex >= 0) {
      db.users[existingIndex].expire_at = expireAt;
    } else {
      db.users.push({
        telegram_id: typeof userId === 'number' ? userId : null,
        username: typeof userId === 'string' ? userId : null,
        expire_at: expireAt
      });
    }

    saveDb(db);

    ctx.reply(
      `✅ **Амжилттай тохирууллаа!**\n\n` +
      `👤 Хэрэглэгч: ${args[1]}\n` +
      `📅 Хугацаа: ${days} хоног\n\n` +
      `🔗 Энэ урилгын линкийг хэрэглэгчид явуулна уу:\n${link.invite_link}`
    );
  } catch (error) {
    console.error(error);
    ctx.reply('Линк үүсгэхэд алдаа гарлаа. Ботын суваг дээрх эрхийг шалгана уу.');
  }
});

cron.schedule('0 * * * *', () => {
  console.log('Хугацаа дууссан хэрэглэгчдийг шалгаж байна...');
  const now = Math.floor(Date.now() / 1000);

  const db = loadDb();
  const activeUsers = [];

  for (const row of db.users) {
    if (row.expire_at <= now && row.telegram_id) {
      bot.telegram.banChatMember(CHANNEL_ID, row.telegram_id)
        .then(() => bot.telegram.unbanChatMember(CHANNEL_ID, row.telegram_id))
        .then(() => {
          console.log(`[KICKED] User ID: ${row.telegram_id} сувагнаас хасагдлаа.`);
        })
        .catch(e => {
          console.error(`Kick хийхэд алдаа гарлаа (${row.telegram_id}):`, e.message);
        });
    } else {
      activeUsers.push(row);
    }
  }

  db.users = activeUsers;
  saveDb(db);
});

bot.launch();
console.log('Бот амжилттай ажиллаж эхэллээ...');

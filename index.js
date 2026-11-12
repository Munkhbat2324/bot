/**
 * ============================================================================
 *  Төлбөртэй Telegram сувгийн гишүүнчлэл хянадаг бот
 * ============================================================================
 *  Технологи: Node.js, Telegraf v4, sqlite3, node-cron, dotenv
 *
 *  Ажиллах зарчим:
 *   1. Админ хувийн чатаар:  /add @username 30   эсвэл   /add 123456789 30
 *   2. Бот сувгийн НЭГ УДААГИЙН урилгын линк (member_limit = 1) үүсгээд админд явуулна.
 *   3. SQLite-д хэрэглэгчийн ID болон эрх дуусах хугацааг (Unix timestamp, секунд) хадгална.
 *   4. node-cron цаг тутам шалгаж, хугацаа дууссан хэрэглэгчийг
 *      banChatMember -> unbanChatMember хийж сувгаас гаргана (дахин орох боломж үлдэнэ).
 *
 *  Нэмэлт админ коммандууд:
 *   /link  @username | user_id   – хугацааг өөрчлөхгүйгээр шинэ урилгын линк үүсгэнэ
 *   /remove @username | user_id  – хэрэглэгчийг шууд гаргаж, эрхийг цуцална
 *   /list                        – идэвхтэй болон хүлээгдэж буй эрхүүдийн жагсаалт
 *   /check                       – хугацаа дууссан эсэхийг одоо шууд шалгана
 *   /help                        – тусламж
 *
 *  ЧУХАЛ: @username-аар нэмэхэд Telegram Bot API нь username-аас user_id-г
 *  шууд олж өгдөггүй. Тиймээс:
 *   - Хэрэглэгч өмнө нь ботод /start бичсэн, эсвэл суваг руу орж байсан бол
 *     бот түүний ID-г мэдэж байгаа тул шууд холбоно.
 *   - Үгүй бол эрх "pending" төлөвтэй хадгалагдаж, тухайн хүн линкээр
 *     нэгдэх мөчид (chat_member update) ID нь автоматаар холбогдоно.
 * ============================================================================
 */

'use strict';

require('dotenv').config();

const path = require('path');
const { Telegraf } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');

// ---------------------------------------------------------------------------
// 1. Тохиргоо (.env файлаас уншина)
// ---------------------------------------------------------------------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID_RAW = process.env.CHANNEL_ID; // -100xxxxxxxxxx эсвэл @channel_username
const ADMIN_ID = Number(process.env.ADMIN_ID);

// Заавал биш тохиргоонууд (байхгүй бол default утга)
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'subscriptions.db');
const TIMEZONE = process.env.TIMEZONE || 'Asia/Ulaanbaatar';
const LINK_TTL_HOURS = Number(process.env.INVITE_LINK_TTL_HOURS) || 24; // Урилгын линк хэдэн цаг хүчинтэй байх

if (!BOT_TOKEN || !CHANNEL_ID_RAW || !process.env.ADMIN_ID || !Number.isSafeInteger(ADMIN_ID)) {
  console.error('❌ .env файлд BOT_TOKEN, CHANNEL_ID, ADMIN_ID-г зөв тохируулна уу.');
  process.exit(1);
}

const DAY = 24 * 60 * 60; // 1 хоног = секундээр
const MAX_DAYS = 3650; // Хамгийн ихдээ 10 жил

// Сувгийн бодит тоон ID (эхлэх үед getChat-аар тодорхойлно)
let channelId = null;

// ---------------------------------------------------------------------------
// 2. Туслах функцууд
// ---------------------------------------------------------------------------

/** Одоогийн Unix timestamp (секунд) */
const now = () => Math.floor(Date.now() / 1000);

/** Түр хүлээх (Telegram API-ийн хязгаарлалтаас сэргийлэх) */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** HTML parse_mode-д аюулгүй болгох */
function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Unix timestamp-ийг "2026-12-12 14:00" хэлбэрээр харуулах */
function formatDate(ts) {
  return new Date(ts * 1000)
    .toLocaleString('sv-SE', { timeZone: TIMEZONE, hour12: false })
    .slice(0, 16);
}

/** Үлдсэн хугацааг "12 хоног 5 цаг" хэлбэрээр */
function formatRemaining(ts) {
  const diff = ts - now();
  if (diff <= 0) return 'дууссан';
  const d = Math.floor(diff / DAY);
  const h = Math.floor((diff % DAY) / 3600);
  return d > 0 ? `${d} хоног ${h} цаг` : `${h} цаг`;
}

/** Хэрэглэгчийг харуулах текст: @username (ID) */
function userLabel(userId, username) {
  const parts = [];
  if (username) parts.push(`@${escapeHtml(username)}`);
  if (userId) parts.push(`<code>${userId}</code>`);
  return parts.join(' ') || 'тодорхойгүй';
}

/**
 * Коммандын аргументыг задлах: "@username" эсвэл "123456789"
 * @returns {{userId?: number, username?: string} | null}
 */
function parseTarget(arg) {
  if (!arg) return null;
  const value = arg.trim();

  if (/^\d{1,15}$/.test(value)) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? { userId: id } : null;
  }

  const match = value.match(/^@?([a-zA-Z][a-zA-Z0-9_]{3,31})$/);
  if (match) return { username: match[1].toLowerCase() };

  return null;
}

/** Урт мессежийг Telegram-ийн 4096 тэмдэгтийн хязгаараар хувааж илгээх */
async function replyChunked(ctx, lines) {
  let chunk = '';
  for (const line of lines) {
    if (chunk.length + line.length + 1 > 3800) {
      await ctx.reply(chunk, { parse_mode: 'HTML', disable_web_page_preview: true });
      chunk = '';
    }
    chunk += line + '\n';
  }
  if (chunk.trim()) {
    await ctx.reply(chunk, { parse_mode: 'HTML', disable_web_page_preview: true });
  }
}

// ---------------------------------------------------------------------------
// 3. SQLite өгөгдлийн сан (callback API-г Promise болгон боосон)
// ---------------------------------------------------------------------------
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('❌ Өгөгдлийн сан нээж чадсангүй:', err.message);
    process.exit(1);
  }
});

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

/**
 * Хүснэгтүүд:
 *  users          – ботод бичсэн / суваг руу орсон хүмүүсийн ID <-> username холбоос
 *  subscriptions  – эрхүүд. status: pending | active | expired | removed | merged
 *     pending  = ID нь хараахан тодорхойгүй (username-аар нэмсэн, линкээр ороогүй)
 *     active   = ID тодорхой, хугацаа дуусахаар cron гаргана
 */
async function initDb() {
  await dbRun('PRAGMA journal_mode = WAL');

  await dbRun(`
    CREATE TABLE IF NOT EXISTS users (
      user_id     INTEGER PRIMARY KEY,
      username    TEXT,
      first_name  TEXT,
      updated_at  INTEGER NOT NULL
    )
  `);
  await dbRun('CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)');

  await dbRun(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER,
      username     TEXT,
      days         INTEGER NOT NULL,
      invite_link  TEXT,
      expires_at   INTEGER NOT NULL,
      status       TEXT    NOT NULL DEFAULT 'pending',
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    )
  `);
  await dbRun('CREATE INDEX IF NOT EXISTS idx_subs_status_exp ON subscriptions(status, expires_at)');
  await dbRun('CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id)');
  await dbRun('CREATE INDEX IF NOT EXISTS idx_subs_link ON subscriptions(invite_link)');
}

/** Хэрэглэгчийн ID <-> username холбоосыг хадгалах/шинэчлэх */
async function upsertUser(user) {
  if (!user || user.is_bot) return;
  const username = user.username ? user.username.toLowerCase() : null;
  const t = now();

  // Username өөр хүнд шилжсэн байж болох тул хуучин эзэмшигчээс нь арилгана
  if (username) {
    await dbRun('UPDATE users SET username = NULL WHERE username = ? AND user_id <> ?', [username, user.id]);
  }

  await dbRun(
    `INSERT INTO users (user_id, username, first_name, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       username   = excluded.username,
       first_name = excluded.first_name,
       updated_at = excluded.updated_at`,
    [user.id, username, user.first_name || null, t]
  );
}

const findUserByUsername = (username) =>
  dbGet('SELECT * FROM users WHERE username = ? ORDER BY updated_at DESC LIMIT 1', [username]);

const findUserById = (userId) => dbGet('SELECT * FROM users WHERE user_id = ?', [userId]);

/** Тухайн хэрэглэгчийн хамгийн сүүлд дуусах идэвхтэй эрх */
const findActiveSubByUserId = (userId) =>
  dbGet(
    `SELECT * FROM subscriptions
     WHERE user_id = ? AND status = 'active'
     ORDER BY expires_at DESC LIMIT 1`,
    [userId]
  );

/**
 * Админы оруулсан target (@username эсвэл ID)-ийг бүрэн мэдээлэл болгох.
 * Мэдэгдэж буй бол username -> ID, ID -> username холбоно.
 */
async function resolveTarget(target) {
  let userId = target.userId || null;
  let username = target.username || null;

  if (username && !userId) {
    const u = await findUserByUsername(username);
    if (u) userId = u.user_id;
  } else if (userId && !username) {
    const u = await findUserById(userId);
    if (u && u.username) username = u.username;
  }
  return { userId, username };
}

// ---------------------------------------------------------------------------
// 4. Telegram үйлдлүүд
// ---------------------------------------------------------------------------
const bot = new Telegraf(BOT_TOKEN);

/** Нэг удаагийн урилгын линк үүсгэх (member_limit: 1) */
async function createSingleUseLink(label) {
  const link = await bot.telegram.createChatInviteLink(channelId, {
    name: String(label).slice(0, 32), // Telegram: нэр хамгийн ихдээ 32 тэмдэгт
    member_limit: 1, // Зөвхөн 1 хүн орох боломжтой
    expire_date: now() + LINK_TTL_HOURS * 3600, // Линк өөрөө ч бас хугацаатай
  });
  return link.invite_link;
}

/** Урилгын линкийг хүчингүй болгох (алдааг үл тооно) */
async function revokeLink(inviteLink) {
  if (!inviteLink) return;
  try {
    await bot.telegram.revokeChatInviteLink(channelId, inviteLink);
  } catch (_) {
    // Линк аль хэдийн хугацаа дууссан/ашиглагдсан байж болно – асуудалгүй
  }
}

/**
 * Хэрэглэгчийг сувгаас гаргах: ban хийгээд шууд unban хийнэ.
 * Ингэснээр хар жагсаалтад үлдэхгүй, дараа нь шинэ линкээр дахин орж чадна.
 */
async function kickUser(userId) {
  try {
    await bot.telegram.banChatMember(channelId, userId);
    await sleep(300);
    await bot.telegram.unbanChatMember(channelId, userId, { only_if_banned: true });
    return { ok: true };
  } catch (err) {
    const message = err && err.description ? err.description : String(err);
    console.error(`⚠️ ${userId} хэрэглэгчийг гаргаж чадсангүй:`, message);
    return { ok: false, error: message };
  }
}

/** Админд мессеж илгээх */
async function notifyAdmin(text) {
  try {
    await bot.telegram.sendMessage(ADMIN_ID, text, { parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (err) {
    console.error('⚠️ Админд мессеж илгээж чадсангүй:', err.message);
  }
}

/** Хэрэглэгчид мессеж илгээх (ботыг /start хийгээгүй бол бүтэлгүйтнэ – үл тооно) */
async function notifyUser(userId, text) {
  if (!userId) return;
  try {
    await bot.telegram.sendMessage(userId, text, { parse_mode: 'HTML' });
  } catch (_) {
    // Хэрэглэгч ботыг эхлүүлээгүй – энэ хэвийн
  }
}

// ---------------------------------------------------------------------------
// 5. Middleware-ууд
// ---------------------------------------------------------------------------

// Хувийн чатаар бичсэн хүн бүрийн ID <-> username-г хадгална
bot.use(async (ctx, next) => {
  try {
    if (ctx.from && ctx.chat && ctx.chat.type === 'private') {
      await upsertUser(ctx.from);
    }
  } catch (err) {
    console.error('upsertUser алдаа:', err.message);
  }
  return next();
});

/** Зөвхөн админ, зөвхөн хувийн чатаар ажиллах шүүлтүүр */
function adminOnly(ctx, next) {
  if (!ctx.from || ctx.from.id !== ADMIN_ID) {
    if (ctx.chat && ctx.chat.type === 'private') {
      return ctx.reply('⛔ Энэ комманд зөвхөн админд зориулагдсан.');
    }
    return undefined; // Бүлэг/сувагт бусдын коммандыг чимээгүй алгасна
  }
  if (ctx.chat.type !== 'private') {
    return ctx.reply('🔒 Админ коммандуудыг зөвхөн ботын хувийн чатаар ашиглана уу.');
  }
  return next();
}

/** Коммандын аргументуудыг авах ("/add @user 30" -> ["@user", "30"]) */
function getArgs(ctx) {
  const text = (ctx.message && ctx.message.text) || '';
  return text.trim().split(/\s+/).slice(1);
}

// ---------------------------------------------------------------------------
// 6. Коммандууд
// ---------------------------------------------------------------------------
const HELP_TEXT = [
  '<b>🤖 Төлбөртэй сувгийн бот – Админ коммандууд</b>',
  '',
  '<code>/add @username 30</code> – 30 хоногийн эрх нэмж, нэг удаагийн линк үүсгэнэ',
  '<code>/add 123456789 60</code> – User ID-аар 60 хоногийн эрх нэмнэ',
  '<code>/link @username</code> – хугацааг өөрчлөхгүйгээр шинэ линк үүсгэнэ',
  '<code>/remove @username</code> – хэрэглэгчийг шууд гаргаж эрхийг цуцална',
  '<code>/list</code> – бүх идэвхтэй / хүлээгдэж буй эрхүүд',
  '<code>/check</code> – хугацаа дууссан хэрэглэгчдийг одоо шалгах',
  '',
  `ℹ️ Урилгын линк ${LINK_TTL_HOURS} цагийн дотор, зөвхөн 1 удаа ашиглагдана.`,
  'ℹ️ Идэвхтэй эрхтэй хүнд дахин /add хийвэл хугацаа нь сунгагдана.',
].join('\n');

// /start
bot.start(async (ctx) => {
  if (ctx.from.id === ADMIN_ID) {
    return ctx.reply(HELP_TEXT, { parse_mode: 'HTML' });
  }
  return ctx.reply(
    `Сайн байна уу! 👋\nТаны Telegram ID: <code>${ctx.from.id}</code>\n\n` +
      'Төлбөрөө төлсний дараа энэ ID-г админд илгээнэ үү.',
    { parse_mode: 'HTML' }
  );
});

// /help
bot.help(adminOnly, (ctx) => ctx.reply(HELP_TEXT, { parse_mode: 'HTML' }));

// /add @username хоног   эсвэл   /add user_id хоног
bot.command('add', adminOnly, async (ctx) => {
  const args = getArgs(ctx);
  if (args.length !== 2) {
    return ctx.reply('Хэрэглээ: <code>/add @username 30</code> эсвэл <code>/add 123456789 30</code>', {
      parse_mode: 'HTML',
    });
  }

  const target = parseTarget(args[0]);
  if (!target) {
    return ctx.reply('❌ Буруу хэрэглэгч. @username эсвэл тоон user_id оруулна уу.');
  }

  const days = Number(args[1]);
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    return ctx.reply(`❌ Хоног нь 1-ээс ${MAX_DAYS} хүртэлх бүхэл тоо байх ёстой.`);
  }

  try {
    const { userId, username } = await resolveTarget(target);
    const t = now();

    // Идэвхтэй эрх байвал сунгана, үгүй бол одооноос эхлэн тооцно
    const existing = userId ? await findActiveSubByUserId(userId) : null;
    const base = existing && existing.expires_at > t ? existing.expires_at : t;
    const expiresAt = base + days * DAY;

    // Нэг удаагийн урилгын линк үүсгэх
    const inviteLink = await createSingleUseLink(`${username ? '@' + username : userId} ${days}d`);

    let statusText;
    if (existing) {
      // Хуучин линкийг хүчингүй болгоод, хугацааг сунгана
      await revokeLink(existing.invite_link);
      await dbRun(
        `UPDATE subscriptions
         SET expires_at = ?, days = days + ?, invite_link = ?, username = COALESCE(?, username), updated_at = ?
         WHERE id = ?`,
        [expiresAt, days, inviteLink, username, t, existing.id]
      );
      statusText = '🔄 Идэвхтэй эрхийг <b>сунгалаа</b>.';
    } else {
      const status = userId ? 'active' : 'pending';
      await dbRun(
        `INSERT INTO subscriptions (user_id, username, days, invite_link, expires_at, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, username, days, inviteLink, expiresAt, status, t, t]
      );
      statusText = userId
        ? '✅ Шинэ эрх <b>идэвхжлээ</b>.'
        : '⏳ Энэ хэрэглэгчийн ID хараахан тодорхойгүй. Линкээр нэгдэх үед автоматаар холбогдоно.';
    }

    const lines = [
      statusText,
      '',
      `👤 Хэрэглэгч: ${userLabel(userId, username)}`,
      `📅 Нэмсэн: <b>${days}</b> хоног`,
      `⏰ Дуусах: <b>${formatDate(expiresAt)}</b> (${TIMEZONE})`,
      '',
      `🔗 Нэг удаагийн линк (${LINK_TTL_HOURS} цаг хүчинтэй):`,
      inviteLink,
    ];
    if (existing) {
      lines.push('', 'ℹ️ Хэрэглэгч сувагт байгаа бол линк шаардлагагүй.');
    }

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', disable_web_page_preview: true });

    // Хэрэглэгч ботыг эхлүүлсэн бол линкийг шууд түүнд ч бас илгээнэ
    if (userId) {
      await notifyUser(
        userId,
        `🎉 Таны эрх <b>${formatDate(expiresAt)}</b> хүртэл идэвхжлээ.\n\n` +
          `Сувагт нэгдэх линк (зөвхөн танд, 1 удаа):\n${inviteLink}`
      );
    }
  } catch (err) {
    console.error('/add алдаа:', err);
    await ctx.reply(`❌ Алдаа гарлаа: ${escapeHtml(err.description || err.message)}`, { parse_mode: 'HTML' });
  }
});

// /link @username | user_id – хугацааг өөрчлөхгүйгээр шинэ линк
bot.command('link', adminOnly, async (ctx) => {
  const target = parseTarget(getArgs(ctx)[0]);
  if (!target) {
    return ctx.reply('Хэрэглээ: <code>/link @username</code> эсвэл <code>/link 123456789</code>', {
      parse_mode: 'HTML',
    });
  }

  try {
    const { userId, username } = await resolveTarget(target);
    const sub = await dbGet(
      `SELECT * FROM subscriptions
       WHERE status IN ('active', 'pending')
         AND ((? IS NOT NULL AND user_id = ?) OR (? IS NOT NULL AND username = ?))
       ORDER BY expires_at DESC LIMIT 1`,
      [userId, userId, username, username]
    );

    if (!sub || sub.expires_at <= now()) {
      return ctx.reply('❌ Энэ хэрэглэгчид идэвхтэй эрх алга. Эхлээд /add ашиглана уу.');
    }

    await revokeLink(sub.invite_link);
    const inviteLink = await createSingleUseLink(`${username ? '@' + username : userId} relink`);
    await dbRun('UPDATE subscriptions SET invite_link = ?, updated_at = ? WHERE id = ?', [inviteLink, now(), sub.id]);

    await ctx.reply(
      [
        `🔗 Шинэ нэг удаагийн линк: ${userLabel(sub.user_id, sub.username)}`,
        `⏰ Эрх дуусах: <b>${formatDate(sub.expires_at)}</b>`,
        '',
        inviteLink,
      ].join('\n'),
      { parse_mode: 'HTML', disable_web_page_preview: true }
    );
  } catch (err) {
    console.error('/link алдаа:', err);
    await ctx.reply(`❌ Алдаа гарлаа: ${escapeHtml(err.description || err.message)}`, { parse_mode: 'HTML' });
  }
});

// /remove @username | user_id – шууд гаргах
bot.command('remove', adminOnly, async (ctx) => {
  const target = parseTarget(getArgs(ctx)[0]);
  if (!target) {
    return ctx.reply('Хэрэглээ: <code>/remove @username</code> эсвэл <code>/remove 123456789</code>', {
      parse_mode: 'HTML',
    });
  }

  try {
    const { userId, username } = await resolveTarget(target);
    const subs = await dbAll(
      `SELECT * FROM subscriptions
       WHERE status IN ('active', 'pending')
         AND ((? IS NOT NULL AND user_id = ?) OR (? IS NOT NULL AND username = ?))`,
      [userId, userId, username, username]
    );

    if (subs.length === 0 && !userId) {
      return ctx.reply('❌ Энэ хэрэглэгчийн эрх олдсонгүй.');
    }

    for (const sub of subs) {
      await revokeLink(sub.invite_link);
      await dbRun("UPDATE subscriptions SET status = 'removed', updated_at = ? WHERE id = ?", [now(), sub.id]);
    }

    const kickId = userId || (subs.find((s) => s.user_id) || {}).user_id;
    let kickText = 'ℹ️ User ID тодорхойгүй тул сувгаас гаргах шаардлагагүй (линкээр ороогүй).';
    if (kickId) {
      const result = await kickUser(kickId);
      kickText = result.ok ? '🚪 Сувгаас гаргалаа.' : `⚠️ Сувгаас гаргаж чадсангүй: ${escapeHtml(result.error)}`;
    }

    await ctx.reply(
      `🗑 ${userLabel(kickId, username)} – ${subs.length} эрх цуцлагдлаа.\n${kickText}`,
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    console.error('/remove алдаа:', err);
    await ctx.reply(`❌ Алдаа гарлаа: ${escapeHtml(err.description || err.message)}`, { parse_mode: 'HTML' });
  }
});

// /list – жагсаалт
bot.command('list', adminOnly, async (ctx) => {
  try {
    const active = await dbAll("SELECT * FROM subscriptions WHERE status = 'active' ORDER BY expires_at ASC");
    const pending = await dbAll("SELECT * FROM subscriptions WHERE status = 'pending' ORDER BY expires_at ASC");

    const lines = [`<b>✅ Идэвхтэй эрх: ${active.length}</b>`];
    active.forEach((s, i) => {
      lines.push(`${i + 1}. ${userLabel(s.user_id, s.username)} — ${formatDate(s.expires_at)} (${formatRemaining(s.expires_at)})`);
    });

    lines.push('', `<b>⏳ Линкээр нэгдээгүй (pending): ${pending.length}</b>`);
    pending.forEach((s, i) => {
      lines.push(`${i + 1}. ${userLabel(s.user_id, s.username)} — ${formatDate(s.expires_at)} (${formatRemaining(s.expires_at)})`);
    });

    await replyChunked(ctx, lines);
  } catch (err) {
    console.error('/list алдаа:', err);
    await ctx.reply('❌ Жагсаалт авахад алдаа гарлаа.');
  }
});

// /check – гараар шалгах
bot.command('check', adminOnly, async (ctx) => {
  await ctx.reply('🔍 Шалгаж байна...');
  const stats = await checkExpired();
  await ctx.reply(
    stats
      ? `✔️ Шалгалт дууслаа.\nГаргасан: ${stats.kicked}\nАмжилтгүй: ${stats.failed}\nАшиглагдаагүй линк хаасан: ${stats.stalePending}`
      : '⏳ Өөр шалгалт явагдаж байна, түр хүлээнэ үү.'
  );
});

// ---------------------------------------------------------------------------
// 7. Сувагт хэн нэгэн нэгдэх үед (chat_member update)
//    – username-аар нэмсэн хүний ID-г холбох
//    – Линкийг өөр хүн ашигласан бол гаргах
// ---------------------------------------------------------------------------
function isInChat(member) {
  return (
    ['creator', 'administrator', 'member'].includes(member.status) ||
    (member.status === 'restricted' && member.is_member === true)
  );
}

bot.on('chat_member', async (ctx) => {
  try {
    const upd = ctx.chatMember;
    if (!upd || upd.chat.id !== channelId) return;

    const user = upd.new_chat_member.user;
    await upsertUser(user); // ID <-> username холбоосыг хадгална

    // Зөвхөн "гадна байсан -> орсон" шилжилтийг сонирхоно
    if (isInChat(upd.old_chat_member) || !isInChat(upd.new_chat_member)) return;

    const link = upd.invite_link && upd.invite_link.invite_link;
    if (!link) return; // Манай линкээр ороогүй

    const sub = await dbGet(
      "SELECT * FROM subscriptions WHERE invite_link = ? AND status IN ('active', 'pending')",
      [link]
    );
    if (!sub) return;

    const joinedUsername = user.username ? user.username.toLowerCase() : null;

    // --- Линкийг өөр хүн ашигласан эсэхийг шалгах ---
    const wrongId = sub.user_id && sub.user_id !== user.id;
    const wrongUsername = !sub.user_id && sub.username && joinedUsername !== sub.username;

    if (wrongId || wrongUsername) {
      const result = await kickUser(user.id);
      await notifyAdmin(
        [
          '🚨 <b>Линкийг өөр хүн ашигласан!</b>',
          `Хэнд зориулсан: ${userLabel(sub.user_id, sub.username)}`,
          `Хэн орсон: ${userLabel(user.id, joinedUsername)} (${escapeHtml(user.first_name)})`,
          result.ok ? '🚪 Тухайн хүнийг гаргалаа.' : `⚠️ Гаргаж чадсангүй: ${escapeHtml(result.error)}`,
          '',
          'Зөв хэрэглэгчид шинэ линк авах бол: <code>/link ' +
            (sub.username ? '@' + escapeHtml(sub.username) : sub.user_id) +
            '</code>',
        ].join('\n')
      );
      return;
    }

    const t = now();

    if (sub.status === 'pending') {
      // Энэ хүн өөр идэвхтэй эрхтэй бол нэгтгэж сунгана
      const other = await findActiveSubByUserId(user.id);
      if (other) {
        const remaining = Math.max(sub.expires_at - t, 0);
        const newExpires = Math.max(other.expires_at, t) + remaining;
        await dbRun('UPDATE subscriptions SET expires_at = ?, invite_link = ?, updated_at = ? WHERE id = ?', [
          newExpires,
          link,
          t,
          other.id,
        ]);
        await dbRun("UPDATE subscriptions SET status = 'merged', user_id = ?, updated_at = ? WHERE id = ?", [
          user.id,
          t,
          sub.id,
        ]);
        sub.expires_at = newExpires;
      } else {
        await dbRun(
          "UPDATE subscriptions SET user_id = ?, username = COALESCE(?, username), status = 'active', updated_at = ? WHERE id = ?",
          [user.id, joinedUsername, t, sub.id]
        );
      }
    }

    await notifyAdmin(
      `✅ ${userLabel(user.id, joinedUsername)} (${escapeHtml(user.first_name)}) сувагт нэгдлээ.\n` +
        `⏰ Эрх дуусах: <b>${formatDate(sub.expires_at)}</b>`
    );
    await notifyUser(
      user.id,
      `🎉 Сувагт тавтай морил! Таны эрх <b>${formatDate(sub.expires_at)}</b> хүртэл хүчинтэй.`
    );
  } catch (err) {
    console.error('chat_member алдаа:', err);
  }
});

// ---------------------------------------------------------------------------
// 8. Хугацаа дууссан хэрэглэгчдийг шалгаж гаргах (cron)
// ---------------------------------------------------------------------------
let isChecking = false;

async function checkExpired() {
  if (isChecking) return null; // Давхар ажиллахаас сэргийлнэ
  isChecking = true;

  const stats = { kicked: 0, failed: 0, stalePending: 0 };
  const report = [];

  try {
    const t = now();

    // --- 8.1 Идэвхтэй боловч хугацаа нь дууссан эрхүүд ---
    const expired = await dbAll(
      "SELECT * FROM subscriptions WHERE status = 'active' AND expires_at <= ? ORDER BY expires_at ASC",
      [t]
    );

    for (const sub of expired) {
      // Аюулгүй байдал: тухайн хүнд өөр хүчинтэй эрх байвал гаргахгүй
      const stillValid = await dbGet(
        "SELECT id FROM subscriptions WHERE user_id = ? AND status = 'active' AND expires_at > ? AND id <> ?",
        [sub.user_id, t, sub.id]
      );

      await dbRun("UPDATE subscriptions SET status = 'expired', updated_at = ? WHERE id = ?", [t, sub.id]);
      await revokeLink(sub.invite_link);

      if (stillValid) continue;

      const result = await kickUser(sub.user_id);
      if (result.ok) {
        stats.kicked += 1;
        report.push(`🚪 ${userLabel(sub.user_id, sub.username)} – гаргалаа`);
        await notifyUser(
          sub.user_id,
          '⌛️ Таны сувгийн эрхийн хугацаа дууслаа.\nДахин сунгах бол төлбөрөө төлөөд админтай холбогдоно уу. Баярлалаа! 🙏'
        );
      } else {
        stats.failed += 1;
        report.push(`⚠️ ${userLabel(sub.user_id, sub.username)} – алдаа: ${escapeHtml(result.error)}`);
      }

      await sleep(500); // Telegram rate limit-ээс сэргийлнэ
    }

    // --- 8.2 Хэзээ ч линкээр нэгдээгүй, хугацаа нь дууссан pending эрхүүд ---
    const stale = await dbAll("SELECT * FROM subscriptions WHERE status = 'pending' AND expires_at <= ?", [t]);
    for (const sub of stale) {
      await revokeLink(sub.invite_link);
      await dbRun("UPDATE subscriptions SET status = 'expired', updated_at = ? WHERE id = ?", [t, sub.id]);
      stats.stalePending += 1;
      report.push(`🗂 ${userLabel(null, sub.username)} – линкээр нэгдээгүй, эрх хаагдлаа`);
    }

    if (report.length > 0) {
      await notifyAdmin(`<b>⏰ Хугацааны шалгалт (${formatDate(t)})</b>\n\n${report.join('\n')}`);
    }

    console.log(
      `[${new Date().toISOString()}] Шалгалт: гаргасан=${stats.kicked}, алдаа=${stats.failed}, pending хаасан=${stats.stalePending}`
    );
    return stats;
  } catch (err) {
    console.error('checkExpired алдаа:', err);
    await notifyAdmin(`❌ Хугацааны шалгалтад алдаа гарлаа: ${escapeHtml(err.message)}`);
    return stats;
  } finally {
    isChecking = false;
  }
}

// ---------------------------------------------------------------------------
// 9. Ерөнхий алдаа барих
// ---------------------------------------------------------------------------
bot.catch((err, ctx) => {
  console.error(`Telegraf алдаа (${ctx.updateType}):`, err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

// ---------------------------------------------------------------------------
// 10. Ботыг эхлүүлэх
// ---------------------------------------------------------------------------
async function main() {
  await initDb();
  console.log(`📦 Өгөгдлийн сан: ${DB_PATH}`);

  // Токен зөв эсэхийг шалгана
  const me = await bot.telegram.getMe();
  console.log(`🤖 Бот: @${me.username}`);

  // CHANNEL_ID-г (@username байсан ч) тоон ID болгоно
  const chat = await bot.telegram.getChat(CHANNEL_ID_RAW);
  channelId = chat.id;
  console.log(`📢 Суваг: ${chat.title} (${channelId})`);

  // Бот сувагт админ эсэхийг шалгана
  const botMember = await bot.telegram.getChatMember(channelId, me.id);
  if (botMember.status !== 'administrator') {
    console.error('❌ Бот сувагт АДМИН биш байна! Ботыг сувагт админаар нэмнэ үү.');
    process.exit(1);
  }
  if (botMember.can_invite_users === false) {
    console.warn('⚠️ Ботод "Invite users via link" эрх алга – линк үүсгэх боломжгүй.');
  }
  if (botMember.can_restrict_members === false) {
    console.warn('⚠️ Ботод гишүүн хасах (ban) эрх алга байж магадгүй – гаргах үед алдаа гарч болно.');
  }

  // Админы чатад коммандын цэс тохируулах
  try {
    await bot.telegram.setMyCommands(
      [
        { command: 'add', description: 'Эрх нэмэх: /add @username 30' },
        { command: 'link', description: 'Шинэ линк: /link @username' },
        { command: 'remove', description: 'Хасах: /remove @username' },
        { command: 'list', description: 'Жагсаалт' },
        { command: 'check', description: 'Одоо шалгах' },
        { command: 'help', description: 'Тусламж' },
      ],
      { scope: { type: 'chat', chat_id: ADMIN_ID } }
    );
  } catch (err) {
    console.warn('⚠️ Коммандын цэс тохируулж чадсангүй (админ ботыг /start хийгээгүй байж магадгүй).');
  }

  // Цаг тутам (минут 0-д) шалгана
  cron.schedule(
    '0 * * * *',
    () => {
      checkExpired();
    },
    { timezone: TIMEZONE }
  );
  console.log(`⏱  Cron: цаг тутам шалгана (${TIMEZONE})`);

  // ЧУХАЛ: 'chat_member' update-ийг тусгайлан идэвхжүүлэх ёстой
  bot
    .launch(
      {
        allowedUpdates: ['message', 'chat_member', 'my_chat_member', 'callback_query'],
      },
      () => {
        console.log('🚀 Бот ажиллаж эхэллээ!');
        checkExpired(); // Эхлэх үед нэг удаа шалгана
      }
    )
    .catch((err) => {
      console.error('❌ Бот эхлүүлэхэд алдаа:', err);
      process.exit(1);
    });
}

// Зөв унтраах (Ctrl+C, pm2 stop гэх мэт)
function shutdown(signal) {
  console.log(`\n${signal} – бот унтарч байна...`);
  try {
    bot.stop(signal);
  } catch (_) {
    // Бот хараахан эхлээгүй байж болно
  }
  db.close(() => process.exit(0));
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  console.error('❌ Эхлүүлэхэд алдаа гарлаа:', err.description || err.message || err);
  process.exit(1);
});

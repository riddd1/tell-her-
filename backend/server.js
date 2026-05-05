require('dotenv').config();
process.on('unhandledRejection', (err) => { console.error('Unhandled rejection:', err); });
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const cloudinary = require('cloudinary').v2;
const { Pool } = require('pg');
const { Resend } = require('resend');

// Required env vars: RESEND_API_KEY, APP_URL
const resend = new Resend(process.env.RESEND_API_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname)));

const CREATOR_MASTER_CODE = process.env.CREATOR_MASTER_CODE;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});


const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

// Create table if it doesn't exist
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      tester_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT DEFAULT 'text',
      timestamp TIMESTAMPTZ DEFAULT NOW(),
      read BOOLEAN DEFAULT FALSE
    );
    CREATE INDEX IF NOT EXISTS idx_messages_tester_user ON messages(tester_id, user_id);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC);
  `);
  await pool.query(`
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS read BOOLEAN DEFAULT FALSE;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id TEXT PRIMARY KEY,
      his_handle TEXT,
      his_platform TEXT,
      his_description TEXT,
      user_name TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS email TEXT;
  `);
  await pool.query(`
    ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS paid BOOLEAN DEFAULT FALSE;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS magic_links (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      used BOOLEAN DEFAULT FALSE
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS affiliates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      commission_per_sale INTEGER DEFAULT 5,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS affiliate_clicks (
      id TEXT PRIMARY KEY,
      affiliate_code TEXT NOT NULL,
      clicked_at TIMESTAMPTZ DEFAULT NOW(),
      user_id TEXT
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS affiliate_sales (
      id TEXT PRIMARY KEY,
      affiliate_code TEXT NOT NULL,
      user_id TEXT NOT NULL,
      amount INTEGER DEFAULT 5,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('Database initialized');
}

initDB().catch(console.error);

app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.get('/', (req, res) => {
  res.json({ status: 'Lily Backend Running' });
});

app.get('/health', async (req, res) => {
  try {
    const result = await pool.query(`SELECT COUNT(*) as count FROM messages`);
    const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'messages'`);
    res.json({
      db: 'connected',
      messageCount: parseInt(result.rows[0].count),
      columns: cols.rows.map(r => r.column_name),
    });
  } catch (e) {
    res.json({ db: 'error', error: e.message });
  }
});

// ── Image Upload ──────────────────────────────────────
app.post('/upload-image', async (req, res) => {
  try {
    const { base64Image } = req.body;
    if (!base64Image) return res.status(400).json({ error: 'Image required' });
    const result = await cloudinary.uploader.upload(
      `data:image/jpeg;base64,${base64Image}`,
      { folder: 'telr-ai-chats', resource_type: 'image' }
    );
    res.json({ url: result.secure_url });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to upload image' });
  }
});

// ── Messages ──────────────────────────────────────────
app.post('/messages/send', async (req, res) => {
  const { userId, testerId, content, type = 'text' } = req.body;
  if (!userId || !testerId || !content) {
    return res.status(400).json({ error: 'userId, testerId, content required' });
  }
  try {
    const id = Date.now().toString();
    const timestamp = new Date().toISOString();
    await pool.query(
      `INSERT INTO messages (id, tester_id, user_id, role, content, type, timestamp, read)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, testerId, userId, 'user', content, type, timestamp, false]
    );
    const message = { id, role: 'user', content, type, timestamp, read: false };
    res.json({ success: true, message });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

app.get('/messages/:testerId/:userId', async (req, res) => {
  const { testerId, userId } = req.params;
  try {
    const result = await pool.query(
      `SELECT * FROM messages WHERE tester_id = $1 AND user_id = $2 ORDER BY timestamp ASC`,
      [testerId, userId]
    );
    const messages = result.rows.map(row => ({
      id: row.id,
      role: row.role,
      content: row.content,
      type: row.type,
      timestamp: row.timestamp,
      read: row.read,
    }));
    res.json({ messages });
  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

// ── Creator ───────────────────────────────────────────
app.post('/creator/all-conversations', async (req, res) => {
  const { creatorCode } = req.body;
  if (creatorCode !== CREATOR_MASTER_CODE) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (tester_id, user_id)
        tester_id, user_id,
        id, role, content, type, timestamp, read
      FROM messages
      ORDER BY tester_id, user_id, timestamp DESC
    `);

    const convMap = {};
    result.rows.forEach(row => {
      const key = `${row.tester_id}:${row.user_id}`;
      if (!convMap[key]) {
        convMap[key] = {
          testerId: row.tester_id,
          userId: row.user_id,
          lastMessage: { id: row.id, role: row.role, content: row.content, type: row.type, timestamp: row.timestamp },
          unreadCount: 0,
          messageCount: 0,
        };
      }
    });

    // Unread count requires `read` column — skip gracefully if it doesn't exist yet
    try {
      const unreadResult = await pool.query(`
        SELECT tester_id, user_id, COUNT(*) as count
        FROM messages WHERE role = 'user' AND read = false
        GROUP BY tester_id, user_id
      `);
      unreadResult.rows.forEach(row => {
        const key = `${row.tester_id}:${row.user_id}`;
        if (convMap[key]) convMap[key].unreadCount = parseInt(row.count);
      });
    } catch (_) {}

    const countResult = await pool.query(`
      SELECT tester_id, user_id, COUNT(*) as count
      FROM messages GROUP BY tester_id, user_id
    `);
    countResult.rows.forEach(row => {
      const key = `${row.tester_id}:${row.user_id}`;
      if (convMap[key]) convMap[key].messageCount = parseInt(row.count);
    });

    // Attach user profiles
    const userIds = [...new Set(Object.values(convMap).map((c) => c.userId))];
    if (userIds.length > 0) {
      try {
        const profileResult = await pool.query(
          `SELECT user_id, his_handle, his_platform, his_description, user_name FROM user_profiles WHERE user_id = ANY($1)`,
          [userIds]
        );
        const profileMap = {};
        profileResult.rows.forEach(row => { profileMap[row.user_id] = row; });
        Object.values(convMap).forEach(convo => {
          const p = profileMap[convo.userId];
          if (p) {
            convo.hisHandle = p.his_handle;
            convo.hisPlatform = p.his_platform;
            convo.hisDescription = p.his_description;
            convo.userName = p.user_name;
          }
        });
      } catch (_) {}
    }

    const conversations = Object.values(convMap).sort((a, b) => {
      const aTime = a.lastMessage?.timestamp ? new Date(a.lastMessage.timestamp).getTime() : 0;
      const bTime = b.lastMessage?.timestamp ? new Date(b.lastMessage.timestamp).getTime() : 0;
      return bTime - aTime;
    });

    res.json({ conversations });
  } catch (error) {
    console.error('All conversations error:', error);
    res.status(500).json({ error: 'Failed to get conversations' });
  }
});

app.post('/creator/conversation', async (req, res) => {
  const { creatorCode, userId, testerId } = req.body;
  if (creatorCode !== CREATOR_MASTER_CODE) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await pool.query(
      `SELECT * FROM messages WHERE tester_id = $1 AND user_id = $2 ORDER BY timestamp ASC`,
      [testerId, userId]
    );
    const messages = result.rows.map(row => ({
      id: row.id, role: row.role, content: row.content,
      type: row.type, timestamp: row.timestamp, read: row.read,
    }));
    // Mark as read separately — never let this block the response
    pool.query(
      `UPDATE messages SET read = true WHERE tester_id = $1 AND user_id = $2 AND role = 'user'`,
      [testerId, userId]
    ).catch(e => console.error('Mark-read error:', e));
    res.json({ messages, testerId, userId });
  } catch (error) {
    console.error('Get conversation error:', error);
    res.status(500).json({ error: 'Failed to get conversation' });
  }
});

app.post('/creator/reply', async (req, res) => {
  const { creatorCode, userId, testerId, content, type = 'text' } = req.body;
  if (creatorCode !== CREATOR_MASTER_CODE) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const id = Date.now().toString();
    const timestamp = new Date().toISOString();
    await pool.query(
      `INSERT INTO messages (id, tester_id, user_id, role, content, type, timestamp, read)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, testerId, userId, 'tester', content, type, timestamp, true]
    );
    const message = { id, role: 'tester', content, type, timestamp, read: true };
    res.json({ success: true, message });
  } catch (error) {
    console.error('Reply error:', error);
    res.status(500).json({ error: 'Failed to send reply' });
  }
});

// ── User Profile ─────────────────────────────────────
app.post('/user/profile', async (req, res) => {
  const { userId, hisHandle, hisPlatform, hisDescription, userName, email } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    await pool.query(`
      INSERT INTO user_profiles (user_id, his_handle, his_platform, his_description, user_name, email, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (user_id) DO UPDATE
        SET his_handle = EXCLUDED.his_handle,
            his_platform = EXCLUDED.his_platform,
            his_description = EXCLUDED.his_description,
            user_name = EXCLUDED.user_name,
            email = EXCLUDED.email,
            updated_at = NOW()
    `, [userId, hisHandle || '', hisPlatform || '', hisDescription || '', userName || '', email || null]);
    res.json({ success: true });
  } catch (error) {
    console.error('Save profile error:', error);
    res.status(500).json({ error: 'Failed to save profile' });
  }
});

// ── Delete conversation ───────────────────────────────
app.post('/messages/delete', async (req, res) => {
  const { userId, testerId } = req.body;
  if (!userId || !testerId) return res.status(400).json({ error: 'userId and testerId required' });
  try {
    await pool.query(
      `DELETE FROM messages WHERE tester_id = $1 AND user_id = $2`,
      [testerId, userId]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Delete conversation error:', error);
    res.status(500).json({ error: 'Failed to delete conversation' });
  }
});

// ── Payment notification ──────────────────────────────
app.post('/notify', async (req, res) => {
  const { plan, hisHandle, hisPlatform, hisDescription, userName } = req.body;
  console.log('=== NEW PAYMENT ===');
  console.log(`Plan: ${plan}`);
  console.log(`User: ${userName}`);
  console.log(`His handle: @${hisHandle} (${hisPlatform})`);
  console.log(`Description: ${hisDescription}`);
  console.log('==================');
  res.json({ success: true });
});

// ── Magic Link ────────────────────────────────────────
app.post('/magic-link', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  try {
    const profileResult = await pool.query(
      `SELECT user_id FROM user_profiles WHERE email = $1 LIMIT 1`,
      [email]
    );
    if (profileResult.rows.length === 0) {
      return res.status(404).json({ error: 'No account found with that email. Please complete the quiz first.' });
    }
    const userId = profileResult.rows[0].user_id;
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO magic_links (token, email, user_id) VALUES ($1, $2, $3)`,
      [token, email, userId]
    );
    const appUrl = process.env.APP_URL || 'https://your-domain.com';
    const link = `${appUrl}/magic?token=${token}`;
    await resend.emails.send({
      from: 'Tell Her <hello@tellher.co>',
      to: email,
      subject: 'Your Tell Her link',
      html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#08080a;font-family:'DM Sans',system-ui,sans-serif"><table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:48px 24px"><table width="100%" style="max-width:480px;background:#101013;border-radius:16px;padding:40px;border:1px solid rgba(247,37,133,0.15)"><tr><td align="center" style="padding-bottom:28px"><p style="font-family:Georgia,serif;font-style:italic;font-size:1.5rem;color:#f5f5f7;margin:0">Tell Her<span style="color:#f72585">.</span></p></td></tr><tr><td align="center" style="padding-bottom:16px"><p style="font-family:Georgia,serif;font-style:italic;font-size:1.5rem;color:#f5f5f7;margin:0">Your link is ready.</p></td></tr><tr><td align="center" style="padding-bottom:28px"><p style="font-size:.9rem;color:#888893;line-height:1.6;margin:0">Click the button below to open your conversation. This link expires in 15 minutes.</p></td></tr><tr><td align="center" style="padding-bottom:32px"><a href="${link}" style="display:inline-block;background:#f72585;color:#fff;font-size:.9rem;font-weight:600;padding:16px 36px;border-radius:14px;text-decoration:none;letter-spacing:.5px">Open my conversation</a></td></tr><tr><td align="center"><p style="font-size:.75rem;color:#2a2a35;margin:0">If you did not request this, you can safely ignore this email.</p></td></tr></table></td></tr></table></body></html>`,
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Magic link error:', error);
    res.status(500).json({ error: 'Failed to send magic link' });
  }
});

app.get('/magic', async (req, res) => {
  const { token } = req.query;
  const errorPage = (msg) => `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#08080a;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh"><div style="text-align:center;color:#f5f5f7;padding:40px"><p style="font-family:Georgia,serif;font-style:italic;font-size:1.4rem;color:#f72585;margin-bottom:16px">Tell Her.</p><p style="font-size:1rem;margin-bottom:8px">${msg}</p><a href="/" style="color:#f72585;font-size:.85rem">Go back</a></div></body></html>`;
  if (!token) return res.status(400).send(errorPage('Invalid link.'));
  try {
    const result = await pool.query(
      `SELECT * FROM magic_links WHERE token = $1`,
      [token]
    );
    if (!result.rows.length) return res.status(404).send(errorPage('This link has expired. Please request a new one.'));
    const row = result.rows[0];
    const ageMinutes = (Date.now() - new Date(row.created_at).getTime()) / 60000;
    if (row.used || ageMinutes > 15) return res.status(410).send(errorPage('This link has expired. Please request a new one.'));
    await pool.query(`UPDATE magic_links SET used = TRUE WHERE token = $1`, [token]);
    const appUrl = process.env.APP_URL || '';
    res.redirect(`${appUrl}/tell-her.html?uid=${encodeURIComponent(row.user_id)}#chat`);
  } catch (error) {
    console.error('Magic redirect error:', error);
    res.status(500).send(errorPage('Something went wrong. Please request a new link.'));
  }
});

// ── Affiliate ─────────────────────────────────────────
app.post('/affiliate/click', async (req, res) => {
  const { affiliateCode, userId } = req.body;
  if (!affiliateCode) return res.json({ success: false });
  try {
    const check = await pool.query('SELECT id FROM affiliates WHERE code = $1', [affiliateCode]);
    if (check.rows.length === 0) return res.json({ success: false });
    const id = Date.now().toString();
    await pool.query(
      'INSERT INTO affiliate_clicks (id, affiliate_code, user_id, clicked_at) VALUES ($1, $2, $3, NOW())',
      [id, affiliateCode, userId || null]
    );
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false });
  }
});

app.post('/affiliate/login', async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });
  try {
    const result = await pool.query(
      'SELECT * FROM affiliates WHERE LOWER(password) = LOWER($1)',
      [password]
    );
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid code or password' });
    const affiliate = result.rows[0];
    const clicks = await pool.query('SELECT COUNT(*) FROM affiliate_clicks WHERE affiliate_code = $1', [affiliate.code]);
    const sales = await pool.query('SELECT COUNT(*) FROM affiliate_sales WHERE affiliate_code = $1', [affiliate.code]);
    const earnings = parseInt(sales.rows[0].count) * affiliate.commission_per_sale;
    res.json({
      success: true,
      role: 'affiliate',
      name: affiliate.name,
      code: affiliate.code,
      clicks: parseInt(clicks.rows[0].count),
      sales: parseInt(sales.rows[0].count),
      earnings,
    });
  } catch (e) {
    console.error('Affiliate login error:', e.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── Creator Login ─────────────────────────────────────
app.post('/creator/login', async (req, res) => {
  const { code } = req.body;
  if (code !== CREATOR_MASTER_CODE) return res.status(401).json({ error: 'Invalid code' });
  res.json({ success: true, role: 'creator' });
});

// ── Admin ─────────────────────────────────────────────
app.post('/admin/login', async (req, res) => {
  const { password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  res.json({ success: true, role: 'admin' });
});

app.post('/admin/stats', async (req, res) => {
  const { password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const totalUsers = await pool.query('SELECT COUNT(*) FROM user_profiles');
    const paidUsers = await pool.query('SELECT COUNT(*) FROM user_profiles WHERE paid = true');
    const affiliates = await pool.query('SELECT * FROM affiliates ORDER BY created_at DESC');
    const affiliateStats = await Promise.all(affiliates.rows.map(async (a) => {
      const clicks = await pool.query('SELECT COUNT(*) FROM affiliate_clicks WHERE affiliate_code = $1', [a.code]);
      const sales = await pool.query('SELECT COUNT(*) FROM affiliate_sales WHERE affiliate_code = $1', [a.code]);
      const earnings = parseInt(sales.rows[0].count) * a.commission_per_sale;
      return {
        id: a.id,
        name: a.name,
        code: a.code,
        password: a.password,
        clicks: parseInt(clicks.rows[0].count),
        sales: parseInt(sales.rows[0].count),
        earnings,
      };
    }));
    res.json({
      totalUsers: parseInt(totalUsers.rows[0].count),
      paidUsers: parseInt(paidUsers.rows[0].count),
      revenue: parseInt(paidUsers.rows[0].count) * 25,
      affiliates: affiliateStats,
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

app.post('/admin/affiliate/create', async (req, res) => {
  const { password, name } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  if (!name) return res.status(400).json({ error: 'Name required' });
  try {
    const affiliatePassword = Math.random().toString(36).slice(2, 10).toUpperCase();
    const id = Date.now().toString();
    await pool.query(
      'INSERT INTO affiliates (id, name, code, password, commission_per_sale) VALUES ($1, $2, $3, $4, $5)',
      [id, name, affiliatePassword, affiliatePassword, 5]
    );
    res.json({ success: true, password: affiliatePassword, name });
  } catch (e) {
    res.status(500).json({ error: 'Failed to create affiliate' });
  }
});

app.post('/admin/affiliate/delete', async (req, res) => {
  const { password, code } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await pool.query('DELETE FROM affiliates WHERE code = $1', [code]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete affiliate' });
  }
});

// ── Payment Confirm ───────────────────────────────────
app.post('/payment/confirm', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    await pool.query(
      'UPDATE user_profiles SET paid = true, updated_at = NOW() WHERE user_id = $1',
      [userId]
    );
    res.json({ success: true });
  } catch (e) {
    console.error('Payment confirm error:', e);
    res.status(500).json({ error: 'Failed to confirm payment' });
  }
});

// ── Creem Webhook ─────────────────────────────────────
app.post('/webhooks/creem', async (req, res) => {
  try {
    const event = req.body;
    console.log('Creem webhook received:', event.type);
    if (event.type === 'checkout.completed' || event.type === 'order.completed') {
      const email = event.data?.customer?.email || event.data?.email;
      if (email) {
        await pool.query(
          'UPDATE user_profiles SET paid = true, updated_at = NOW() WHERE LOWER(email) = LOWER($1)',
          [email]
        );
        console.log('Marked as paid:', email);
      }
    }
    res.json({ received: true });
  } catch (e) {
    console.error('Webhook error:', e);
    res.json({ received: true });
  }
});

// ── Payment Success ───────────────────────────────────
app.get('/success', async (req, res) => {
  const userId = req.query.uid || '';

  try {
    if (userId) {
      await pool.query(
        'UPDATE user_profiles SET paid = true, updated_at = NOW() WHERE user_id = $1',
        [userId]
      );

      // Record affiliate sale if user came from affiliate link
      const refResult = await pool.query(
        'SELECT his_handle FROM user_profiles WHERE user_id = $1',
        [userId]
      );
      const refCode = refResult.rows[0]?.his_handle;
      if (refCode) {
        const saleId = Date.now().toString();
        await pool.query(
          'INSERT INTO affiliate_sales (id, affiliate_code, user_id, amount, created_at) VALUES ($1, $2, $3, $4, NOW())',
          [saleId, refCode, userId, 5]
        );
        console.log('Affiliate sale recorded for:', refCode);
      }

      const result = await pool.query(
        'SELECT user_name, email FROM user_profiles WHERE user_id = $1',
        [userId]
      );
      const user = result.rows[0];
      if (user && user.email) {
        const token = crypto.randomBytes(32).toString('hex');
        await pool.query(
          'INSERT INTO magic_links (token, email, user_id, created_at, used) VALUES ($1, $2, $3, NOW(), false)',
          [token, user.email, userId]
        );
        const appUrl = process.env.APP_URL || 'http://localhost:3000';
        const link = `${appUrl}/magic?token=${token}`;
        await resend.emails.send({
          from: 'Tell Her <hello@tellher.co>',
          to: user.email,
          subject: 'Your Tell Her conversation is ready',
          html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#08080a;font-family:'DM Sans',system-ui,sans-serif">
            <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:48px 24px">
            <table width="100%" style="max-width:480px;background:#101013;border-radius:16px;padding:40px;border:1px solid rgba(247,37,133,0.15)">
            <tr><td align="center" style="padding-bottom:20px">
              <p style="font-family:Georgia,serif;font-style:italic;font-size:1.5rem;color:#f5f5f7;margin:0">Tell Her<span style="color:#f72585">.</span></p>
            </td></tr>
            <tr><td style="padding-bottom:16px">
              <p style="font-family:Georgia,serif;font-style:italic;font-size:1.3rem;color:#f5f5f7;margin:0">Hey ${user.user_name || 'there'}, your conversation is ready.</p>
            </td></tr>
            <tr><td style="padding-bottom:24px">
              <p style="font-size:.9rem;color:#888893;line-height:1.6;margin:0">Payment confirmed. Click the button below to open your conversation. This link expires in 15 minutes.</p>
            </td></tr>
            <tr><td align="center" style="padding-bottom:32px">
              <a href="${link}" style="display:inline-block;background:#f72585;color:#fff;font-size:.9rem;font-weight:600;padding:16px 36px;border-radius:14px;text-decoration:none;letter-spacing:.5px">Open my conversation</a>
            </td></tr>
            <tr><td align="center">
              <p style="font-size:.75rem;color:#2a2a35;margin:0">Tell Her. Private. Anonymous. Just the truth.</p>
            </td></tr>
            </table></td></tr></table>
          </body></html>`,
        });
      }
    }
  } catch (e) {
    console.error('Success page error:', e);
  }

  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Tell Her</title></head>
<body>
<script>
  const uid = localStorage.getItem('tellher_pending_uid') || '';
  localStorage.removeItem('tellher_pending_uid');
  window.location.href = '/tell-her.html?payment=success&uid=' + uid + '#login';
</script>
</body></html>`);

});

// ── User Profile Get ──────────────────────────────────
app.get('/user/profile/get', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    const result = await pool.query(
      'SELECT user_id, user_name, email FROM user_profiles WHERE user_id = $1',
      [userId]
    );
    if (result.rows.length === 0) return res.json({});
    res.json({ userName: result.rows[0].user_name, email: result.rows[0].email });
  } catch (e) {
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

app.post('/test/payment-success', async (req, res) => {
  const { userId, refCode } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    await pool.query(
      'UPDATE user_profiles SET paid = true, updated_at = NOW() WHERE user_id = $1',
      [userId]
    );
    if (refCode) {
      const saleId = Date.now().toString();
      await pool.query(
        'INSERT INTO affiliate_sales (id, affiliate_code, user_id, amount, created_at) VALUES ($1, $2, $3, $4, NOW())',
        [saleId, refCode, userId, 5]
      );
    }
    const result = await pool.query(
      'SELECT user_id, user_name, email, paid FROM user_profiles WHERE user_id = $1',
      [userId]
    );
    res.json({ success: true, user: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/creatordash', (req, res) => {
  res.sendFile(path.join(__dirname, 'creatordash.html'));
});

app.get('/videomaker', (req, res) => {
  res.sendFile(path.join(__dirname, 'videomaker', 'scriptmaker.html'));
});

// ── AI Proxy ──────────────────────────────────────────
app.post('/ai/generate', async (req, res) => {
  const { prompt, systemPrompt } = req.body;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 1024,
        system: systemPrompt || '',
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'AI request failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Telr AI Backend running on port ${PORT}`);
  console.log('=== TEST INSTRUCTIONS ===');
  console.log('1. Open tell-her.html?ref=testaffiliate123');
  console.log('2. Go through quiz, enter name and email');
  console.log('3. Click pay - goes to Creem test checkout');
  console.log('4. Use test card: 4242 4242 4242 4242, any date, any CVC');
  console.log('5. After payment check: curl http://localhost:3000/health');
  console.log('6. Manual test: curl -X POST http://localhost:3000/test/payment-success -H Content-Type:application/json -d {userId:YOUR_ID,refCode:testaffiliate123}');
  console.log('=========================');
});
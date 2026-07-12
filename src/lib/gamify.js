// Gamification engine: approving a participation is the ONLY way points and XP
// are created, and awarding a badge is a pure consequence of XP crossing a
// threshold. Keeping both in one transaction means a user can never end up with
// points but no badge, or a badge they didn't earn.
import { all, get, run, tx, audit } from '../db.js';

async function notify(userId, type, title, message, { icon = 'notifications', link = null } = {}) {
  await run(
    `INSERT INTO notifications (user_id, type, title, message, icon, link)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, type, title, message, icon, link]
  );
}

const setting = async (key, fallback) => {
  const row = await get(`SELECT value FROM settings WHERE key = ?`, [key]);
  return row ? Number(row.value) : fallback;
};

export const autoApproveThreshold = () => setting('auto_approve_threshold', 0.85);

export const levelFor = (xp) => Math.floor(xp / 250) + 1;

export async function syncBadges(userId) {
  const row = await get(`SELECT xp FROM users WHERE id = ?`, [userId]);
  const xp = row?.xp ?? 0;
  const earned = await all(
    `SELECT b.id, b.name, b.tier FROM badges b
      WHERE b.xp_threshold <= ?
        AND b.id NOT IN (SELECT badge_id FROM user_badges WHERE user_id = ?)
      ORDER BY b.xp_threshold`,
    [xp, userId]
  );
  for (const b of earned) {
    // Postgres doesn't have INSERT OR IGNORE, it has ON CONFLICT DO NOTHING
    await run(
      `INSERT INTO user_badges (user_id, badge_id) VALUES (?, ?) ON CONFLICT DO NOTHING`,
      [userId, b.id]
    );
    await audit('system', 'badge_awarded', 'user', userId, `${b.name} (${b.tier})`);
    await notify(userId, 'badge', `🏅 Badge Unlocked: ${b.name}`,
      `Congratulations! You earned the ${b.tier} badge "${b.name}".`,
      { icon: 'military_tech', link: '/gamification.html' });
  }
  return earned;
}

export async function approve(participationId, actor = 'system') {
  return tx(async () => {
    const p = await get(
      `SELECT p.id, p.user_id, p.status, c.points, c.xp, c.title
         FROM participations p JOIN challenges c ON c.id = p.challenge_id
        WHERE p.id = ?`,
      [participationId]
    );
    if (!p) throw Object.assign(new Error('Participation not found'), { status: 404 });
    if (p.status === 'approved') {
      const u = await get(`SELECT xp FROM users WHERE id = ?`, [p.user_id]);
      return { alreadyApproved: true, xp: u.xp, level: levelFor(u.xp), newBadges: [] };
    }

    await run(
      `UPDATE participations
          SET status = 'approved', points_awarded = ?, reviewed_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
      [p.points, participationId]
    );
    await run(
      `UPDATE users SET xp = xp + ?, points_balance = points_balance + ? WHERE id = ?`,
      [p.xp, p.points, p.user_id]
    );

    const newBadges = await syncBadges(p.user_id);
    const u = await get(`SELECT xp, points_balance FROM users WHERE id = ?`, [p.user_id]);

    await audit(actor, 'participation_approved', 'participation', participationId, p.title);
    await notify(p.user_id, 'challenge',
      `✅ Challenge Approved: ${p.title}`,
      `Your submission was approved! You earned ${p.points} points and ${p.xp} XP.`,
      { icon: 'check_circle', link: '/gamification.html' });
    return {
      xp: u.xp,
      pointsBalance: u.points_balance,
      level: levelFor(u.xp),
      pointsAwarded: p.points,
      xpAwarded: p.xp,
      newBadges,
    };
  });
}

export async function redeem(rewardId, userId, actor = 'system') {
  return tx(async () => {
    const reward = await get(`SELECT * FROM rewards WHERE id = ?`, [rewardId]);
    if (!reward) throw Object.assign(new Error('Reward not found'), { status: 404 });

    const user = await get(`SELECT id, name, points_balance FROM users WHERE id = ?`, [userId]);
    if (!user) throw Object.assign(new Error('User not found'), { status: 404 });

    if (reward.status !== 'active') {
      throw Object.assign(new Error(`"${reward.name}" is not currently available.`), { status: 409 });
    }
    if (reward.stock <= 0) {
      throw Object.assign(new Error(`"${reward.name}" is out of stock.`), { status: 409 });
    }
    if (user.points_balance < reward.points_required) {
      const short = reward.points_required - user.points_balance;
      throw Object.assign(
        new Error(`You need ${short} more point${short === 1 ? '' : 's'} to redeem "${reward.name}".`),
        { status: 409 }
      );
    }

    await run(`UPDATE rewards SET stock = stock - 1 WHERE id = ?`, [rewardId]);
    await run(`UPDATE users SET points_balance = points_balance - ? WHERE id = ?`, [
      reward.points_required,
      userId,
    ]);
    const { id } = await run(
      `INSERT INTO redemptions (reward_id, user_id, points_spent) VALUES (?, ?, ?)`,
      [rewardId, userId, reward.points_required]
    );

    const after = await get(`SELECT points_balance FROM users WHERE id = ?`, [userId]);
    await audit(actor, 'reward_redeemed', 'reward', rewardId,
      `${user.name} redeemed "${reward.name}" for ${reward.points_required} points`);

    return {
      id,
      reward: { id: reward.id, name: reward.name, icon: reward.icon },
      pointsSpent: reward.points_required,
      pointsBalance: after.points_balance,
      stockLeft: reward.stock - 1,
    };
  });
}

export async function reject(participationId, reason = 'Did not meet challenge criteria', actor = 'system') {
  return tx(async () => {
    const p = await get(`SELECT id, status, user_id FROM participations WHERE id = ?`, [participationId]);
    if (!p) throw Object.assign(new Error('Participation not found'), { status: 404 });

    await run(
      `UPDATE participations
          SET status = 'rejected', points_awarded = 0, ai_reason = ?, reviewed_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
      [reason, participationId]
    );
    await audit(actor, 'participation_rejected', 'participation', participationId, reason);
    await notify(p.user_id, 'challenge',
      `❌ Challenge Submission Not Approved`,
      `Your submission for a challenge was not approved. Reason: ${reason}`,
      { icon: 'cancel', link: '/gamification.html' });
    return { rejected: true };
  });
}

export async function topEmployees(limit = 10) {
  const rows = await all(
    `SELECT u.id, u.name, u.xp, d.name AS department, d.code,
            COUNT(DISTINCT ub.badge_id) AS badges,
            COUNT(DISTINCT CASE WHEN p.status = 'approved' THEN p.id END) AS completed
       FROM users u
       LEFT JOIN departments d  ON d.id = u.department_id
       LEFT JOIN user_badges ub ON ub.user_id = u.id
       LEFT JOIN participations p ON p.user_id = u.id
      GROUP BY u.id, d.name, d.code
      HAVING u.xp > 0
      ORDER BY u.xp DESC, completed DESC
      LIMIT ?`,
    [limit]
  );
  return rows.map((r, i) => ({ ...r, rank: i + 1, level: levelFor(r.xp) }));
}

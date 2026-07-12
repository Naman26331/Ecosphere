// Gamification engine: approving a participation is the ONLY way points and XP
// are created, and awarding a badge is a pure consequence of XP crossing a
// threshold. Keeping both in one transaction means a user can never end up with
// points but no badge, or a badge they didn't earn.
import { all, get, run, tx, audit } from '../db.js';

/** Insert a notification row for a specific user. */
function notify(userId, type, title, message, { icon = 'notifications', link = null } = {}) {
  run(
    `INSERT INTO notifications (user_id, type, title, message, icon, link)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, type, title, message, icon, link]
  );
}

const setting = (key, fallback) => {
  const row = get(`SELECT value FROM settings WHERE key = ?`, [key]);
  return row ? Number(row.value) : fallback;
};

/** AI confidence at or above this auto-approves without a human. */
export const autoApproveThreshold = () => setting('auto_approve_threshold', 0.85);

/** Level curve: every 250 XP is a level. Level 1 is the floor. */
export const levelFor = (xp) => Math.floor(xp / 250) + 1;

/**
 * Award any badge whose XP threshold the user has now crossed.
 * Idempotent -- INSERT OR IGNORE against the (user, badge) primary key means
 * calling this twice can't double-award.
 */
export function syncBadges(userId) {
  const { xp } = get(`SELECT xp FROM users WHERE id = ?`, [userId]) ?? { xp: 0 };
  const earned = all(
    `SELECT b.id, b.name, b.tier FROM badges b
      WHERE b.xp_threshold <= ?
        AND b.id NOT IN (SELECT badge_id FROM user_badges WHERE user_id = ?)
      ORDER BY b.xp_threshold`,
    [xp, userId]
  );
  for (const b of earned) {
    run(`INSERT OR IGNORE INTO user_badges (user_id, badge_id) VALUES (?, ?)`, [userId, b.id]);
    audit('system', 'badge_awarded', 'user', userId, `${b.name} (${b.tier})`);
    notify(userId, 'badge', `🏅 Badge Unlocked: ${b.name}`,
      `Congratulations! You earned the ${b.tier} badge "${b.name}".`,
      { icon: 'military_tech', link: '/gamification.html' });
  }
  return earned; // so the UI can pop a "badge unlocked" toast
}

/**
 * Approve a participation: bank the points, add the XP, then auto-award badges.
 * Returns the new XP/level and any badges that just unlocked.
 */
export function approve(participationId, actor = 'system') {
  return tx(() => {
    const p = get(
      `SELECT p.id, p.user_id, p.status, c.points, c.xp, c.title
         FROM participations p JOIN challenges c ON c.id = p.challenge_id
        WHERE p.id = ?`,
      [participationId]
    );
    if (!p) throw Object.assign(new Error('Participation not found'), { status: 404 });
    if (p.status === 'approved') {
      const u = get(`SELECT xp FROM users WHERE id = ?`, [p.user_id]);
      return { alreadyApproved: true, xp: u.xp, level: levelFor(u.xp), newBadges: [] };
    }

    run(
      `UPDATE participations
          SET status = 'approved', points_awarded = ?, reviewed_at = datetime('now')
        WHERE id = ?`,
      [p.points, participationId]
    );
    // XP (lifetime, drives badges + rank) and points (spendable on rewards) are
    // both credited here -- this approval is the only place either is minted.
    run(
      `UPDATE users SET xp = xp + ?, points_balance = points_balance + ? WHERE id = ?`,
      [p.xp, p.points, p.user_id]
    );

    const newBadges = syncBadges(p.user_id);
    const u = get(`SELECT xp, points_balance FROM users WHERE id = ?`, [p.user_id]);

    audit(actor, 'participation_approved', 'participation', participationId, p.title);
    notify(p.user_id, 'challenge',
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

// ---------------------------------------------------------------------------
// Rewards
// ---------------------------------------------------------------------------

/**
 * Redeem a reward.
 *
 * Everything happens inside ONE transaction: re-read the reward, check stock and
 * balance, then decrement both and write the ledger row. Checking outside the
 * transaction would let two redemptions of the last item in stock both pass the
 * check and both succeed -- the classic oversell. Re-reading the row inside is
 * what makes the check and the decrement atomic.
 */
export function redeem(rewardId, userId, actor = 'system') {
  return tx(() => {
    const reward = get(`SELECT * FROM rewards WHERE id = ?`, [rewardId]);
    if (!reward) throw Object.assign(new Error('Reward not found'), { status: 404 });

    const user = get(`SELECT id, name, points_balance FROM users WHERE id = ?`, [userId]);
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

    run(`UPDATE rewards SET stock = stock - 1 WHERE id = ?`, [rewardId]);
    run(`UPDATE users SET points_balance = points_balance - ? WHERE id = ?`, [
      reward.points_required,
      userId,
    ]);
    const { id } = run(
      `INSERT INTO redemptions (reward_id, user_id, points_spent) VALUES (?, ?, ?)`,
      [rewardId, userId, reward.points_required]
    );

    const after = get(`SELECT points_balance FROM users WHERE id = ?`, [userId]);
    audit(actor, 'reward_redeemed', 'reward', rewardId,
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

/** Reject a participation. No points, no XP -- and we record why. */
export function reject(participationId, reason = 'Did not meet challenge criteria', actor = 'system') {
  return tx(() => {
    const p = get(`SELECT id, status FROM participations WHERE id = ?`, [participationId]);
    if (!p) throw Object.assign(new Error('Participation not found'), { status: 404 });

    run(
      `UPDATE participations
          SET status = 'rejected', points_awarded = 0, ai_reason = ?, reviewed_at = datetime('now')
        WHERE id = ?`,
      [reason, participationId]
    );
    audit(actor, 'participation_rejected', 'participation', participationId, reason);
    notify(p.user_id, 'challenge',
      `❌ Challenge Submission Not Approved`,
      `Your submission for a challenge was not approved. Reason: ${reason}`,
      { icon: 'cancel', link: '/gamification.html' });
    return { rejected: true };
  });
}

/** Top employees by XP, with their badges -- powers the individual leaderboard. */
export function topEmployees(limit = 10) {
  const rows = all(
    `SELECT u.id, u.name, u.xp, d.name AS department, d.code,
            COUNT(DISTINCT ub.badge_id) AS badges,
            COUNT(DISTINCT CASE WHEN p.status = 'approved' THEN p.id END) AS completed
       FROM users u
       LEFT JOIN departments d  ON d.id = u.department_id
       LEFT JOIN user_badges ub ON ub.user_id = u.id
       LEFT JOIN participations p ON p.user_id = u.id
      GROUP BY u.id
      HAVING u.xp > 0
      ORDER BY u.xp DESC, completed DESC
      LIMIT ?`,
    [limit]
  );
  return rows.map((r, i) => ({ ...r, rank: i + 1, level: levelFor(r.xp) }));
}

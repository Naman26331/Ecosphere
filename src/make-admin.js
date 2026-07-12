// Promote (or demote) a user by email from the command line.
//
//   npm run make-admin  someone@example.com          -> role = admin
//   npm run make-admin  someone@example.com employee  -> role = employee
//
// This is the "hackathon shortcut" for minting the first admin: sign up normally
// through the page (which forces role = employee, by design), then elevate that
// account here. Kept as a CLI, not an open endpoint, precisely because "make me an
// admin" must never be something the network can ask for.
import { get, run } from './db.js';

const email = (process.argv[2] ?? '').trim().toLowerCase();
const role = (process.argv[3] ?? 'admin').trim().toLowerCase();

if (!email) {
  console.error('Usage: npm run make-admin <email> [admin|employee]');
  process.exit(1);
}
if (!['admin', 'employee', 'manager', 'officer'].includes(role)) {
  console.error(`Invalid role "${role}". Use: admin | employee | manager | officer`);
  process.exit(1);
}

const user = get(`SELECT id, name, email, role FROM users WHERE lower(email) = ?`, [email]);
if (!user) {
  console.error(`No account found for ${email}. Have them sign up first.`);
  process.exit(1);
}

run(`UPDATE users SET role = ? WHERE id = ?`, [role, user.id]);
run(
  `INSERT INTO audit_log (actor, action, entity, entity_id, detail)
   VALUES ('cli', 'role_changed', 'user', ?, ?)`,
  [user.id, `${user.role} -> ${role}`]
);

console.log(`${user.name} <${user.email}>: ${user.role} -> ${role}`);

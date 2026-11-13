/**
 * One-off: wipes "ghost" users, the `users` rows whose Cognito account no
 * longer exists (accounts deleted straight from Cognito, e.g. after
 * pentesting). Scans the table, checks every row against the user pool, and
 * with `--apply` deletes the orphans. The same check as `cleanup-orphans`
 * (and as the `user-cleanup` Lambda's 15-minute reconcile), under the name
 * this job is asked for by.
 *
 *   pnpm --filter infra clean-ghost-users prod             # dry run: lists the ghosts
 *   pnpm --filter infra clean-ghost-users prod --apply     # deletes them
 *   ... --apply --force   # when more than half the directory are ghosts
 */
await import("./cleanup-orphans");
export {};

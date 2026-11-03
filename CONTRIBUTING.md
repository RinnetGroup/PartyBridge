# Contributing

Use Node.js 24.18.0. Run `npm ci`, `npm test`, `npm run check` and `npm run format:check` before submitting a change. `npm run format` applies the shared formatting rules.

Use fixtures for routine tests. Tests must not log in, join a real party, send messages, invite people or change a real account. Manual service testing requires the account owner's permission and a clearly agreed test party.

Keep changes focused. Preserve per-device participant identity, complete queued offer/answer transactions, and cleanup of only this client's voice peer. Do not delete a shared bridge as a recovery shortcut.

Dependency updates must preserve the reviewed WebRTC compatibility patch and its packet/role tests. Commit lockfile changes. Do not edit dependencies manually and assume those edits will survive a fresh installation.

Include the behavior changed, how it was checked and any remaining limits in a pull request. Use fictional accounts and synthetic media in tests. Keep research dumps, captured traffic, personal account identifiers, credentials and logs outside the repository.

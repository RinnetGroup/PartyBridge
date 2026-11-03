# Reporting a security issue

Do not put credentials or private account information in public issues. Use [private vulnerability reporting](https://github.com/RinnetGroup/PartyBridge/security/advisories/new) to report a security issue to the maintainers.

Include the affected version, the relevant source path and a minimal example using a test account or synthetic data. Remove NPSSO, access and refresh tokens, session cookies, saved login files, device identifiers and raw network captures.

The app keeps its helper on loopback, uses authenticated local sessions and CSRF checks, and encrypts saved refresh credentials with Windows-protected storage. Saved login is for the same Windows user and is not a portable credential backup.

Review logs before sharing them. Do not disable certificate validation or expose the local helper to the network to troubleshoot a connection problem.

## Native OAuth client credentials

`server/psn.js` includes a shared Sony mobile-client identifier and client credential used for OAuth token exchange. The source and packaged app expose that material to anyone who can read them. It is separate from a user's NPSSO, password, access token and refresh token; the login flow still requires user authorization.

The public source and downloads expose this third-party client credential. Encoding it or moving it to environment configuration does not make a distributed desktop client confidential. Do not describe the repository as containing no hardcoded credentials. Keep personal account credentials, saved login files and diagnostic logs out of commits and releases.

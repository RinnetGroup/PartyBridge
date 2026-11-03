# Reporting a security issue

Do not put credentials or private account information in public issues. Use the repository's private vulnerability-reporting option if it is enabled. Otherwise contact the maintainer privately before sharing sensitive details.

Include the affected version, the relevant source path and a minimal example using a test account or synthetic data. Remove NPSSO, access and refresh tokens, session cookies, saved login files, device identifiers and raw network captures.

The app keeps its helper on loopback, uses authenticated local sessions and CSRF checks, and encrypts saved refresh credentials with Windows-protected storage. Saved login is for the same Windows user and is not a portable credential backup.

Review logs before sharing them. Do not disable certificate validation or expose the local helper to the network to troubleshoot a connection problem.

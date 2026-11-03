# Installation

## Windows installer

The release targets Windows x64. It includes Electron, Node.js and the voice dependencies. The initial packaged build is checked on Windows 11; other operating systems and ARM64 installers are not included.

1. Download the versioned `PartyBridge-Setup-…-x64.exe` installer from the project's Releases page.
2. Run it, review the license, and choose an installation directory.
3. Open **PartyBridge Release** using the Start menu or desktop shortcut.

The installer installs for the current Windows user. Normal installation does not require administrator access. The initial build is unsigned; verify its source and SHA-256 checksum before deciding to run it. A blocked download or application warning is not evidence that the publisher has been verified.

For the portable edition, extract every file from `PartyBridge-…-x64.zip` into a writable directory and open `PartyBridgeRelease.exe`. Do not move only the EXE or run it inside the ZIP.

## Sign in

1. Select **Connect account** and open Sony sign-in.
2. Sign in on Sony's page in the separate window.
3. Use that window's **Sony sign-in > Show NPSSO after sign-in** menu.
4. Copy the NPSSO value into PartyBridge's local connection form.

NPSSO is an account credential. Keep it private and paste it only into your own local app. The sign-in window does not expose its page contents to the PartyBridge renderer.

The desktop release saves the refresh credential using Windows-protected encryption. It does not save your NPSSO or access token. Reopening restores your account; it does not automatically join a party. **Sign out** removes the saved credential.

Release settings and credentials live in `%APPDATA%\PartyBridge Release`. Source development uses `%APPDATA%\PartyBridge Release Dev`. The original local working app uses a separate profile. A release therefore starts with its own login rather than importing credentials from a development build.

## Join and use a party

Choose a visible party and select **Join**, or use **Start party**. The party list updates automatically. Voice can take a moment to prepare; wait for the voice status rather than assuming party membership means audio is ready.

Choose your microphone and speakers in **Audio**. **Mute** changes your outgoing microphone. Party and participant volume controls affect what you hear. Smart voice leveling adjusts incoming voices separately.

Closing the window leaves the app in the system tray. Double-click the tray icon to reopen it. Choose **Quit PartyBridge** in the tray or press **Ctrl+Q** to leave voice and stop the helper.

## Voice network access

If joining works but the voice network handshake gets no replies, use **Voice network access** in the Audio panel (or press **Ctrl+Shift+F**). The confirmation explains the change. Windows then requests administrator approval to add an inbound **UDP-only** rule for this installed copy of the bundled helper, on Private and Public networks. TCP access and other applications are unchanged.

This cannot fix a Sony API rejection, an unavailable voice bridge, an expired login or a remote participant's connection.

The equivalent script is `resources\scripts\voice-firewall.ps1` inside the installed application. To remove a rule you added, run that script from an administrator PowerShell with `-Remove` before deleting the application. The script identifies its rule from the installed helper path and verifies the signed Node runtime against its build manifest.

## Logs and troubleshooting

Use **PartyBridge > Open logs** or the tray's **Open logs** action. Logs are stored under `%APPDATA%\PartyBridge Release\logs`.

- **Cannot sign in:** reconnect your account through Sony sign-in. Never send someone your NPSSO or saved login file.
- **Party joins but voice is preparing:** check for a Sony API error. Firewall changes do not repair HTTP 4xx responses.
- **Voice stays connecting:** inspect the voice status and, if network checks receive no reply, review network access above.
- **People leave and rejoin:** allow the participant connection to update. Readiness is reported for each device.
- **No microphone or playback:** verify the selected devices and Windows microphone permissions.
- **No Share Screen:** a party member must already be sharing from a supported PS5. The local PC preview does not broadcast to the party.

Diagnostics are designed to omit credentials and raw media, but still review logs before sharing them. Report the time, app version, visible error and device types involved.

## Upgrade or uninstall

Quit the app from its tray before upgrading, then run the newer installer. The saved login stays in the Windows user profile.

Use **Windows Settings > Apps > Installed apps > PartyBridge (Release) > Uninstall**. The uninstaller keeps app data. Sign out first to remove the saved credential, or delete the release's app-data folder after quitting if you want to remove settings and logs too. The original working app's profile is separate.

import { dialog } from 'electron';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const literal = (value) => "'" + value.replaceAll("'", "''") + "'";
let pending;
export function requestVoiceFirewall(window) {
  return (pending ??= runFirewallDialog(window).finally(() => {
    pending = null;
  }));
}
async function runFirewallDialog(window) {
  const answer = await dialog.showMessageBox(window, {
    type: 'question',
    title: 'Voice network access',
    message: 'Allow PartyBridge voice through Windows Firewall?',
    detail:
      'Adds an inbound UDP rule for this copy of the bundled helper on Private and Public networks. TCP access stays unchanged. Windows will request administrator approval.',
    buttons: ['Allow UDP access', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  });
  if (answer.response !== 0) return;
  const powershell = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const script = join(process.resourcesPath, 'scripts', 'voice-firewall.ps1');
  const command = `$ErrorActionPreference='Stop';try{$p=Start-Process -FilePath ${literal(powershell)} -ArgumentList @('-NoProfile','-File',${literal('"' + script + '"')}) -Verb RunAs -WindowStyle Hidden -PassThru -Wait;exit $p.ExitCode}catch{exit 1}`;
  const success = await new Promise((resolve) => {
    const child = spawn(
      powershell,
      ['-NoProfile', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: 'ignore' },
    );
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
  });
  await dialog.showMessageBox(window, {
    type: success ? 'info' : 'error',
    title: 'Voice network access',
    message: success
      ? 'PartyBridge UDP access is enabled.'
      : 'The firewall change was not completed.',
    detail: success
      ? 'Rejoin the party to try voice again.'
      : 'Administrator approval is required. You can try again from Help > Voice network access.',
  });
}

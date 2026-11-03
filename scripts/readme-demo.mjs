// Documentation fixture only. Uses the actual UI renderer with fictional data;
// it never signs in, captures audio or connects to a PlayStation service.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const names = [
  'Skylark',
  'NorthStar',
  'OrbitNine',
  'Kairo',
  'Luma',
  'Ashen',
  'PixelDust',
  'Nova',
  'Milo',
  'Sora',
  'Drift',
  'EchoLine',
  'Halcyon',
  'Aster',
  'Taro',
  'Vesper',
  'Cobalt',
  'Ember',
];
const profiles = names.map((onlineId, index) => ({
  accountId: String(1001 + index),
  onlineId,
  memberKey: `demo-${index}`,
  isSelf: index === 0,
  platform: index === 0 ? 'MOBILE_APP' : index % 3 === 0 ? 'PS4' : 'PS5',
  voiceChatActivated: true,
}));
const party = (id, name, members, owner, visibility = 'Friends') => ({
  id,
  name,
  members,
  owner,
  maxMembers: 16,
  visibility,
  joinable: visibility === 'Friends',
});
const parties = [
  party('demo-1', 'Weekend crew', profiles.slice(0, 6), 'NorthStar'),
  party('demo-2', 'Ranked matches', profiles.slice(6, 9), 'PixelDust'),
  party('demo-3', 'After hours', profiles.slice(9, 12), 'Sora'),
  party('demo-4', 'One more round', profiles.slice(12, 14), 'Halcyon'),
  party('demo-5', 'Co-op night', profiles.slice(14, 16), 'Taro'),
  party('demo-6', 'The lobby', profiles.slice(16, 18), 'Cobalt', 'Invite only'),
];

const drawings = [
  '<path fill="#7ba5fa" d="M10 64v-9a22 22 0 0 1 44 0v9"/><rect x="12" y="12" width="40" height="38" rx="18" fill="#e6edff"/><rect x="18" y="21" width="28" height="19" rx="9" fill="#203c75"/><path d="m23 26 8-2" stroke="#a5c6ff" stroke-width="3" stroke-linecap="round"/><rect x="7" y="25" width="8" height="15" rx="4" fill="#97b7f5"/><rect x="49" y="25" width="8" height="15" rx="4" fill="#97b7f5"/>',
  '<path d="m13 15 16 8 22-9-4 27-15 15-17-16Z" fill="#ea9d64"/><path d="m17 21 8 5-8 5m29-10-8 5 8 5" fill="#674753"/><path d="m15 40 17-8 16 8-16 16Z" fill="#fff1de"/><path d="m28 40 8 0-4 5Z" fill="#353954"/><path d="M22 32h3m14 0h3" stroke="#353954" stroke-width="3" stroke-linecap="round"/>',
  '<circle cx="33" cy="31" r="17" fill="#b1a2ef"/><path d="M11 39c-6-12 44-28 47-17S15 52 11 39Z" fill="none" stroke="#dfd5ff" stroke-width="5"/><path d="M21 23a17 17 0 0 1 25 19" fill="none" stroke="#8c79ce" stroke-width="4"/><circle cx="13" cy="13" r="2" fill="#dfd5ff"/>',
  '<path d="m9 52 18-36 10 20 7-11 14 27Z" fill="#9cbedf"/><path d="m19 32 8-16 9 18-9-5Z" fill="#e4f1ff"/><circle cx="47" cy="16" r="7" fill="#edb67c"/><path d="M9 53h49" stroke="#537ba5" stroke-width="4" stroke-linecap="round"/>',
  '<path d="M14 44V27a18 18 0 0 1 36 0v17l-6 8-6-5-6 5-6-5-6 5Z" fill="#d4b0da"/><rect x="21" y="26" width="6" height="9" rx="3" fill="#503b67"/><rect x="37" y="26" width="6" height="9" rx="3" fill="#503b67"/><path d="M28 39h8" stroke="#503b67" stroke-width="3" stroke-linecap="round"/>',
  '<path d="m38 8-22 28h15l-6 20 24-29H34Z" fill="#f0c273"/><path d="m38 8-22 28h15" fill="none" stroke="#fff0c7" stroke-width="3" stroke-linejoin="round"/>',
];
function avatar(id) {
  const index = Math.max(0, Number(id) - 1001) % drawings.length;
  const backgrounds = ['#243858', '#45313d', '#34304e', '#253b4e', '#3e2b48', '#44384a'];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="${backgrounds[index]}"/>${drawings[index]}</svg>`;
}

const demoBoot = `
Object.assign(state, {csrf:'demo-local-only',connected:true,profile:${JSON.stringify(profiles[0])},parties:${JSON.stringify(parties)},active:'demo-1',inCall:true,voiceStatus:'connected',partyStatus:'ready'});
appHub=initAppHub({api,getContext:()=>state,toast});
renderAccount();renderParties();showCall(state.parties[0],'connected');
state.voicePeers=state.parties[0].members.slice(1).map(m=>({accountIds:[m.accountId],memberKeys:[m.memberKey],state:'ready',routeReady:true}));
state.voiceSummary={ready:5,total:5,audioReceived:true};renderCallMembers();setCallStatus('connected');
$('helper-label').textContent='Helper connected';$('helper-dot').classList.add('ready');
for(const [id,label] of [['mic-select','Headset microphone'],['speaker-select','Headset speakers']]){
  const option=document.createElement('option');option.textContent=label;option.value='demo';$(id).append(option);$(id).value='demo';
}
$('enable-audio').textContent='Enabled';$('mic-meter').style.width='46%';
updateVoiceMeter($('input-voice-meter'),0.08);
document.querySelectorAll('.tile').forEach((tile,index)=>{if(index===1||index===3)tile.classList.add('speaking');});
document.documentElement.dataset.demoReady='true';
`;

const demoCss = `
html,body{width:1440px;height:1060px;min-height:1060px;overflow:hidden}
body{position:relative;--page-gutter:36px;--sidebar:220px;--titlebar:40px}
*,*::before,*::after{animation:none!important;transition:none!important;cursor:none!important}
.app-sidebar,.desktop-titlebar,.callbar{position:absolute}
.app-sidebar{top:40px;bottom:0}.desktop-titlebar{top:0}
main{min-height:1060px;padding-top:66px}
.callbar{bottom:18px;left:256px;right:36px}
.audio-panel .plvoice{height:74px;margin-bottom:14px}
.audio-panel .plvoice__pill{top:13px}
.field{margin-bottom:10px}.meter-row{margin-bottom:12px}
.volume-control{margin-top:14px}.audio-toggle{margin-top:14px;padding-top:14px}
.audio-panel .panel-head{margin-bottom:16px}
.leveling-note{margin-top:7px;margin-bottom:7px;line-height:1.4}
.capture-link{margin-top:12px}
.columns{grid-template-columns:minmax(0,1fr) 288px;gap:26px}.side{display:block;height:646px;overflow:hidden}.party-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.party-card{min-height:248px;padding:18px;gap:10px}.party-card .members{align-content:flex-start;gap:5px}.party-card h3{font-size:17px}.party-card-glyph{width:34px;height:34px}.party-meta{padding-top:10px}
.party-card:has(.member-profile:nth-child(5)){min-height:300px}
.demo-window-controls{margin-left:auto;display:flex;gap:24px;color:#8e9bb1;align-items:center}
.demo-window-controls svg{width:12px;height:12px}
`;

const server = http.createServer(async (request, response) => {
  try {
    if (request.method !== 'GET') {
      response.writeHead(405);
      response.end();
      return;
    }
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const send = (body, type = 'application/json') => {
      response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      response.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    if (pathname.startsWith('/api/avatar/'))
      return send(avatar(pathname.split('/').pop()), 'image/svg+xml');
    if (pathname === '/api/bootstrap')
      return send({
        csrf: 'demo-local-only',
        connected: true,
        profile: profiles[0],
        activeParty: 'demo-1',
      });
    if (pathname === '/api/audio/volume')
      return send({ microphone: 100, party: 85, voiceActive: true });
    if (pathname === '/api/audio/leveling') return send({ enabled: true, voiceActive: true });
    if (pathname === '/api/heartbeat') return send({ activeParty: 'demo-1' });
    if (pathname.startsWith('/api/')) return send({});
    if (pathname === '/app.js') {
      const source = await readFile(resolve(root, 'app.js'), 'utf8');
      if (source.split('\ninit();').length !== 2)
        throw new Error('UI bootstrap changed; update the demo fixture.');
      return send(source.replace('\ninit();', '\n' + demoBoot), 'text/javascript');
    }
    if (pathname === '/') {
      let html = await readFile(resolve(root, 'index.html'), 'utf8');
      html = html
        .replace('<html lang="en">', '<html lang="en" data-desktop="true">')
        .replace('id="desktop-titlebar" hidden', 'id="desktop-titlebar"');
      html = html.replace('</head>', `<style>${demoCss}</style></head>`);
      html = html.replace(
        '<img src="/icon.svg" alt="" /><span>PartyBridge</span>',
        '<img src="/icon.svg" alt="" /><span>PartyBridge</span><div class="demo-window-controls" aria-hidden="true"><svg viewBox="0 0 12 12"><path d="M1 6h10" fill="none" stroke="currentColor"/></svg><svg viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" fill="none" stroke="currentColor"/></svg><svg viewBox="0 0 12 12"><path d="m2 2 8 8m0-8-8 8" fill="none" stroke="currentColor"/></svg></div>',
      );
      return send(html, 'text/html');
    }
    const relative = pathname.startsWith('/pinui/') ? '/vendor' + pathname : pathname;
    const file = resolve(root, '.' + relative);
    if (!file.startsWith(root + sep) || !/\.(?:js|css|svg)$/.test(file)) {
      response.writeHead(404);
      response.end();
      return;
    }
    return send(
      await readFile(file),
      file.endsWith('.css')
        ? 'text/css'
        : file.endsWith('.svg')
          ? 'image/svg+xml'
          : 'text/javascript',
    );
  } catch {
    response.writeHead(500);
    response.end('Demo fixture could not render.');
  }
});
await new Promise((resolve) =>
  server.listen(Number(process.env.PARTYBRIDGE_DEMO_PORT ?? 0), '127.0.0.1', resolve),
);
console.log(`Documentation demo: http://localhost:${server.address().port}`);
process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());

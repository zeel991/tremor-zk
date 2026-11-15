import { loadConfig, CONFIG } from './config.js';
import { parseEmail, verifyWithModulus } from '@rp/dkim-verify.mjs';
import { buildInputs } from '@rp/inputs.mjs';
import { TEMPLATES } from '@rp/templates.mjs';
import { computeToCommit, proveInWorker } from './prover.js';
import { resolveKey } from './keys.js';
import { verifyPayout } from './chain.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const say = (el, html, cls = '') => { $(el).innerHTML = `<span class="${cls}">${html}</span>`; };
const hex = (u8) => '0x' + Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const BN254 = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const LS = 'receiptproof.identity.v1';
const state = { identity: null, email: null, dkim: null, inputs: null, proof: null, claimId: null };

function loadIdentity() { try { return JSON.parse(localStorage.getItem(LS) || 'null'); } catch { return null; } }
function saveIdentity(x) { try { localStorage.setItem(LS, JSON.stringify(x)); } catch {} }
function newSalt() {
  const b = crypto.getRandomValues(new Uint8Array(32)); b[0] &= 0x1f; // < 2^253 < r
  return '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
const fmtAmount = (minor, currency) => `${Number(currency) === 840 ? '$' : '₹'}${(Number(minor) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

async function api(path, body) {
  const r = await fetch(CONFIG.agentUrl + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(typeof data === 'string' ? data : (data.error || r.statusText) + (data.reasons ? `: ${data.reasons.join(', ')}` : ''));
  return data;
}

// ---------- step 1: register ----------
async function register() {
  const inbox = $('inbox').value.trim(); const wallet = $('wallet').value.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(inbox)) return say('out1', 'Enter the inbox address your receipts are sent to.', 'bad');
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) return say('out1', 'Enter a 0x wallet address.', 'bad');
  $('btn-register').disabled = true;
  try {
    const prev = loadIdentity();
    const salt = prev && prev.inbox === inbox.toLowerCase() ? prev.salt : newSalt();
    say('out1', 'Computing your commitment with the Noir commit circuit…');
    const toCommit = await computeToCommit(inbox.toLowerCase(), salt);
    state.identity = { inbox: inbox.toLowerCase(), wallet, salt, toCommit: toCommit.toString(), vaultId: CONFIG.vaultId };
    saveIdentity(state.identity);
    let reg = '';
    try { const r = await api('/api/register', { vaultId: CONFIG.vaultId, toCommit: '0x' + toCommit.toString(16), wallet }); reg = r.txHash ? ` · <a href="${CONFIG.explorer}/tx/${r.txHash}" target="_blank" rel="noopener">registration tx</a>` : ' · registered'; }
    catch (e) { reg = /AlreadyRegistered/i.test(e.message) ? ' · already registered' : ` · <span class="warn">registration: ${esc(e.message)}</span>`; }
    say('out1', `<span class="ok">✓</span> to_commit <code>0x${toCommit.toString(16).slice(0, 10)}…</code>${reg}`);
  } catch (e) { say('out1', esc(e.message), 'bad'); }
  finally { $('btn-register').disabled = false; refreshButtons(); }
}

// ---------- step 2: receipt ----------
async function useEmail(raw, label) {
  state.email = null; state.dkim = null; state.inputs = null; state.proof = null; refreshButtons();
  try {
    const parsed = parseEmail(raw);
    const sig = parsed.sigs.find((s) => s.tags.a === 'rsa-sha256');
    if (!sig) throw new Error('No rsa-sha256 DKIM signature in this email');
    const { tags } = sig;
    say('out2', `Checking DKIM key for <b>${esc(tags.d)}</b> (selector <code>${esc(tags.s)}</code>)…`);
    const key = await resolveKey(tags.d, tags.s);
    if (!key.modulus) throw new Error(`No DKIM key found for ${tags.d}/${tags.s}`);
    const dkim = verifyWithModulus(parsed, sig, key.modulus);
    const tpl = Object.entries(TEMPLATES).find(([, t]) => dkim.body.length && new TextDecoder('latin1').decode(dkim.body).includes(t.anchor));
    if (!tpl) throw new Error('No supported merchant template matched this email');
    state.email = { raw, label, domain: tags.d, selector: tags.s, templateId: +tpl[0] };
    state.dkim = dkim;
    const src = key.sources.map((s) => `${s.status === 'found' ? '✓' : s.status === 'none' ? '–' : '!'} ${esc(s.name)}`).join(' · ');
    const amt = /([0-9][0-9,]*(?:\.[0-9]{2})?)/.exec(new TextDecoder('latin1').decode(dkim.body).split(tpl[1].anchor)[1] || '')?.[1];
    say('out2', `<span class="ok">✓ DKIM signature valid</span> · ${esc(tpl[1].name)} · ${esc(tpl[1].currency === 840 ? 'USD' : 'INR')} ${esc(amt || '?')}<br><small class="note">${src}${key.agree ? '' : ' · <span class="warn">sources disagree: the on-chain key is used</span>'}${tpl[1].verified ? '' : ' · <span class="warn">template not yet checked against real mail</span>'}</small>`);
  } catch (e) { say('out2', esc(e.message), 'bad'); }
  refreshButtons();
}
async function sample() {
  if (!state.identity) return say('out2', 'Register your inbox first (step 1): the sample is addressed to it.', 'bad');
  $('btn-sample').disabled = true;
  try { const eml = await api('/api/sample-receipt', { to: state.identity.inbox }); await useEmail(typeof eml === 'string' ? eml : eml.eml, 'sample'); }
  catch (e) { say('out2', esc(e.message), 'bad'); }
  finally { $('btn-sample').disabled = false; }
}

// ---------- step 3: prove ----------
const PUB_MEANING = ['pubkey_hash: Poseidon hash of the merchant DKIM key', 'nullifier: salted, one claim per email', 'template_id: which merchant layout matched', 'amount_minor: total in paise/cents', 'currency: ISO 4217 numeric', 'sent_at: Unix time of the signed Date header', 'to_commit: your salted inbox commitment', 'recipient: wallet the vault must pay', 'vault_id: which company vault'];
async function prove() {
  const id = state.identity;
  if (!id) return say('out3', 'Register first.', 'bad');
  $('btn-prove').disabled = true; $('bar').style.width = '5%';
  try {
    const { inputs, meta } = buildInputs(state.dkim, { templateId: state.email.templateId, salt: id.salt, recipient: id.wallet, vaultId: CONFIG.vaultId });
    if (meta.toAddress.toLowerCase() !== id.inbox) say('out3', `This email was sent to ${esc(meta.toAddress)}, not your registered inbox. The proof will be rejected (PAYEE check).`, 'warn');
    const t0 = performance.now(); const times = [];
    const pct = { witness: 25, backend: 40, prove: 90, verify: 100 };
    const onStep = (k, ms) => { times.push(`${k} ${(ms / 1000).toFixed(1)}s`); $('bar').style.width = (pct[k] || 50) + '%'; say('out3', `Proving… ${times.join(' · ')}`); };
    const r = await proveInWorker(inputs, (k, ms) => { if (k === 'fallback') { times.length = 0; say('out3', 'Thread pool unavailable in this browser; proving single-threaded…', 'warn'); return; } onStep(k, ms); });
    state.proof = r;
    const pubs = r.publicInputs.map((p) => BigInt(p));
    if (pubs.some((p) => p >= BN254)) throw new Error('public input out of field');
    $('sent').textContent = JSON.stringify({ vaultId: CONFIG.vaultId, circuit: 'rsa2048', proof: `0x… (${r.proof.length} bytes)`, pubs: r.publicInputs }, null, 1);
    $('pubs-table').querySelector('tbody').innerHTML = pubs.map((p, i) => `<tr><td>${i}</td><td>${esc(PUB_MEANING[i].split(':')[0])}</td><td class="muted">${esc(PUB_MEANING[i].split(': ')[1])}</td><td><code>${i === 3 ? esc(fmtAmount(p, pubs[4])) : i === 5 ? esc(new Date(Number(p) * 1000).toISOString()) : esc('0x' + p.toString(16))}</code></td></tr>`).join('');
    say('out3', `<span class="ok">✓ Proof generated and verified locally</span> in ${((performance.now() - t0) / 1000).toFixed(1)} s (${r.threads} thread${r.threads > 1 ? 's' : ''}) · ${r.proof.length} bytes · ${times.join(' · ')}`);
  } catch (e) { say('out3', esc(e.message), 'bad'); $('bar').style.width = '0'; }
  finally { refreshButtons(); }
}

// ---------- step 4: submit + follow ----------
const STAGES = [['RECEIVED', 'Agent pre-checks + policy'], ['Queued', 'Queued at Kurier'], ['Valid', 'Proof valid (optimistic)'], ['IncludedInBlock', 'Verified on zkVerify'], ['Finalized', 'Finalized on zkVerify'], ['Aggregated', 'Aggregated, root posted to Base'], ['PAID', 'USDC paid by the vault']];
async function submit() {
  $('btn-submit').disabled = true;
  try {
    const body = { vaultId: CONFIG.vaultId, circuit: 'rsa2048', proof: hex(state.proof.proof), pubs: state.proof.publicInputs };
    const note = $('note').value.trim(); if (note) body.note = note;
    const r = await api('/api/claim', body);
    state.claimId = r.claimId;
    say('out4', `Decision: <b>${esc(r.decision || '…')}</b>${r.reasons?.length ? ' · ' + esc(r.reasons.join(', ')) : ''}${r.explanation ? `<br><small class="note">${esc(r.explanation)}</small>` : ''}`, r.decision === 'REJECT' ? 'bad' : '');
    if (r.claimId) follow(r.claimId);
  } catch (e) { say('out4', esc(e.message), 'bad'); $('btn-submit').disabled = false; }
}
async function follow(id) {
  let c;
  try { c = await api(`/api/claim/${id}`); } catch { return setTimeout(() => follow(id), 5000); }
  const ks = c.kurierStatus || ''; const st = c.status || '';
  const reached = st === 'PAID' ? STAGES.length : Math.max(1, STAGES.findIndex(([k]) => k === ks) + 1, /Aggregat/.test(ks) ? 6 : 0);
  const failed = /FAIL|REJECT/.test(st) || c.decision === 'REJECT';
  $('timeline').innerHTML = STAGES.map(([, label], i) => `<li class="${i < reached ? 'done' : i === reached && !failed ? 'now' : ''}">${esc(label)}${i === 3 && c.zkvTx ? `<small><a href="${CONFIG.zkvExplorer}/extrinsic/${esc(c.zkvTx)}" target="_blank" rel="noopener">${esc(c.zkvTx)}</a></small>` : ''}${i === 5 && c.aggregationId ? `<small>aggregation #${esc(c.aggregationId)}</small>` : ''}${i === 6 && c.baseTx ? `<small><a href="${CONFIG.explorer}/tx/${esc(c.baseTx)}" target="_blank" rel="noopener">${esc(c.baseTx)}</a></small>` : ''}</li>`).join('') + (failed ? `<li class="bad">${esc(st || c.decision)} ${esc((c.reasons || []).join(', '))}</li>` : '');
  if (c.baseTx) $('txhash').value = c.baseTx;
  if (!failed && st !== 'PAID') setTimeout(() => follow(id), 6000);
}

// ---------- verify a payout ----------
async function verify() {
  const h = $('txhash').value.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(h)) { $('checks').innerHTML = '<li class="bad">Enter a 0x transaction hash</li>'; return; }
  $('checks').innerHTML = '<li class="now">Reading Base…</li>';
  try {
    const r = await verifyPayout(h);
    $('checks').innerHTML = r.steps.map((s) => `<li class="${s.ok ? 'ok' : 'bad'}">${esc(s.title)}<small>${esc(s.detail)}</small></li>`).join('') + `<li class="${r.ok ? 'ok' : 'bad'}"><b>${r.ok ? 'This payout is backed by a zkVerify-verified receipt proof.' : 'Verification failed.'}</b><small>amount ${esc(fmtAmount(r.pubs[3], r.pubs[4]))} · sent ${esc(new Date(Number(r.pubs[5]) * 1000).toISOString())} · template ${esc(r.pubs[2])}</small></li>`;
  } catch (e) { $('checks').innerHTML = `<li class="bad">${esc(e.shortMessage || e.message)}</li>`; }
}

// ---------- live feed ----------
async function feed() {
  try {
    const { claims } = await api('/api/recent');
    $('s-claims').textContent = claims.length;
    $('s-paid').textContent = claims.filter((c) => c.status === 'PAID').length;
    $('feed-body').innerHTML = claims.length ? claims.map((c) => `<tr><td>${esc(new Date(c.createdAt).toLocaleString())}</td><td>${esc(c.merchant || c.templateId)}</td><td>${esc(fmtAmount(c.amountMinor, c.currency))}</td><td><code>${esc(c.employee)}</code></td><td>${esc(c.status || c.decision)}${c.reasons?.length ? `<br><small class="muted">${esc(c.reasons.join(', '))}</small>` : ''}</td><td>${c.zkvTx ? `<a href="${CONFIG.zkvExplorer}/extrinsic/${esc(c.zkvTx)}" target="_blank" rel="noopener">zkVerify</a> ` : ''}${c.baseTx ? `<a href="${CONFIG.explorer}/tx/${esc(c.baseTx)}" target="_blank" rel="noopener">Base</a>` : ''}</td></tr>`).join('') : '<tr><td colspan="6" class="muted">No claims yet. Be the first.</td></tr>';
  } catch { $('feed-body').innerHTML = '<tr><td colspan="6" class="muted">Agent unreachable right now.</td></tr>'; }
}

function refreshButtons() {
  $('btn-prove').disabled = !(state.identity && state.dkim);
  $('btn-submit').disabled = !state.proof;
}

(async function init() {
  await loadConfig();
  $('s-network').textContent = CONFIG.network;
  state.identity = loadIdentity();
  if (state.identity) { $('inbox').value = state.identity.inbox; $('wallet').value = state.identity.wallet; say('out1', `<span class="ok">✓</span> Restored your commitment <code>0x${BigInt(state.identity.toCommit).toString(16).slice(0, 10)}…</code> from this browser.`); }
  $('btn-register').onclick = register;
  $('btn-sample').onclick = sample;
  $('eml').onchange = async (e) => { const f = e.target.files[0]; if (f) useEmail(new Uint8Array(await f.arrayBuffer()), f.name); };
  $('btn-prove').onclick = prove;
  $('btn-submit').onclick = submit;
  $('btn-verify').onclick = verify;
  $('export-salt').onclick = (e) => {
    e.preventDefault(); if (!state.identity) return;
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(state.identity, null, 2)], { type: 'application/json' }));
    a.download = 'receiptproof-identity.json'; a.click();
  };
  refreshButtons(); feed(); setInterval(feed, 20000);
})();

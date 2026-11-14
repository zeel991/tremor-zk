import { Noir } from '@noir-lang/noir_js'; import { UltraHonkBackend, Barretenberg } from '@aztec/bb.js';
const o=document.getElementById('o'); const log=s=>{o.textContent+='\n'+s; console.log(s)};
window.run=async(threads)=>{ try{
 const circuit=await (await fetch('/circuit.json')).json(); const inputs=await (await fetch('/inputs.json')).json();
 log(`crossOriginIsolated=${crossOriginIsolated} cores=${navigator.hardwareConcurrency} threads=${threads}`);
 let t=performance.now(); const {witness}=await new Noir(circuit).execute(inputs); log('witness s '+((performance.now()-t)/1000).toFixed(2));
 log('bb.new…'); const api=await Barretenberg.new({threads, logger:(m)=>console.log('[bb] '+m)}); log('bb ready'); const be=new UltraHonkBackend(circuit.bytecode,api);
 log('proving…'); t=performance.now(); const p=await be.generateProof(witness,{verifierTarget:'evm'}); const pt=(performance.now()-t)/1000;
 log('prove s '+pt.toFixed(2)+' proof bytes '+p.proof.length);
 t=performance.now(); const ok=await be.verifyProof(p,{verifierTarget:'evm'}); log('verify '+ok+' s '+((performance.now()-t)/1000).toFixed(2));
 await api.destroy(); window.result={threads,prove:pt,ok}; log('DONE');
 }catch(e){log('ERR '+(e.stack||e)); window.result={err:String(e)}} };
log('ready');

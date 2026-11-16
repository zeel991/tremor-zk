import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Float } from '@react-three/drei';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/* A cluster of receipt cards drifting in space. The current receipt turns to face the viewer and
   gets stamped PROVEN (signed by the merchant) or REJECTED (no signature, or an edited one).
   The cluster spreads apart as the hero scrolls away. Chrome spheres and a starfield for depth. */

const ACCENT = '#d6f24a';

function drawReceipt(ctx, r, stamp) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  ctx.clearRect(0, 0, W, H);
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#f7f7f2'); g.addColorStop(1, '#e3e4dc');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#c9cac2'; for (let x = 8; x < W; x += 24) { ctx.beginPath(); ctx.arc(x, 0, 6, 0, Math.PI); ctx.fill(); }
  ctx.fillStyle = '#121316';
  ctx.font = '500 54px Geist Variable, system-ui, sans-serif'; ctx.fillText(r.merchant, 56, 120);
  ctx.font = '400 28px Geist Mono Variable, ui-monospace, monospace'; ctx.fillStyle = '#5e5f61';
  ctx.fillText(r.when, 56, 170);
  ctx.fillStyle = '#cfd0c8';
  for (let i = 0; i < 4; i++) { ctx.fillRect(56, 240 + i * 58, 300 - i * 40, 16); ctx.fillRect(W - 176, 240 + i * 58, 120, 16); }
  ctx.fillStyle = '#c9cac2'; ctx.fillRect(56, 500, W - 112, 2);
  ctx.fillStyle = '#5e5f61'; ctx.font = '400 30px Geist Variable, system-ui, sans-serif'; ctx.fillText('Total', 56, 572);
  ctx.fillStyle = '#121316'; ctx.font = '300 70px Geist Variable, system-ui, sans-serif';
  const tw = ctx.measureText(r.amount).width; ctx.fillText(r.amount, W - 56 - tw, 584);
  ctx.fillStyle = '#8a8b87'; ctx.font = '400 21px Geist Mono Variable, ui-monospace, monospace';
  ctx.fillText(r.real ? `DKIM-Signature: d=${r.domain}; a=rsa-sha256` : r.domain, 56, 680);
  ctx.fillText(r.real ? 'bh=Aj7F53G08EgtM8lQ2N0+wFEG…' : 'no verifiable origin', 56, 714);
  if (stamp) {
    ctx.save(); ctx.translate(W / 2 + 30, 380); ctx.rotate(-0.2);
    const col = r.real ? '#3f6212' : '#c2301f';
    ctx.strokeStyle = col; ctx.lineWidth = 8; ctx.globalAlpha = 0.9;
    ctx.beginPath(); ctx.roundRect(-200, -60, 400, 120, 60); ctx.stroke();
    ctx.fillStyle = col; ctx.font = '500 60px Geist Mono Variable, ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(r.real ? 'PROVEN' : 'REJECTED', 0, 4);
    ctx.restore();
  }
}

function useReceiptTexture(r, stamped) {
  const canvas = useMemo(() => { const c = document.createElement('canvas'); c.width = 640; c.height = 780; return c; }, []);
  const tex = useMemo(() => { const t = new THREE.CanvasTexture(canvas); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; }, [canvas]);
  useEffect(() => {
    const draw = () => { drawReceipt(canvas.getContext('2d'), r, stamped); tex.needsUpdate = true; };
    draw(); document.fonts?.ready.then(draw); // redraw once web fonts are in
  }, [r, stamped, canvas, tex]);
  return tex;
}

// Resting slots for the cluster (x, y, z, rotX, rotY, rotZ). Slot 0 is the front card.
const SLOTS = [
  [2.2, -0.15, 0.1, -0.06, -0.28, 0.04],
  [0.5, 1.45, -1.6, 0.5, 0.6, -0.4],
  [4.5, 0.95, -2.2, -0.4, -0.8, 0.5],
  [1.0, -1.75, -1.4, 0.9, 0.2, 0.7],
  [4.3, -1.35, -0.8, 0.3, -0.5, -0.6],
];

function Card({ r, slot, isFront, stamped, scroll, mobile, k }) {
  const ref = useRef();
  const tex = useReceiptTexture(r, stamped);
  const mats = useMemo(() => {
    const edge = new THREE.MeshStandardMaterial({ color: '#d8d9d0', roughness: 0.6 });
    const front = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, metalness: 0.05 });
    const back = new THREE.MeshStandardMaterial({ color: '#e9eae3', roughness: 0.7 });
    return [edge, edge, edge, edge, front, back];
  }, [tex]);
  const shake = useRef(0);
  useEffect(() => { if (isFront && stamped && !r.real) shake.current = 1; }, [isFront, stamped, r.real]);
  useFrame((state, dt) => {
    const m = ref.current; if (!m) return;
    const s = scroll?.get?.() ?? 0;
    const [x, y, z, rx, ry, rz] = SLOTS[slot];
    const spread = 1 + s * 2.4;
    const ox = mobile ? (x - 2.3) * 0.6 + 1.1 : x;
    const oy = mobile ? y * 0.7 + 0.8 : y;
    const tx = (ox - 1.2) * spread + 1.2;
    const ty = oy * spread + s * 1.2;
    const tz = z + (isFront ? 0.2 : 0) - s * 2;
    const ease = 1 - Math.pow(0.002, Math.min(dt, 0.05));
    m.position.x += (tx + Math.sin(state.clock.elapsedTime * 45) * 0.06 * shake.current - m.position.x) * ease;
    m.position.y += (ty - m.position.y) * ease;
    m.position.z += (tz - m.position.z) * ease;
    const t = state.clock.elapsedTime * 0.3 + k;
    const trx = isFront ? -0.05 + state.pointer.y * 0.15 : rx + Math.sin(t) * 0.15;
    const tryy = isFront ? -0.26 + state.pointer.x * 0.3 : ry + Math.cos(t * 0.8) * 0.2;
    const trz = isFront ? 0.04 : rz + s * (k % 2 ? 1 : -1);
    m.rotation.x += (trx - m.rotation.x) * ease;
    m.rotation.y += (tryy - m.rotation.y) * ease;
    m.rotation.z += (trz - m.rotation.z) * ease;
    const sc = (mobile ? 0.6 : 1) * (isFront ? 0.95 : 0.72);
    m.scale.setScalar(m.scale.x + (sc - m.scale.x) * ease);
    shake.current = Math.max(0, shake.current - dt * 1.6);
  });
  return (
    <mesh ref={ref} material={mats} position={SLOTS[slot].slice(0, 3)}>
      <boxGeometry args={[2.1, 2.56, 0.035]} />
    </mesh>
  );
}

function Spheres({ scroll, mobile }) {
  const group = useRef();
  useFrame(() => { if (group.current) group.current.position.y = (scroll?.get?.() ?? 0) * 2.2; });
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#ffffff', metalness: 1, roughness: 0.1 }), []);
  const S = mobile ? [[-0.1, 2.6, -1.5, 0.22], [2.3, -0.1, -1, 0.16]] : [[0.2, -2.35, -1.2, 0.42], [3.6, 2.45, -2.6, 0.28], [5.3, 0.1, -0.2, 0.17]];
  return (
    <group ref={group}>
      {S.map(([x, y, z, r], i) => (
        <Float key={i} speed={1 + i * 0.3} floatIntensity={0.8} rotationIntensity={0}>
          <mesh position={[x, y, z]} material={mat}><sphereGeometry args={[r, 48, 48]} /></mesh>
        </Float>
      ))}
    </group>
  );
}

function Stars() {
  const ref = useRef();
  const geo = useMemo(() => {
    const n = 900, p = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { p[i * 3] = (Math.random() - 0.5) * 30; p[i * 3 + 1] = (Math.random() - 0.5) * 18; p[i * 3 + 2] = -3 - Math.random() * 14; }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3)); return g;
  }, []);
  useFrame((_, dt) => { if (ref.current) ref.current.rotation.z += dt * 0.004; });
  return (
    <points ref={ref} geometry={geo}>
      <pointsMaterial size={0.035} color="#ffffff" transparent opacity={0.7} sizeAttenuation depthWrite={false} />
    </points>
  );
}

function Env() {
  const { gl, scene } = useThree();
  useEffect(() => {
    const pm = new THREE.PMREMGenerator(gl);
    const env = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    return () => { env.dispose(); pm.dispose(); scene.environment = null; };
  }, [gl, scene]);
  return null;
}

function CameraRig() {
  const { camera } = useThree();
  useFrame((state) => {
    camera.position.x += (state.pointer.x * 0.5 - camera.position.x) * 0.04;
    camera.position.y += (state.pointer.y * 0.3 - camera.position.y) * 0.04;
    camera.lookAt(1, 0, -1);
  });
  return null;
}

function Scene({ feed, index, scroll }) {
  const { size } = useThree();
  const mobile = size.width < 768;
  const [stamped, setStamped] = useState(-1);
  useEffect(() => { const t = setTimeout(() => setStamped(index), 900); return () => clearTimeout(t); }, [index]);
  const order = feed.map((_, k) => (index + k) % feed.length); // slot -> feed item
  return (
    <>
      <Env />
      <ambientLight intensity={0.35} />
      <directionalLight position={[3, 5, 6]} intensity={1.6} />
      <pointLight position={[3.5, -3, 1.5]} intensity={22} color="#ff5a1f" distance={10} />
      <pointLight position={[-3, 3, 1]} intensity={8} color={ACCENT} distance={9} />
      <Stars />
      <Spheres scroll={scroll} mobile={mobile} />
      {order.map((fi, slot) => (
        <Card key={fi} k={fi} r={feed[fi]} slot={slot} isFront={slot === 0} stamped={slot === 0 ? stamped === index : true} scroll={scroll} mobile={mobile} />
      ))}
      <CameraRig />
    </>
  );
}

export default function Hero3D({ feed, index, scroll, onReady }) {
  return (
    <Canvas
      dpr={[1, 1.75]}
      camera={{ position: [0, 0, 7], fov: 40 }}
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
      onCreated={() => onReady?.()}
    >
      <Scene feed={feed} index={index} scroll={scroll} />
    </Canvas>
  );
}

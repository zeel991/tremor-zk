import { useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Float } from '@react-three/drei';
import * as THREE from 'three';

/* ------------------------------------------------------------------ terrain
 * A wireframe "seismic field". Calm noise plus travelling shockwaves: each verified receipt
 * pushes a ring outwards from under the card. A fake receipt damps the field to near-flat.
 */
const MAX_PULSES = 6;
const terrainVert = /* glsl */ `
  uniform float uTime;
  uniform float uCalm;
  uniform vec4 uPulses[${MAX_PULSES}]; // x, z origin, start time, strength
  varying float vH;
  varying float vDepth;
  float n(vec2 p){ return sin(p.x*1.3+uTime*.35)*.5 + sin(p.y*1.7-uTime*.27)*.4 + sin((p.x+p.y)*.9+uTime*.18)*.35; }
  void main(){
    vec3 p = position;
    float h = n(p.xy*.35) * .22 * uCalm;
    for (int i = 0; i < ${MAX_PULSES}; i++) {
      vec4 q = uPulses[i];
      float age = uTime - q.z;
      if (age > 0. && age < 6.) {
        float d = distance(p.xy, q.xy);
        float front = age * 5.5;
        float ring = exp(-pow(d - front, 2.) * .35);
        h += q.w * ring * sin(d * 2.2 - age * 9.) * exp(-age * .55) * .95;
      }
    }
    p.z += h; // plane is local XY; local z becomes world up after the -90deg tilt
    vH = h;
    vec4 mv = modelViewMatrix * vec4(p, 1.);
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;
const terrainFrag = /* glsl */ `
  uniform vec3 uAccent;
  uniform vec3 uBase;
  varying float vH;
  varying float vDepth;
  void main(){
    float glow = clamp(abs(vH) * 2.2, 0., 1.);
    vec3 c = mix(uBase, uAccent, .18 + glow * .82);
    float fade = smoothstep(26., 6., vDepth);
    gl_FragColor = vec4(c, fade * (.32 + glow * .68));
  }`;

function Terrain({ bus }) {
  const mat = useRef();
  const uniforms = useMemo(() => ({
    uTime: { value: 0 },
    uCalm: { value: 1 },
    uPulses: { value: Array.from({ length: MAX_PULSES }, () => new THREE.Vector4(0, 0, -99, 0)) },
    uAccent: { value: new THREE.Color('#ff5b22') },
    uBase: { value: new THREE.Color('#3a3d42') },
  }), []);
  const slot = useRef(0);
  useEffect(() => {
    bus.current.pulse = (strength = 1, x = 0, z = 0) => {
      const t = uniforms.uTime.value;
      uniforms.uPulses.value[slot.current % MAX_PULSES].set(x, z, t, strength);
      slot.current++;
      uniforms.uCalm.value = 1;
    };
    bus.current.flatten = () => { uniforms.uCalm.value = 0.08; };
  }, [bus, uniforms]);
  useFrame((_, dt) => {
    uniforms.uTime.value += Math.min(dt, 0.05);
    uniforms.uCalm.value += (1 - uniforms.uCalm.value) * 0.006;
  });
  return (
    <mesh rotation-x={-Math.PI / 2} position={[0, -1.35, -4]}>
      <planeGeometry args={[40, 30, 160, 120]} />
      <shaderMaterial ref={mat} uniforms={uniforms} vertexShader={terrainVert} fragmentShader={terrainFrag} wireframe transparent depthWrite={false} />
    </mesh>
  );
}

/* ------------------------------------------------------------------ receipt card */
function drawReceipt(ctx, r, stamp) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#efeee9'; ctx.fillRect(0, 0, W, H);
  // perforated top edge
  ctx.fillStyle = '#d9d8d2'; for (let x = 8; x < W; x += 24) { ctx.beginPath(); ctx.arc(x, 0, 6, 0, Math.PI); ctx.fill(); }
  ctx.fillStyle = '#111213';
  ctx.font = '600 54px Geist Variable, system-ui, sans-serif'; ctx.fillText(r.merchant, 56, 120);
  ctx.font = '400 30px Geist Mono Variable, ui-monospace, monospace'; ctx.fillStyle = '#5e5f61';
  ctx.fillText(r.when, 56, 172);
  ctx.fillStyle = '#c9c8c1';
  for (let i = 0; i < 4; i++) { ctx.fillRect(56, 240 + i * 58, 300 - i * 40, 18); ctx.fillRect(W - 176, 240 + i * 58, 120, 18); }
  ctx.fillStyle = '#d9d8d2'; ctx.fillRect(56, 500, W - 112, 3);
  ctx.fillStyle = '#5e5f61'; ctx.font = '500 30px Geist Variable, system-ui, sans-serif'; ctx.fillText('Total', 56, 572);
  ctx.fillStyle = '#111213'; ctx.font = '600 66px Geist Mono Variable, ui-monospace, monospace';
  const tw = ctx.measureText(r.amount).width; ctx.fillText(r.amount, W - 56 - tw, 580);
  ctx.fillStyle = '#8a8b87'; ctx.font = '400 22px Geist Mono Variable, ui-monospace, monospace';
  ctx.fillText(r.real ? `DKIM-Signature: d=${r.domain}; a=rsa-sha256` : r.domain, 56, 680);
  ctx.fillText(r.real ? 'bh=Aj7F53G08EgtM8lQ2N0+wFEG…' : 'no verifiable origin', 56, 716);
  if (stamp) {
    ctx.save(); ctx.translate(W / 2 + 30, 380); ctx.rotate(-0.22);
    const col = r.real ? '#ff5b22' : '#d43a2f';
    ctx.strokeStyle = col; ctx.lineWidth = 10; ctx.globalAlpha = 0.92;
    ctx.beginPath(); ctx.roundRect(-210, -64, 420, 128, 22); ctx.stroke();
    ctx.fillStyle = col; ctx.font = '700 72px Geist Variable, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(r.real ? 'PROVEN' : 'REJECTED', 0, 4);
    ctx.restore();
  }
}

function Receipt({ bus, feed, index }) {
  const group = useRef();
  const canvas = useMemo(() => { const c = document.createElement('canvas'); c.width = 640; c.height = 780; return c; }, []);
  const tex = useMemo(() => { const t = new THREE.CanvasTexture(canvas); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; }, [canvas]);
  const anim = useRef({ flip: 0, shake: 0 });
  useEffect(() => {
    const ctx = canvas.getContext('2d');
    const r = feed[index];
    anim.current.flip = 1;
    drawReceipt(ctx, r, false); tex.needsUpdate = true;
    const t = setTimeout(() => {
      drawReceipt(ctx, r, true); tex.needsUpdate = true;
      if (r.real) bus.current.pulse?.(1.15, 1.6, -1.8); // local xy just behind the card, so the wave frames it
      else { anim.current.shake = 1; bus.current.flatten?.(); }
    }, 900);
    return () => clearTimeout(t);
  }, [index, feed, canvas, tex, bus]);
  useFrame((state, dt) => {
    const g = group.current; if (!g) return;
    const a = anim.current;
    a.flip = Math.max(0, a.flip - dt * 1.6);
    a.shake = Math.max(0, a.shake - dt * 1.8);
    const ease = 1 - Math.pow(1 - (1 - a.flip), 3);
    g.rotation.y = (1 - ease) * Math.PI * 0.9 + state.pointer.x * 0.25;
    g.rotation.x = -0.12 + state.pointer.y * 0.12;
    const portrait = state.viewport.aspect < 1;
    g.position.x = (portrait ? 0.15 : 1.9) + Math.sin(state.clock.elapsedTime * 40) * 0.06 * a.shake;
    g.position.y = portrait ? -1.55 : 0.25;
    g.scale.setScalar(portrait ? 0.7 : 1);
  });
  return (
    <Float speed={1.4} rotationIntensity={0.25} floatIntensity={0.6}>
      <group ref={group} position={[1.9, 0.25, 0]}>
        <mesh castShadow>
          <planeGeometry args={[2.1, 2.56]} />
          <meshStandardMaterial map={tex} roughness={0.85} metalness={0} side={THREE.DoubleSide} />
        </mesh>
      </group>
    </Float>
  );
}

function CameraRig() {
  const { camera } = useThree();
  useFrame((state) => {
    camera.position.x += (state.pointer.x * 0.6 - camera.position.x) * 0.04;
    camera.position.y += (1.1 + state.pointer.y * 0.3 - camera.position.y) * 0.04;
    camera.lookAt(0.6, 0, -2);
  });
  return null;
}

export default function Hero3D({ feed, index, onReady }) {
  const bus = useRef({});
  return (
    <Canvas
      dpr={[1, 1.75]}
      camera={{ position: [0, 1.1, 6.2], fov: 42 }}
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
      onCreated={() => onReady?.()}
    >
      <ambientLight intensity={0.9} />
      <directionalLight position={[3, 4, 5]} intensity={1.4} />
      <pointLight position={[2, 1, 2]} intensity={6} color="#ff5b22" distance={7} />
      <Terrain bus={bus} />
      <Receipt bus={bus} feed={feed} index={index} />
      <CameraRig />
    </Canvas>
  );
}

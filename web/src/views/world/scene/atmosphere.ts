import * as THREE from "three";
import type { ValleyPlan } from "../../../../../shared/valley/plan.ts";

// Sun, sky and haze: a dry Californian day, or the same place at dusk. Far land fades
// into the haze and the haze into the sky, so the valley has no edge to see.

type Light = { haze: number; zenith: number; sun: number; sunPower: number; sky: number; ground: number; skyPower: number; exposure: number; sunFrom: [number, number, number] };

const DAY: Light = { haze: 0xc9d6df, zenith: 0x6fa3d6, sun: 0xfff0d6, sunPower: 3, sky: 0xdce9f4, ground: 0x8f8455, skyPower: 1.1, exposure: 0.95, sunFrom: [-0.75, 1.25, 0.5] };
const DUSK: Light = { haze: 0x7a6478, zenith: 0x232a55, sun: 0xffa86e, sunPower: 2.3, sky: 0x8d9fd6, ground: 0x3c3a50, skyPower: 1.25, exposure: 1.05, sunFrom: [-1, 0.5, 0.35] };

const SKY_RADIUS = 1000;

export function createAtmosphere(scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  const sky = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 3; // a soft edge: the sun isn't a point
  scene.add(sun, sun.target, sky);
  const fog = new THREE.Fog(DAY.haze, 100, 300);
  scene.fog = fog;
  // The sky: one shape round the camera, the haze at the horizon going up to blue.
  const skyColors = { horizon: { value: new THREE.Color(DAY.haze) }, zenith: { value: new THREE.Color(DAY.zenith) } };
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(SKY_RADIUS, 24, 12),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: skyColors,
      vertexShader: "varying vec3 way; void main(){ way = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: "uniform vec3 horizon; uniform vec3 zenith; varying vec3 way; void main(){ gl_FragColor = vec4(mix(horizon, zenith, smoothstep(0.0, 0.42, normalize(way).y)), 1.0);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}",
    }),
  );
  dome.frustumCulled = false;
  dome.renderOrder = -1;
  scene.add(dome);
  let light = DAY;

  return {
    setDusk(dusk: boolean) {
      light = dusk ? DUSK : DAY;
      scene.background = new THREE.Color(light.haze);
      skyColors.horizon.value.setHex(light.haze);
      skyColors.zenith.value.setHex(light.zenith);
      fog.color.setHex(light.haze);
      sun.color.setHex(light.sun);
      sun.intensity = light.sunPower;
      sky.color.setHex(light.sky);
      sky.groundColor.setHex(light.ground);
      sky.intensity = light.skyPower;
      renderer.toneMappingExposure = light.exposure;
    },
    // Shadows reach the built-up part: past that, they're too small to see.
    frameShadows(plan: ValleyPlan) {
      const center = new THREE.Vector3((plan.minX + plan.maxX) / 2, 0, (plan.minZ + plan.maxZ) / 2);
      const reach = Math.max(plan.maxX - plan.minX, plan.maxZ - plan.minZ) * 0.72 + 8;
      sun.position.copy(center).addScaledVector(new THREE.Vector3(...light.sunFrom).normalize(), reach * 2);
      sun.target.position.copy(center);
      const shadow = sun.shadow.camera;
      shadow.left = shadow.bottom = -reach;
      shadow.right = shadow.top = reach;
      shadow.near = 1;
      shadow.far = reach * 4.5;
      shadow.updateProjectionMatrix();
      renderer.shadowMap.needsUpdate = true;
    },
    redrawShadows() {
      renderer.shadowMap.needsUpdate = true;
    },
    // The haze keeps its distance from the camera, whatever the zoom.
    followCamera(distance: number, camera: THREE.Vector3) {
      dome.position.copy(camera);
      fog.near = Math.max(distance * 2.4, 90);
      fog.far = Math.max(distance * 9, 460);
    },
    dispose() {
      dome.geometry.dispose();
      dome.material.dispose();
    },
  };
}

export type Atmosphere = ReturnType<typeof createAtmosphere>;

import { defineNode, NodeRegistry, type NodeTypeDef, type TypeRegistry } from '@mekdeck/core';
import {
  isCamera,
  isGeometry,
  isMaterial,
  isScene,
  isSceneObject,
  SCENE_IR_VERSION,
  type GeometryDesc,
  type MaterialDesc,
  type PerspectiveCameraObject,
  type RGB,
  type SceneObject,
  type Vec3,
} from '@mekdeck/scene';

/** Scene data types shared by the scene nodes. */
export function registerSceneTypes(types: TypeRegistry): void {
  types.register({ id: 'geometry', label: 'Geometry', color: '#34d399', check: isGeometry });
  types.register({ id: 'material', label: 'Material', color: '#f87171', check: isMaterial });
  types.register({ id: 'object', label: 'Object', color: '#38bdf8', check: isSceneObject });
  types.register({ id: 'scene', label: 'Scene', color: '#e879f9', check: isScene });
}

const DEG = Math.PI / 180;
const toRadians = (v: Vec3): Vec3 => [v[0] * DEG, v[1] * DEG, v[2] * DEG];
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

function positive(label: string, value: number): number {
  if (!(value > 0)) throw new Error(`${label} must be greater than 0 (got ${value})`);
  return value;
}

function segments(label: string, value: number, min: number): number {
  const n = Math.round(value);
  if (n < min || n > 512) throw new Error(`${label} must be between ${min} and 512 (got ${value})`);
  return n;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

const valueNumber = defineNode<{ value: number }, { value: number }>({
  type: 'value.number',
  label: 'Number',
  category: 'Value',
  inputs: { value: { type: 'number', default: 0 } },
  outputs: { value: { type: 'number' } },
  evaluate: ({ inputs }) => ({ value: inputs.value }),
});

const valueVec3 = defineNode<{ value: Vec3 }, { value: Vec3 }>({
  type: 'value.vec3',
  label: 'Vector',
  category: 'Value',
  inputs: { value: { type: 'vec3', default: [0, 0, 0] } },
  outputs: { value: { type: 'vec3' } },
  evaluate: ({ inputs }) => ({ value: inputs.value }),
});

const valueColor = defineNode<{ value: RGB }, { value: RGB }>({
  type: 'value.color',
  label: 'Color',
  category: 'Value',
  description: 'An sRGB colour, each channel 0..1.',
  inputs: { value: { type: 'color', default: [1, 1, 1] } },
  outputs: { value: { type: 'color' } },
  evaluate: ({ inputs }) => ({ value: inputs.value }),
});

// ---------------------------------------------------------------------------
// Math
// ---------------------------------------------------------------------------

function binary(type: string, label: string, fn: (a: number, b: number) => number, identity: number): NodeTypeDef {
  return defineNode<{ a: number; b: number }, { result: number }>({
    type,
    label,
    category: 'Math',
    inputs: { a: { type: 'number', default: identity }, b: { type: 'number', default: identity } },
    outputs: { result: { type: 'number' } },
    evaluate: ({ inputs }) => ({ result: fn(inputs.a, inputs.b) }),
  });
}

function unary(type: string, label: string, fn: (v: number) => number): NodeTypeDef {
  return defineNode<{ value: number }, { result: number }>({
    type,
    label,
    category: 'Math',
    inputs: { value: { type: 'number', default: 0 } },
    outputs: { result: { type: 'number' } },
    evaluate: ({ inputs }) => ({ result: fn(inputs.value) }),
  });
}

const mathTime = defineNode<Record<string, never>, { time: number; frame: number }>({
  type: 'math.time',
  label: 'Time',
  category: 'Math',
  description: 'The playhead position in seconds and frames.',
  inputs: {},
  outputs: { time: { type: 'number' }, frame: { type: 'number' } },
  volatile: true,
  evaluate: ({ ctx }) => ({ time: ctx.time, frame: ctx.frame }),
});

// ---------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------

const vectorCombine = defineNode<{ x: number; y: number; z: number }, { vector: Vec3 }>({
  type: 'vector.combine',
  label: 'Combine XYZ',
  category: 'Vector',
  inputs: { x: { type: 'number', default: 0 }, y: { type: 'number', default: 0 }, z: { type: 'number', default: 0 } },
  outputs: { vector: { type: 'vec3' } },
  evaluate: ({ inputs }) => ({ vector: [inputs.x, inputs.y, inputs.z] }),
});

const vectorSeparate = defineNode<{ vector: Vec3 }, { x: number; y: number; z: number }>({
  type: 'vector.separate',
  label: 'Separate XYZ',
  category: 'Vector',
  inputs: { vector: { type: 'vec3', default: [0, 0, 0] } },
  outputs: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
  evaluate: ({ inputs }) => ({ x: inputs.vector[0], y: inputs.vector[1], z: inputs.vector[2] }),
});

// ---------------------------------------------------------------------------
// Scene: geometry
// ---------------------------------------------------------------------------

const sceneBox = defineNode<{ width: number; height: number; depth: number }, { geometry: GeometryDesc }>({
  type: 'scene.box',
  label: 'Box',
  category: 'Geometry',
  inputs: { width: { type: 'number', default: 1 }, height: { type: 'number', default: 1 }, depth: { type: 'number', default: 1 } },
  outputs: { geometry: { type: 'geometry' } },
  evaluate: ({ inputs }) => ({
    geometry: { kind: 'box', width: positive('Width', inputs.width), height: positive('Height', inputs.height), depth: positive('Depth', inputs.depth) },
  }),
});

const sceneSphere = defineNode<{ radius: number; widthSegments: number; heightSegments: number }, { geometry: GeometryDesc }>({
  type: 'scene.sphere',
  label: 'Sphere',
  category: 'Geometry',
  inputs: {
    radius: { type: 'number', default: 0.5 },
    widthSegments: { type: 'number', default: 32 },
    heightSegments: { type: 'number', default: 16 },
  },
  outputs: { geometry: { type: 'geometry' } },
  evaluate: ({ inputs }) => ({
    geometry: {
      kind: 'sphere',
      radius: positive('Radius', inputs.radius),
      widthSegments: segments('Width segments', inputs.widthSegments, 3),
      heightSegments: segments('Height segments', inputs.heightSegments, 2),
    },
  }),
});

const scenePlane = defineNode<{ width: number; height: number }, { geometry: GeometryDesc }>({
  type: 'scene.plane',
  label: 'Plane',
  category: 'Geometry',
  description: 'A flat rectangle facing +Z. Rotate it -90 degrees around X to make a floor.',
  inputs: { width: { type: 'number', default: 1 }, height: { type: 'number', default: 1 } },
  outputs: { geometry: { type: 'geometry' } },
  evaluate: ({ inputs }) => ({
    geometry: { kind: 'plane', width: positive('Width', inputs.width), height: positive('Height', inputs.height) },
  }),
});

const sceneCylinder = defineNode<
  { radiusTop: number; radiusBottom: number; height: number; radialSegments: number },
  { geometry: GeometryDesc }
>({
  type: 'scene.cylinder',
  label: 'Cylinder',
  category: 'Geometry',
  inputs: {
    radiusTop: { type: 'number', default: 0.5 },
    radiusBottom: { type: 'number', default: 0.5 },
    height: { type: 'number', default: 1 },
    radialSegments: { type: 'number', default: 32 },
  },
  outputs: { geometry: { type: 'geometry' } },
  evaluate: ({ inputs }) => ({
    geometry: {
      kind: 'cylinder',
      radiusTop: Math.max(0, inputs.radiusTop),
      radiusBottom: Math.max(0, inputs.radiusBottom),
      height: positive('Height', inputs.height),
      radialSegments: segments('Radial segments', inputs.radialSegments, 3),
    },
  }),
});

const sceneTorus = defineNode<
  { radius: number; tube: number; radialSegments: number; tubularSegments: number },
  { geometry: GeometryDesc }
>({
  type: 'scene.torus',
  label: 'Torus',
  category: 'Geometry',
  inputs: {
    radius: { type: 'number', default: 0.5 },
    tube: { type: 'number', default: 0.2 },
    radialSegments: { type: 'number', default: 16 },
    tubularSegments: { type: 'number', default: 48 },
  },
  outputs: { geometry: { type: 'geometry' } },
  evaluate: ({ inputs }) => ({
    geometry: {
      kind: 'torus',
      radius: positive('Radius', inputs.radius),
      tube: positive('Tube', inputs.tube),
      radialSegments: segments('Radial segments', inputs.radialSegments, 3),
      tubularSegments: segments('Tubular segments', inputs.tubularSegments, 3),
    },
  }),
});

// ---------------------------------------------------------------------------
// Scene: material, objects, lights, camera, output
// ---------------------------------------------------------------------------

const sceneStandardMaterial = defineNode<
  { color: RGB; roughness: number; metalness: number; emissive: RGB },
  { material: MaterialDesc }
>({
  type: 'scene.standardMaterial',
  label: 'Standard Material',
  category: 'Material',
  description: 'A physically based (PBR) metal/roughness material.',
  inputs: {
    color: { type: 'color', default: [0.8, 0.8, 0.8] },
    roughness: { type: 'number', default: 0.5 },
    metalness: { type: 'number', default: 0 },
    emissive: { type: 'color', default: [0, 0, 0] },
  },
  outputs: { material: { type: 'material' } },
  evaluate: ({ inputs }) => ({
    material: {
      kind: 'standard',
      color: inputs.color,
      roughness: clamp01(inputs.roughness),
      metalness: clamp01(inputs.metalness),
      emissive: inputs.emissive,
    },
  }),
});

const DEFAULT_MATERIAL: MaterialDesc = { kind: 'standard', color: [0.8, 0.8, 0.8], roughness: 0.5, metalness: 0, emissive: [0, 0, 0] };

const sceneMesh = defineNode<
  { geometry: GeometryDesc; material: MaterialDesc | undefined; position: Vec3; rotation: Vec3; scale: Vec3 },
  { object: SceneObject },
  { name: string }
>({
  type: 'scene.mesh',
  label: 'Mesh',
  category: 'Object',
  description: 'Places geometry with a material in the scene. Rotation is in degrees (XYZ order).',
  inputs: {
    geometry: { type: 'geometry' },
    material: { type: 'material', optional: true },
    position: { type: 'vec3', default: [0, 0, 0] },
    rotation: { type: 'vec3', default: [0, 0, 0] },
    scale: { type: 'vec3', default: [1, 1, 1] },
  },
  outputs: { object: { type: 'object' } },
  params: { name: { type: 'string', default: 'Mesh' } },
  evaluate: ({ inputs, params, ctx }) => ({
    object: {
      kind: 'mesh',
      origin: ctx.nodeId,
      name: params.name,
      transform: { position: inputs.position, rotation: toRadians(inputs.rotation), scale: inputs.scale },
      geometry: inputs.geometry,
      material: inputs.material ?? DEFAULT_MATERIAL,
    },
  }),
});

const sceneGroup = defineNode<
  { children: SceneObject[]; position: Vec3; rotation: Vec3; scale: Vec3 },
  { object: SceneObject },
  { name: string }
>({
  type: 'scene.group',
  label: 'Group',
  category: 'Object',
  description: 'Moves, rotates (degrees) and scales several objects together.',
  inputs: {
    children: { type: 'object', multi: true },
    position: { type: 'vec3', default: [0, 0, 0] },
    rotation: { type: 'vec3', default: [0, 0, 0] },
    scale: { type: 'vec3', default: [1, 1, 1] },
  },
  outputs: { object: { type: 'object' } },
  params: { name: { type: 'string', default: 'Group' } },
  evaluate: ({ inputs, params, ctx }) => {
    if (inputs.children.some(isCamera)) throw new Error('Cameras cannot be placed inside a group; use the Camera input of Scene Output');
    return {
      object: {
        kind: 'group',
        origin: ctx.nodeId,
        name: params.name,
        transform: { position: inputs.position, rotation: toRadians(inputs.rotation), scale: inputs.scale },
        children: inputs.children,
      },
    };
  },
});

const sceneDirectionalLight = defineNode<
  { color: RGB; intensity: number; position: Vec3 },
  { object: SceneObject },
  { name: string }
>({
  type: 'scene.directionalLight',
  label: 'Directional Light',
  category: 'Light',
  description: 'Parallel light from `position` toward the origin (like the sun).',
  inputs: {
    color: { type: 'color', default: [1, 1, 1] },
    intensity: { type: 'number', default: 1 },
    position: { type: 'vec3', default: [5, 10, 7] },
  },
  outputs: { object: { type: 'object' } },
  params: { name: { type: 'string', default: 'Sun' } },
  evaluate: ({ inputs, params, ctx }) => ({
    object: {
      kind: 'directionalLight',
      origin: ctx.nodeId,
      name: params.name,
      position: inputs.position,
      color: inputs.color,
      intensity: Math.max(0, inputs.intensity),
    },
  }),
});

const sceneAmbientLight = defineNode<{ color: RGB; intensity: number }, { object: SceneObject }, { name: string }>({
  type: 'scene.ambientLight',
  label: 'Ambient Light',
  category: 'Light',
  inputs: { color: { type: 'color', default: [1, 1, 1] }, intensity: { type: 'number', default: 0.4 } },
  outputs: { object: { type: 'object' } },
  params: { name: { type: 'string', default: 'Ambient' } },
  evaluate: ({ inputs, params, ctx }) => ({
    object: { kind: 'ambientLight', origin: ctx.nodeId, name: params.name, color: inputs.color, intensity: Math.max(0, inputs.intensity) },
  }),
});

const scenePerspectiveCamera = defineNode<
  { fov: number; near: number; far: number; position: Vec3; target: Vec3 },
  { camera: SceneObject },
  { name: string }
>({
  type: 'scene.perspectiveCamera',
  label: 'Perspective Camera',
  category: 'Camera',
  inputs: {
    fov: { type: 'number', default: 50 },
    near: { type: 'number', default: 0.1 },
    far: { type: 'number', default: 1000 },
    position: { type: 'vec3', default: [0, 2, 6] },
    target: { type: 'vec3', default: [0, 0, 0] },
  },
  outputs: { camera: { type: 'object' } },
  params: { name: { type: 'string', default: 'Camera' } },
  evaluate: ({ inputs, params, ctx }) => {
    if (!(inputs.fov > 0 && inputs.fov < 180)) throw new Error(`Field of view must be between 0 and 180 degrees (got ${inputs.fov})`);
    const near = positive('Near', inputs.near);
    if (!(inputs.far > near)) throw new Error('Far must be greater than Near');
    return {
      camera: { kind: 'perspectiveCamera', origin: ctx.nodeId, name: params.name, position: inputs.position, lookAt: inputs.target, fov: inputs.fov, near, far: inputs.far },
    };
  },
});

const sceneOutput = defineNode<
  { objects: SceneObject[]; camera: SceneObject | undefined; background: RGB },
  { scene: unknown }
>({
  type: 'scene.output',
  label: 'Scene Output',
  category: 'Output',
  description: 'The entry point: what gets previewed, rendered and exported.',
  inputs: {
    objects: { type: 'object', multi: true },
    camera: { type: 'object', optional: true },
    background: { type: 'color', default: [0.05, 0.05, 0.07] },
  },
  outputs: { scene: { type: 'scene' } },
  evaluate: ({ inputs, ctx }) => {
    if (inputs.objects.some(isCamera)) throw new Error('Connect cameras to the Camera input, not to Objects');
    if (inputs.camera !== undefined && !isCamera(inputs.camera)) throw new Error('The Camera input needs a Perspective Camera');
    const camera: PerspectiveCameraObject | null = inputs.camera !== undefined && isCamera(inputs.camera) ? inputs.camera : null;
    return { scene: { version: SCENE_IR_VERSION, origin: ctx.nodeId, background: inputs.background, objects: inputs.objects, camera } };
  },
});

/** Every node type in the standard library. */
export const standardNodes: readonly NodeTypeDef[] = [
  valueNumber,
  valueVec3,
  valueColor,
  binary('math.add', 'Add', (a, b) => a + b, 0),
  binary('math.subtract', 'Subtract', (a, b) => a - b, 0),
  binary('math.multiply', 'Multiply', (a, b) => a * b, 1),
  // Division by zero yields 0 (as in Blender) so one bad value cannot poison a whole scene with Infinity.
  binary('math.divide', 'Divide', (a, b) => (b === 0 ? 0 : a / b), 1),
  unary('math.sine', 'Sine', Math.sin),
  unary('math.cosine', 'Cosine', Math.cos),
  mathTime,
  vectorCombine,
  vectorSeparate,
  sceneBox,
  sceneSphere,
  scenePlane,
  sceneCylinder,
  sceneTorus,
  sceneStandardMaterial,
  sceneMesh,
  sceneGroup,
  sceneDirectionalLight,
  sceneAmbientLight,
  scenePerspectiveCamera,
  sceneOutput,
];

/** A registry with the scene data types and the whole standard library. */
export function createRegistry(): NodeRegistry {
  const registry = new NodeRegistry();
  registerSceneTypes(registry.types);
  registry.register(...standardNodes);
  return registry;
}

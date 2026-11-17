/**
 * Scene IR: plain, serializable data describing a scene. A node graph evaluates INTO this;
 * renderers (three.js, WebGPU, headless) and code generators read it. Nothing here knows
 * about any renderer, which is what lets one graph target many outputs.
 *
 * Conventions: right-handed, Y up, metres. Rotations are Euler XYZ in RADIANS.
 * Colours are sRGB with channels in 0..1 (what an artist sees in a picker).
 */

export const SCENE_IR_VERSION = 1;

export type Vec3 = readonly [number, number, number];
/** sRGB, each channel 0..1. */
export type RGB = readonly [number, number, number];

export interface Transform {
  readonly position: Vec3;
  /** Euler XYZ, radians. */
  readonly rotation: Vec3;
  readonly scale: Vec3;
}

export function identityTransform(): Transform {
  return { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
}

export type GeometryDesc =
  | { readonly kind: 'box'; readonly width: number; readonly height: number; readonly depth: number }
  | { readonly kind: 'sphere'; readonly radius: number; readonly widthSegments: number; readonly heightSegments: number }
  | { readonly kind: 'plane'; readonly width: number; readonly height: number }
  | { readonly kind: 'cylinder'; readonly radiusTop: number; readonly radiusBottom: number; readonly height: number; readonly radialSegments: number }
  | { readonly kind: 'torus'; readonly radius: number; readonly tube: number; readonly radialSegments: number; readonly tubularSegments: number };

export interface StandardMaterialDesc {
  readonly kind: 'standard';
  readonly color: RGB;
  readonly roughness: number;
  readonly metalness: number;
  readonly emissive: RGB;
}

export type MaterialDesc = StandardMaterialDesc;

interface ObjectBase {
  /** Id of the graph node that produced this object (links code and canvas back to the graph). */
  readonly origin: string;
  readonly name: string;
}

export interface MeshObject extends ObjectBase {
  readonly kind: 'mesh';
  readonly transform: Transform;
  readonly geometry: GeometryDesc;
  readonly material: MaterialDesc;
}

export interface GroupObject extends ObjectBase {
  readonly kind: 'group';
  readonly transform: Transform;
  readonly children: readonly SceneObject[];
}

export interface DirectionalLightObject extends ObjectBase {
  readonly kind: 'directionalLight';
  readonly position: Vec3;
  readonly color: RGB;
  readonly intensity: number;
}

export interface AmbientLightObject extends ObjectBase {
  readonly kind: 'ambientLight';
  readonly color: RGB;
  readonly intensity: number;
}

export interface PerspectiveCameraObject extends ObjectBase {
  readonly kind: 'perspectiveCamera';
  readonly position: Vec3;
  readonly lookAt: Vec3;
  /** Vertical field of view in degrees. */
  readonly fov: number;
  readonly near: number;
  readonly far: number;
}

export type SceneObject =
  | MeshObject
  | GroupObject
  | DirectionalLightObject
  | AmbientLightObject
  | PerspectiveCameraObject;

export interface SceneDescription {
  readonly version: typeof SCENE_IR_VERSION;
  /** Id of the graph node (`scene.output`) that produced the scene. */
  readonly origin: string;
  readonly background: RGB;
  readonly objects: readonly SceneObject[];
  /** The camera to render from, or null to let the target pick a default. */
  readonly camera: PerspectiveCameraObject | null;
}

const OBJECT_KINDS: ReadonlySet<string> = new Set(['mesh', 'group', 'directionalLight', 'ambientLight', 'perspectiveCamera']);
const GEOMETRY_KINDS: ReadonlySet<string> = new Set(['box', 'sphere', 'plane', 'cylinder', 'torus']);

function hasKind(value: unknown): value is { kind: unknown } {
  return typeof value === 'object' && value !== null && 'kind' in value;
}

export function isSceneObject(value: unknown): value is SceneObject {
  return hasKind(value) && typeof value.kind === 'string' && OBJECT_KINDS.has(value.kind);
}

export function isCamera(value: unknown): value is PerspectiveCameraObject {
  return hasKind(value) && value.kind === 'perspectiveCamera';
}

export function isGeometry(value: unknown): value is GeometryDesc {
  return hasKind(value) && typeof value.kind === 'string' && GEOMETRY_KINDS.has(value.kind);
}

export function isMaterial(value: unknown): value is MaterialDesc {
  return hasKind(value) && value.kind === 'standard';
}

export function isScene(value: unknown): value is SceneDescription {
  return typeof value === 'object' && value !== null && 'objects' in value && 'background' in value && 'version' in value;
}

/** Depth-first walk over objects and their children. */
export function walkObjects(
  objects: readonly SceneObject[],
  visit: (object: SceneObject, depth: number) => void,
  depth = 0,
): void {
  for (const object of objects) {
    visit(object, depth);
    if (object.kind === 'group') walkObjects(object.children, visit, depth + 1);
  }
}

export function countObjects(scene: SceneDescription): number {
  let count = 0;
  walkObjects(scene.objects, () => count++);
  return count;
}

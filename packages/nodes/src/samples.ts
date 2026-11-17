import { GraphDocument, GraphEditor, type NodeRegistry } from '@mekdeck/core';

/**
 * A small but complete scene graph: an orange cube lifted onto a floor by a little math,
 * a metallic ball, a sun, ambient light and a camera. Ids are readable and stable, so
 * sample projects are friendly to diff and to scripts.
 */
export function createSampleGraph(registry: NodeRegistry, graphId = 'main'): GraphDocument {
  const doc = new GraphDocument(registry, { id: graphId, name: 'Main scene' });
  const ed = new GraphEditor(doc);
  const link = (from: string, fromPort: string, to: string, toPort: string) =>
    ed.connect({ node: from, port: fromPort }, { node: to, port: toPort });

  ed.transaction('Create sample scene', () => {
    // Math: a cube of height 1 sits on the floor when lifted by height * 0.5.
    ed.addNode('value.number', { id: 'height', label: 'Cube height', position: { x: 0, y: 0 }, values: { value: 1 } });
    ed.addNode('math.multiply', { id: 'half', position: { x: 220, y: 0 }, values: { b: 0.5 } });
    ed.addNode('vector.combine', { id: 'lift', position: { x: 440, y: 0 } });
    link('height', 'value', 'half', 'a');
    link('half', 'result', 'lift', 'y');

    // Cube
    ed.addNode('scene.box', { id: 'box_geo', position: { x: 440, y: 160 } });
    ed.addNode('scene.standardMaterial', {
      id: 'box_mat',
      position: { x: 440, y: 300 },
      values: { color: [0.95, 0.45, 0.15], roughness: 0.35, metalness: 0.1 },
    });
    ed.addNode('scene.mesh', { id: 'box', position: { x: 700, y: 120 }, values: { rotation: [0, 30, 0] }, params: { name: 'Cube' } });
    link('box_geo', 'geometry', 'box', 'geometry');
    link('box_mat', 'material', 'box', 'material');
    link('lift', 'vector', 'box', 'position');

    // Ball
    ed.addNode('scene.sphere', { id: 'ball_geo', position: { x: 440, y: 480 } });
    ed.addNode('scene.standardMaterial', {
      id: 'ball_mat',
      position: { x: 440, y: 600 },
      values: { color: [0.2, 0.55, 0.95], roughness: 0.2, metalness: 0.6 },
    });
    ed.addNode('scene.mesh', { id: 'ball', position: { x: 700, y: 480 }, values: { position: [1.8, 0.5, 0.4] }, params: { name: 'Ball' } });
    link('ball_geo', 'geometry', 'ball', 'geometry');
    link('ball_mat', 'material', 'ball', 'material');

    // Floor
    ed.addNode('scene.plane', { id: 'floor_geo', position: { x: 440, y: 760 }, values: { width: 12, height: 12 } });
    ed.addNode('scene.standardMaterial', {
      id: 'floor_mat',
      position: { x: 440, y: 880 },
      values: { color: [0.35, 0.37, 0.4], roughness: 0.9 },
    });
    ed.addNode('scene.mesh', { id: 'floor', position: { x: 700, y: 800 }, values: { rotation: [-90, 0, 0] }, params: { name: 'Floor' } });
    link('floor_geo', 'geometry', 'floor', 'geometry');
    link('floor_mat', 'material', 'floor', 'material');

    // Lights and camera
    ed.addNode('scene.directionalLight', { id: 'sun', position: { x: 700, y: 1000 }, values: { intensity: 2.5 } });
    ed.addNode('scene.ambientLight', { id: 'ambient', position: { x: 700, y: 1120 } });
    ed.addNode('scene.perspectiveCamera', {
      id: 'cam',
      position: { x: 700, y: 1240 },
      values: { position: [3.5, 2.5, 5.5], target: [0, 0.5, 0] },
    });

    // Output
    ed.addNode('scene.output', { id: 'output', position: { x: 1000, y: 500 }, values: { background: [0.08, 0.09, 0.12] } });
    for (const id of ['box', 'ball', 'floor', 'sun', 'ambient']) link(id, 'object', 'output', 'objects');
    link('cam', 'camera', 'output', 'camera');
  });

  return doc;
}

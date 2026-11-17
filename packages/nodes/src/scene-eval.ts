import { Evaluator, MekdeckError, type EvalError, type GraphDocument, type NodeId } from '@mekdeck/core';
import { isScene, type SceneDescription } from '@mekdeck/scene';

/** The first `scene.output` node, in document order. */
export function findSceneOutput(doc: GraphDocument): NodeId | undefined {
  for (const node of doc.nodes()) if (node.type === 'scene.output') return node.id;
  return undefined;
}

export interface EvaluateSceneOptions {
  /** Which output node to evaluate (defaults to the first Scene Output). */
  readonly output?: NodeId;
  readonly time?: number;
  readonly frame?: number;
}

/**
 * Evaluate a graph into a Scene IR snapshot. If anything fails, the thrown error names the
 * node that actually caused the failure (not the downstream nodes that were merely blocked).
 */
export function evaluateScene(doc: GraphDocument, options: EvaluateSceneOptions = {}): SceneDescription {
  const outputId = options.output ?? findSceneOutput(doc);
  if (outputId === undefined) {
    throw new MekdeckError('E_NO_SCENE_OUTPUT', 'This graph has no Scene Output node, so there is nothing to render');
  }
  const evaluator = new Evaluator(doc, {
    ...(options.time !== undefined ? { time: options.time } : {}),
    ...(options.frame !== undefined ? { frame: options.frame } : {}),
  });
  try {
    const result = evaluator.evaluate(outputId);
    if (result.status === 'error') {
      const cause = rootCause(evaluator, doc, outputId);
      const node = doc.node(cause.nodeId);
      const def = node ? doc.registry.get(node.type) : undefined;
      const name = node?.label ?? def?.label ?? cause.nodeId;
      throw new MekdeckError(cause.code, `${name} (${cause.nodeId}): ${cause.message}`, { nodeId: cause.nodeId });
    }
    const scene = result.outputs.scene;
    if (!isScene(scene)) {
      throw new MekdeckError('E_BAD_SCENE', `Node "${outputId}" did not produce a scene`, { nodeId: outputId });
    }
    return scene;
  } finally {
    evaluator.dispose();
  }
}

/** Follow "blocked by upstream error" links down to the node that really failed. */
function rootCause(evaluator: Evaluator, doc: GraphDocument, start: NodeId): EvalError {
  const seen = new Set<NodeId>();
  let current = start;
  for (;;) {
    const result = evaluator.evaluate(current);
    if (result.status !== 'error') throw new Error('rootCause called on a node that did not fail');
    if (result.error.code !== 'E_UPSTREAM' || seen.has(current)) return result.error;
    seen.add(current);
    const failing = doc.edgesTo(current).find((edge) => evaluator.evaluate(edge.from.node).status === 'error');
    if (!failing) return result.error;
    current = failing.from.node;
  }
}

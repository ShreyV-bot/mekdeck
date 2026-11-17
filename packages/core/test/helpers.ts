import { GraphDocument, GraphEditor, NodeRegistry, sequentialIds, type NodeTypeDef } from '../src/index.ts';

/** How many times each test node's evaluate() actually ran. */
export const calls: Record<string, number> = {};
export function resetCalls(): void {
  for (const key of Object.keys(calls)) delete calls[key];
}

function counted(def: NodeTypeDef): NodeTypeDef {
  return {
    ...def,
    evaluate: (args) => {
      calls[def.type] = (calls[def.type] ?? 0) + 1;
      return def.evaluate(args);
    },
  };
}

export function testRegistry(): NodeRegistry {
  return new NodeRegistry().register(
    counted({
      type: 'test.num',
      label: 'Number',
      category: 'Test',
      inputs: { value: { type: 'number', default: 0 } },
      outputs: { value: { type: 'number' } },
      evaluate: ({ inputs }) => ({ value: inputs.value }),
    }),
    counted({
      type: 'test.text',
      label: 'Text',
      category: 'Test',
      inputs: { value: { type: 'string', default: '' } },
      outputs: { value: { type: 'string' } },
      evaluate: ({ inputs }) => ({ value: inputs.value }),
    }),
    counted({
      type: 'test.add',
      label: 'Add',
      category: 'Test',
      inputs: { a: { type: 'number', default: 0 }, b: { type: 'number', default: 0 } },
      outputs: { sum: { type: 'number' } },
      evaluate: ({ inputs }) => ({ sum: inputs.a + inputs.b }),
    }),
    counted({
      type: 'test.mul',
      label: 'Multiply',
      category: 'Test',
      inputs: { a: { type: 'number', default: 1 }, b: { type: 'number', default: 1 } },
      outputs: { product: { type: 'number' } },
      evaluate: ({ inputs }) => ({ product: inputs.a * inputs.b }),
    }),
    counted({
      type: 'test.sign',
      label: 'Sign',
      category: 'Test',
      inputs: { value: { type: 'number', default: 0 } },
      outputs: { sign: { type: 'number' } },
      evaluate: ({ inputs }) => ({ sign: Math.sign(inputs.value) }),
    }),
    counted({
      type: 'test.scale',
      label: 'Scale',
      category: 'Test',
      inputs: { value: { type: 'number', default: 1 } },
      outputs: { out: { type: 'number' } },
      params: { factor: { type: 'number', default: 2 }, mode: { type: 'enum', default: 'a', options: ['a', 'b'] } },
      evaluate: ({ inputs, params }) => ({ out: inputs.value * params.factor }),
    }),
    counted({
      type: 'test.list',
      label: 'List',
      category: 'Test',
      inputs: { items: { type: 'any', multi: true } },
      outputs: { list: { type: 'any' } },
      evaluate: ({ inputs }) => ({ list: inputs.items }),
    }),
    counted({
      type: 'test.vec',
      label: 'Vector sink',
      category: 'Test',
      inputs: { v: { type: 'vec3', default: [0, 0, 0] } },
      outputs: { v: { type: 'vec3' } },
      evaluate: ({ inputs }) => ({ v: inputs.v }),
    }),
    counted({
      type: 'test.required',
      label: 'Required',
      category: 'Test',
      inputs: { x: { type: 'number' } },
      outputs: { x: { type: 'number' } },
      evaluate: ({ inputs }) => ({ x: inputs.x }),
    }),
    counted({
      type: 'test.time',
      label: 'Time',
      category: 'Test',
      inputs: {},
      outputs: { t: { type: 'number' } },
      volatile: true,
      evaluate: ({ ctx }) => ({ t: ctx.time }),
    }),
    counted({
      type: 'test.boom',
      label: 'Boom',
      category: 'Test',
      inputs: {},
      outputs: { out: { type: 'number' } },
      evaluate: () => {
        throw new Error('kaboom');
      },
    }),
  );
}

export function newDoc(registry = testRegistry()): GraphDocument {
  return new GraphDocument(registry, { id: 'g_test', name: 'Test', ids: sequentialIds() });
}

export function newEditor(registry = testRegistry()): GraphEditor {
  return new GraphEditor(newDoc(registry));
}

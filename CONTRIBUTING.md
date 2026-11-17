# Contributing to MekDeck

Thank you for helping. MekDeck is ambitious, and the only way it gets there is through many careful contributions. This guide is short on purpose.

## Setup

You need **Node.js 22.18 or newer** (it runs TypeScript directly) and **pnpm**.

```sh
git clone <your-fork-url> mekdeck
cd mekdeck
pnpm install
pnpm check          # typecheck + all tests; should be green before you change anything
```

| Command | What it does |
| --- | --- |
| `pnpm test` | Runs every test with Node's built-in test runner |
| `pnpm typecheck` | Type-checks all packages with `tsc` (no build output) |
| `pnpm check` | Both of the above. CI runs this on Linux, macOS and Windows |
| `pnpm mekdeck <command>` | Runs the CLI from source |

To run one test file: `node --test packages/core/test/graph.test.ts`.

There is no build step yet: packages are run from source. Code is written in the "erasable" subset of TypeScript (no `enum`, no `namespace`, no constructor parameter properties) and imports use the `.ts` extension, for example `import { x } from './x.ts'`.

## Principles

These are the rules that keep the project healthy. Reviews check them.

1. **Zero dependencies in the core packages.** A new runtime dependency needs a written reason in the PR: what it does, why not 50 lines of our own, and its maintenance and security record.
2. **`core` and `format` stay portable.** No `node:` imports, no DOM. They must run in a browser, a Worker and Node. File-system access belongs in `cli` (and later the desktop shell).
3. **Untrusted input is the default.** Anything that reads a file, zip, graph or script from outside must validate it and have a test that feeds it something hostile.
4. **Nodes are pure.** The same inputs and params give the same outputs; no clock, no randomness, no I/O. That is what makes caching and code generation valid.
5. **Every change to a document is an operation.** Do not mutate a `GraphDocument` any other way.
6. **Errors have stable codes** (`E_SOMETHING`) and name the actual cause. Do not match on message text; add a code.
7. **Deterministic output.** Same input, same bytes. No timestamps, no `Math.random()`, no object-key-order dependence in anything that is written to a file.
8. **Tests are part of the change.** A bug fix starts with a test that fails. A feature ships with tests for the happy path and for the failure cases.

## Adding a node type

Node types are the easiest and most useful contribution. Here is a complete one. It raises a number to a power and returns `0` instead of `NaN` or `Infinity`:

```ts
import { defineNode } from '@mekdeck/core';

export const mathPower = defineNode<{ base: number; exponent: number }, { result: number }>({
  type: 'math.power',
  label: 'Power',
  category: 'Math',
  description: 'base raised to the exponent (0 if the result is not a finite number).',
  inputs: {
    base: { type: 'number', default: 1 },
    exponent: { type: 'number', default: 1 },
  },
  outputs: { result: { type: 'number' } },
  evaluate: ({ inputs }) => {
    const result = inputs.base ** inputs.exponent;
    return { result: Number.isFinite(result) ? result : 0 };
  },
});
```

Steps:

1. Put the definition in `packages/nodes/src/library.ts` next to its relatives, and add it to the `standardNodes` list near the bottom of the file.
2. Choose the `type` id as `<area>.<name>` in lower case. **Ids are forever**: they are written into users' files. Renaming one breaks every project that uses it.
3. Write a `description`. It becomes the in-app help.
4. Add a test in `packages/nodes/test/nodes.test.ts`: a normal case, an edge case (here a negative base with a fractional exponent), and, if it should be volatile (depends on time), that it re-evaluates on `setTime`.
5. Run `pnpm check`.

Conventions: angles in node inputs are **degrees**, colours are **sRGB 0 to 1**, lengths are **metres**, Y is up (see [ARCHITECTURE](ARCHITECTURE.md#scene-ir-conventions)). A node that depends on time must set `volatile: true`; nothing else may.

## Changing the file format

The `.mekd` format is a compatibility promise to every user's files. Read [the spec](docs/spec/mekd-format.md) first. Rules:

- Adding an optional file or field is fine and needs no version bump.
- Anything an old version would misread requires a new `formatVersion`, a migration, and an ADR in `docs/decisions/`.
- Never remove or reinterpret a field in place.
- Changes that touch the reader need a test that attacks it.

## Pull requests

- One logical change per PR. Small PRs get reviewed faster.
- Explain *why*, not only *what*.
- Keep `pnpm check` green on all three operating systems (CI will tell you).
- Update the docs if behaviour changed: a spec, the README status table, or a comment.
- Use clear commit messages in the imperative mood ("Add power node", not "added stuff").

Larger ideas (a new package, a new file-format version, a new dependency, a new target) are best discussed in an issue first, so nobody spends a week on something that needs a different direction.

## Reporting bugs and security problems

Bugs: open an issue with the steps to reproduce, what you expected and what happened. A minimal `.mekd` that shows the problem is gold.

Security problems (especially anything where a crafted file or zip does something it should not): **do not open a public issue.** See [SECURITY.md](SECURITY.md).

## Good first issues

- Add a node: `math.clamp`, `math.lerp`, `math.abs`, `vector.length`, `vector.normalize`, `scene.cone`, `scene.pointLight`.
- Add a code-generation feature the Scene IR already supports but the three.js output does not.
- Write a test that tries to break the zip reader or the project loader.
- Improve an error message that left you confused.
- Documentation: a tutorial, a diagram, a typo.

## Conduct

Be kind, assume good faith, critique code not people. A formal Code of Conduct (the Contributor Covenant) is on the [roadmap](ROADMAP.md#open-decisions) and will be adopted before the project accepts outside contributions at scale.

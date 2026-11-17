import { writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { generateProject, TARGETS } from '@mekdeck/codegen';
import { GraphDocument, hasErrors, isMekdeckError, MekdeckError, stableStringify, type Diagnostic } from '@mekdeck/core';
import { createProject, packProject, projectToFiles, type MekdProject } from '@mekdeck/format';
import { createRegistry, createSampleGraph, evaluateScene } from '@mekdeck/nodes';
import type { SceneDescription } from '@mekdeck/scene';
import { exists, loadProject, writeFolder, type LoadedProject } from './fs-project.ts';
import { VERSION } from './version.ts';

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
  cwd: string;
  /** ISO timestamp source (injectable so tests and scripts can be reproducible). */
  now?: () => string;
}

class UsageError extends Error {}

const HELP = `MekDeck ${VERSION}: build 3D websites, games and tools

Usage: mekdeck <command> [options]

Commands:
  new <dir>        Create a sample project folder
  pack <dir>       Pack a project folder into a .mekd file
  unpack <file>    Unpack a .mekd or export .zip into a project folder
  validate <path>  Check a .mekd, .zip or project folder for problems
  inspect <path>   Show what a project contains
  eval <path>      Evaluate the scene graph and print the Scene IR as JSON
  codegen <path>   Generate a runnable project (${TARGETS.join(', ')}) into a folder
  export <path>    Export a distributable .zip: the project plus generated code
  import <zip>     Convert any MekDeck .zip into a .mekd file

<path> is a project folder, a .mekd file or an export .zip.

Options:
  -o, --out <path>   Output file or folder
      --target <id>  Code target: ${TARGETS.join(', ')} (default: ${TARGETS[0]})
      --graph <id>   Graph to use (default: the project's entry graph)
      --time <sec>   Playhead time for eval, codegen and export (default: 0)
      --name <text>  Project name for "new"
      --force        Write into existing output
  -h, --help         Show this help
  -v, --version      Show the version
`;

const OPTIONS = {
  out: { type: 'string', short: 'o' },
  target: { type: 'string' },
  graph: { type: 'string' },
  time: { type: 'string' },
  name: { type: 'string' },
  force: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

function parse(args: readonly string[]) {
  try {
    return parseArgs({ args: [...args], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

function single(positionals: string[], usage: string): string {
  if (positionals.length !== 1) throw new UsageError(`Usage: ${usage}`);
  return positionals[0]!;
}

const open = (io: CliIo, typed: string): Promise<LoadedProject> => loadProject(resolve(io.cwd, typed), typed);

const nowOf = (io: CliIo): string => (io.now ?? (() => new Date().toISOString()))();
const stem = (path: string): string => basename(path, extname(path));

function slug(name: string): string {
  const s = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s === '' ? 'mekdeck-project' : s.slice(0, 60);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 ** 2).toFixed(1)} MiB`;
}

function line(d: Diagnostic): string {
  const where = [d.path, d.node ? `[${d.node}${d.port ? `.${d.port}` : ''}]` : undefined].filter(Boolean).join(' ');
  return `${d.severity.padEnd(7)} ${where ? `${where} ` : ''}${d.code}: ${d.message}\n`;
}

/** Stop on problems that make the project unusable (but not on mere warnings). */
function requireValid(loaded: LoadedProject): void {
  const bad = loaded.diagnostics.find((d) => d.severity === 'error');
  if (bad) throw new MekdeckError('E_PROJECT_INVALID', `${bad.message}`);
}

async function refuseExisting(path: string, shown: string, force: boolean | undefined): Promise<void> {
  if (!force && (await exists(path))) {
    throw new MekdeckError('E_OUTPUT_EXISTS', `"${shown}" already exists. Use --force to overwrite it (or write into it, for folders).`);
  }
}

function sampleProject(name: string, now: string): MekdProject {
  const project = createProject(name, now);
  project.meta.description = 'A sample MekDeck project: a cube, a ball and a floor.';
  project.meta.entryGraph = 'main';
  project.meta.generator = { name: 'mekdeck', version: VERSION };
  project.graphs.main = createSampleGraph(createRegistry()).toJSON();
  return project;
}

function pickGraph(project: MekdProject, wanted: string | undefined): string {
  const ids = Object.keys(project.graphs);
  const id = wanted ?? project.meta.entryGraph ?? (ids.length === 1 ? ids[0] : undefined);
  if (id === undefined) throw new UsageError(`This project has ${ids.length} graphs; choose one with --graph (${ids.join(', ')})`);
  if (!(id in project.graphs)) throw new MekdeckError('E_GRAPH_MISSING', `The project has no graph "${id}" (available: ${ids.join(', ') || 'none'})`);
  return id;
}

function parseTime(text: string | undefined): number {
  const time = text === undefined ? 0 : Number(text);
  if (!Number.isFinite(time) || (text !== undefined && text.trim() === '')) throw new UsageError(`--time must be a number of seconds (got "${text}")`);
  return time;
}

function sceneOf(project: MekdProject, graph: string | undefined, time: number): SceneDescription {
  const id = pickGraph(project, graph);
  const doc = GraphDocument.fromData(createRegistry(), project.graphs[id]);
  return evaluateScene(doc, { time });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

type Command = (args: string[], io: CliIo) => Promise<number>;

const commands: Record<string, Command> = {
  async new(args, io) {
    const { values, positionals } = parse(args);
    const dir = single(positionals, 'mekdeck new <dir> [--name <text>] [--force]');
    const target = resolve(io.cwd, dir);
    await refuseExisting(target, dir, values.force);
    const project = sampleProject(values.name ?? (stem(target) || 'Untitled'), nowOf(io));
    const files = await projectToFiles(project);
    await writeFolder(target, files);
    io.out(`Created ${dir} (${files.size} files)\n\nTry:\n  mekdeck validate ${dir}\n  mekdeck eval ${dir}\n  mekdeck export ${dir} --target three\n`);
    return 0;
  },

  async pack(args, io) {
    const { values, positionals } = parse(args);
    const dir = single(positionals, 'mekdeck pack <dir> [-o file.mekd] [--force]');
    const loaded = await open(io, dir);
    if (loaded.source !== 'folder') throw new UsageError('pack expects a project folder. To convert a .zip use "mekdeck import".');
    requireValid(loaded);
    const out = resolve(io.cwd, values.out ?? `${basename(resolve(io.cwd, dir))}.mekd`);
    await refuseExisting(out, values.out ?? basename(out), values.force);
    const bytes = await packProject(loaded.project);
    await writeFile(out, bytes);
    io.out(`Packed ${out} (${formatBytes(bytes.length)})\n`);
    return 0;
  },

  async unpack(args, io) {
    const { values, positionals } = parse(args);
    const file = single(positionals, 'mekdeck unpack <file> [-o dir] [--force]');
    const loaded = await open(io, file);
    if (loaded.source !== 'file') throw new UsageError('unpack expects a .mekd or .zip file, not a folder.');
    const out = resolve(io.cwd, values.out ?? stem(file));
    await refuseExisting(out, values.out ?? stem(file), values.force);
    const files = await projectToFiles(loaded.project);
    await writeFolder(out, files);
    io.out(`Unpacked ${files.size} files into ${out}\n`);
    return 0;
  },

  async validate(args, io) {
    const { positionals } = parse(args);
    const path = single(positionals, 'mekdeck validate <path>');
    const loaded = await open(io, path);
    const diagnostics: Diagnostic[] = [...loaded.diagnostics];
    const registry = createRegistry();
    for (const [id, graph] of Object.entries(loaded.project.graphs)) {
      for (const d of GraphDocument.fromData(registry, graph).validate()) diagnostics.push({ ...d, path: `graphs/${id}.graph.json` });
    }
    for (const d of diagnostics) io.out(line(d));
    const errors = diagnostics.filter((d) => d.severity === 'error').length;
    const warnings = diagnostics.filter((d) => d.severity === 'warning').length;
    if (hasErrors(diagnostics)) {
      io.out(`\n${errors} error(s), ${warnings} warning(s)\n`);
      return 1;
    }
    const p = loaded.project;
    io.out(`${warnings > 0 ? `\n${warnings} warning(s)\n` : ''}OK  ${p.meta.name}: ${Object.keys(p.graphs).length} graph(s), ${Object.keys(p.scripts).length} script(s), ${Object.keys(p.assets).length} asset(s)\n`);
    return 0;
  },

  async inspect(args, io) {
    const { positionals } = parse(args);
    const loaded = await open(io, single(positionals, 'mekdeck inspect <path>'));
    const { project: p } = loaded;
    const kind = loaded.source === 'folder' ? 'project folder' : loaded.profile === 'bundle' ? 'export bundle (.zip)' : '.mekd file';
    const rows: [string, string][] = [
      ['Project', p.meta.name],
      ...(p.meta.description ? ([['About', p.meta.description]] as [string, string][]) : []),
      ...(p.meta.author ? ([['Author', p.meta.author]] as [string, string][]) : []),
      ...(p.meta.license ? ([['License', p.meta.license]] as [string, string][]) : []),
      ['Format', `${kind}, format version 1`],
      ['Created', p.meta.createdAt],
      ['Modified', p.meta.modifiedAt],
      ['Entry graph', p.meta.entryGraph ?? '(none)'],
    ];
    for (const [k, v] of rows) io.out(`${`${k}:`.padEnd(13)}${v}\n`);
    const section = (title: string, items: string[]) => {
      io.out(`\n${title} (${items.length})\n`);
      for (const item of items) io.out(`  ${item}\n`);
    };
    section('Graphs', Object.entries(p.graphs).map(([id, g]) => `${id.padEnd(16)} "${g.name}"  ${Object.keys(g.nodes).length} nodes, ${Object.keys(g.edges).length} edges`));
    section('Scripts', Object.entries(p.scripts).map(([path, src]) => `${path.padEnd(32)} ${formatBytes(src.length)}`));
    section('Assets', Object.entries(p.assets).map(([path, data]) => `${path.padEnd(32)} ${formatBytes(data.length)}`));
    if (Object.keys(p.unknown).length > 0) section('Other files', Object.entries(p.unknown).map(([path, data]) => `${path.padEnd(32)} ${formatBytes(data.length)}`));
    for (const d of loaded.diagnostics) io.out(line(d));
    return 0;
  },

  async eval(args, io) {
    const { values, positionals } = parse(args);
    const path = single(positionals, 'mekdeck eval <path> [--graph <id>] [--time <sec>]');
    const time = parseTime(values.time); // check flags before touching the filesystem
    const loaded = await open(io, path);
    requireValid(loaded);
    io.out(`${stableStringify(sceneOf(loaded.project, values.graph, time))}\n`);
    return 0;
  },

  async codegen(args, io) {
    const { values, positionals } = parse(args);
    const path = single(positionals, 'mekdeck codegen <path> [--target three] [-o dir]');
    const time = parseTime(values.time);
    const loaded = await open(io, path);
    requireValid(loaded);
    const target = values.target ?? TARGETS[0];
    const generated = generateProject(sceneOf(loaded.project, values.graph, time), { target, projectName: loaded.project.meta.name });
    const out = resolve(io.cwd, values.out ?? `${slug(loaded.project.meta.name)}-${target}`);
    await refuseExisting(out, values.out ?? basename(out), values.force);
    await writeFolder(out, generated.files.map((f) => [f.path, f.content] as [string, string]));
    io.out(`Generated ${generated.files.length} files in ${out}\n${generated.files.map((f) => `  ${f.path}\n`).join('')}`);
    return 0;
  },

  async export(args, io) {
    const { values, positionals } = parse(args);
    const path = single(positionals, 'mekdeck export <path> [--target three] [-o file.zip]');
    const time = parseTime(values.time);
    const loaded = await open(io, path);
    requireValid(loaded);
    const target = values.target ?? TARGETS[0];
    const generated = generateProject(sceneOf(loaded.project, values.graph, time), { target, projectName: loaded.project.meta.name });
    const out = resolve(io.cwd, values.out ?? `${slug(loaded.project.meta.name)}-${target}.zip`);
    await refuseExisting(out, values.out ?? basename(out), values.force);
    const bytes = await packProject(loaded.project, {
      profile: 'bundle',
      generated: generated.files.map((f) => ({ path: `${target}/${f.path}`, content: f.content })),
    });
    await writeFile(out, bytes);
    io.out(`Exported ${out} (${formatBytes(bytes.length)})\nIt contains the project and a runnable ${target} app under generated/${target}/.\n`);
    return 0;
  },

  async import(args, io) {
    const { values, positionals } = parse(args);
    const file = single(positionals, 'mekdeck import <zip> [-o file.mekd]');
    const loaded = await open(io, file);
    if (loaded.source !== 'file') throw new UsageError('import expects a .zip or .mekd file, not a folder. Use "mekdeck pack" for folders.');
    requireValid(loaded);
    const out = resolve(io.cwd, values.out ?? `${stem(file)}.mekd`);
    await refuseExisting(out, values.out ?? basename(out), values.force);
    const bytes = await packProject(loaded.project);
    await writeFile(out, bytes);
    io.out(`Imported ${file} as ${out} (${formatBytes(bytes.length)})\n`);
    return 0;
  },
};

function report(error: unknown, io: CliIo): number {
  if (error instanceof UsageError) {
    io.err(`mekdeck: ${error.message}\nRun "mekdeck --help" for usage.\n`);
    return 2;
  }
  if (isMekdeckError(error)) {
    io.err(`mekdeck: ${error.message} [${error.code}]\n`);
    return 1;
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (error instanceof Error && typeof code === 'string' && /^E[A-Z]+$/.test(code)) {
    io.err(`mekdeck: ${error.message}\n`);
    return 1;
  }
  io.err(`mekdeck: unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  return 70;
}

/** Run the CLI. Returns the process exit code: 0 ok, 1 failed, 2 bad usage. */
export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '-h' || command === '--help' || command === 'help') {
    io.out(HELP);
    return 0;
  }
  if (command === '-v' || command === '--version') {
    io.out(`${VERSION}\n`);
    return 0;
  }
  const handler = Object.hasOwn(commands, command) ? commands[command] : undefined;
  if (!handler) {
    io.err(`mekdeck: unknown command "${command}"\nRun "mekdeck --help" for usage.\n`);
    return 2;
  }
  if (rest.includes('-h') || rest.includes('--help')) {
    io.out(HELP);
    return 0;
  }
  try {
    return await handler(rest, io);
  } catch (error) {
    return report(error, io);
  }
}

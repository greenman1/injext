import * as path from 'path';
import * as Handlebars from 'handlebars';
import {
    CodebaseProfile,
    MutationSpec,
    PatchPlan,
    PatchOperation,
    CreateFileOp,
    ModifyFileOp,
    AddDependencyOp,
    AddEnvOp,
    AppendFileOp,
    InsertBeforePatternOp,
} from './profile';
import { readJSON, readFile, fileExists } from '../utils/fs';

// ─── Mutation loader ──────────────────────────────────────────────────────────

const SAFE_MUTATION_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

function resolveWithin(baseDir: string, candidate: string, label: string): string {
    const resolved = path.resolve(baseDir, candidate);
    const relative = path.relative(baseDir, resolved);

    if (
        relative === '' ||
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
    ) {
        throw new Error(`${label} must resolve to a file inside ${baseDir}`);
    }

    return resolved;
}

/** Resolve the path to a built-in mutation directory.
 * Tries exact name first, then "add-{name}" prefix so that
 * `stackmod add auth` correctly resolves to mutations/add-auth/.
 */
export function resolveMutationDir(mutationName: string): string {
    if (!SAFE_MUTATION_NAME_RE.test(mutationName)) {
        throw new Error(`Invalid mutation name "${mutationName}"`);
    }

    const base = path.resolve(__dirname, '..', 'mutations');
    const direct = path.join(base, mutationName);
    const prefixed = path.join(base, `add-${mutationName}`);

    if (fileExists(path.join(direct, 'spec.json'))) return direct;
    if (fileExists(path.join(prefixed, 'spec.json'))) return prefixed;

    return prefixed;
}


export function loadMutationSpec(mutationName: string): MutationSpec {
    const dir = resolveMutationDir(mutationName);
    const spec = path.join(dir, 'spec.json');

    if (!fileExists(spec)) {
        throw new Error(
            `Unknown mutation "${mutationName}". No spec found at ${spec}`
        );
    }

    return readJSON<MutationSpec>(spec);
}

// ─── Template rendering ───────────────────────────────────────────────────────

function renderTemplate(mutationDir: string, templateFile: string, context: object): string {
    const templatesDir = path.join(mutationDir, 'templates');
    const templatePath = resolveWithin(templatesDir, templateFile, 'Template path');
    if (!fileExists(templatePath)) {
        throw new Error(`Template not found: ${templatePath}`);
    }

    const source = readFile(templatePath);
    const compiled = Handlebars.compile(source);
    return compiled(context);
}

// ─── Planner ─────────────────────────────────────────────────────────────────

/**
 * Resolve Handlebars expressions inside a spec string using the given context.
 * e.g.  "src/routes/{{routeName}}.ts" + {routeName:"users"} → "src/routes/users.ts"
 */
function resolveSpecString(value: string, context: Record<string, unknown>): string {
    return Handlebars.compile(value)(context);
}

/**
 * Convert a MutationSpec + CodebaseProfile into a concrete PatchPlan.
 * All file paths in PatchPlan.operations are ABSOLUTE.
 */
export function buildPatchPlan(
    spec: MutationSpec,
    profile: CodebaseProfile,
    params: Record<string, string> = {}
): PatchPlan {
    const mutationDir = resolveMutationDir(spec.id);
    const operations: PatchOperation[] = [];

    // Template context: profile data + caller-supplied params
    const templateContext: Record<string, unknown> = {
        framework: profile.framework,
        language: profile.language,
        template: profile.template,
        serverDir: profile.serverDir,
        sharedDir: profile.sharedDir,
        dbFile: profile.dbFile,
        rootDir: profile.rootDir,
        entryFile: profile.entryFile,
        spec,
        ...params,
    };

    // ── File creation operations ───────────────────────────────────────────────
    for (const fileSpec of spec.files) {
        // Skip files guarded for a different template
        if (fileSpec.when && fileSpec.when !== profile.template) continue;

        const resolvedPath = resolveSpecString(fileSpec.path, templateContext);
        const rendered = renderTemplate(mutationDir, fileSpec.template, templateContext);
        const absPath = resolveWithin(profile.rootDir, resolvedPath, 'Mutation output path');

        const op: CreateFileOp = {
            type: 'create_file',
            path: absPath,
            content: rendered,
        };
        operations.push(op);
    }

    // ── Entry file injection ───────────────────────────────────────────────────
    if (spec.entry_injection) {
        // Support both single injection and array of conditional injections
        const candidates = Array.isArray(spec.entry_injection)
            ? spec.entry_injection
            : [spec.entry_injection];

        // Pick first entry matching current template, fallback to first unguarded entry
        const inj = candidates.find(i => i.when === profile.template)
            ?? candidates.find(i => !i.when);

        if (inj) {
            const resolvedMount = resolveSpecString(inj.mount, templateContext);
            const resolvedImport = resolveSpecString(inj.import, templateContext);
            // Sanitize basename to a valid camelCase JS identifier
            // e.g. "auth.routes" → "authRoutes" → "authRoutesRouter"
            const importSymbol = path.basename(resolvedImport)
                .split(/[^a-zA-Z0-9]+/)
                .map((part, i) => i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1))
                .join('') + 'Router';

            if (inj.type === 'express_router') {
                const op: ModifyFileOp = {
                    type: 'modify_file',
                    path: profile.entryFile,
                    modification: 'express_inject_router',
                    mount: resolvedMount,
                    importPath: resolvedImport,
                    importSymbol,
                    beforeBodyParser: inj.before_body_parser ?? false,
                };
                operations.push(op);
            } else if (inj.type === 'replit_routes') {
                const targetFileRel = resolveSpecString(
                    inj.targetFile ?? `${profile.serverDir}/routes.ts`,
                    templateContext
                );
                const targetFileAbs = resolveWithin(profile.rootDir, targetFileRel, 'Entry injection path');

                const op: ModifyFileOp = {
                    type: 'modify_file',
                    path: targetFileAbs,
                    modification: 'replit_routes_inject',
                    mount: resolvedMount,
                    importPath: resolvedImport,
                    importSymbol,
                    beforeBodyParser: false,
                };
                operations.push(op);
            }
        }
    }

    // ── File injection operations (append / insert_before) ────────────────────
    for (const injSpec of spec.file_injections ?? []) {
        if (injSpec.when && injSpec.when !== profile.template) continue;

        const resolvedFile = resolveSpecString(injSpec.file, templateContext);
        const absPath = resolveWithin(profile.rootDir, resolvedFile, 'File injection path');
        const content = renderTemplate(mutationDir, injSpec.template, templateContext);

        if (injSpec.type === 'append') {
            const op: AppendFileOp = {
                type: 'append_file',
                path: absPath,
                content,
                guard: injSpec.guard,
            };
            operations.push(op);
        } else if ((injSpec.type === 'insert_before' || injSpec.type === 'insert_after') && injSpec.pattern) {
            const op: InsertBeforePatternOp = {
                type: 'insert_before_pattern',
                path: absPath,
                pattern: injSpec.pattern,
                content,
                guard: injSpec.guard,
            };
            operations.push(op);
        }
    }

    // ── Dependency operations ──────────────────────────────────────────────────
    for (const dep of spec.dependencies) {
        const op: AddDependencyOp = {
            type: 'add_dependency',
            name: typeof dep === 'string' ? dep : dep.name,
            version: typeof dep === 'string' ? '*' : dep.version,
        };
        operations.push(op);
    }

    // ── Environment variable stubs ─────────────────────────────────────────────
    for (const key of spec.env) {
        const op: AddEnvOp = { type: 'add_env', key };
        operations.push(op);
    }

    // ── Build convenience display lists ───────────────────────────────────────
    const filesToCreate = operations
        .filter((o): o is CreateFileOp => o.type === 'create_file')
        .map(o => path.relative(profile.rootDir, o.path));

    const filesToModify = operations
        .filter((o): o is ModifyFileOp | AppendFileOp | InsertBeforePatternOp =>
            o.type === 'modify_file' || o.type === 'append_file' || o.type === 'insert_before_pattern'
        )
        .map(o => path.relative(profile.rootDir, o.path));

    const depsToAdd = operations
        .filter((o): o is AddDependencyOp => o.type === 'add_dependency')
        .map(o => o.version === '*' ? o.name : `${o.name}@${o.version}`);

    const envToAdd = operations
        .filter((o): o is AddEnvOp => o.type === 'add_env')
        .map(o => o.key);

    return {
        mutationId: spec.id,
        version: spec.version,
        operations,
        filesToCreate,
        filesToModify,
        depsToAdd,
        envToAdd,
    };
}

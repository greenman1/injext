// Core type definitions for the StackMod Injext Engine MVP

// ─── Codebase Profile ────────────────────────────────────────────────────────

export type Framework = 'express' | 'unknown';
export type Language = 'typescript' | 'javascript' | 'unknown';
export type Template = 'replit-fullstack' | 'express' | 'unknown';

export interface CodebaseProfile {
    framework: Framework;
    language: Language;
    template: Template;        // detected project template pattern
    serverDir: string;         // dir containing entry file, e.g. 'server', 'src', or '.'
    sharedDir: string;         // dir for shared types/schema, e.g. 'shared' or same as serverDir
    dbFile: string;            // relative import path to db module, e.g. './db' or './storage'
    entryFile: string;         // absolute path to detected entry file
    rootDir: string;           // absolute project root (cwd)
    packageJson: Record<string, unknown>;
}

// ─── Mutation Spec ────────────────────────────────────────────────────────────

export interface MutationSpecFile {
    path: string;       // relative to project root, supports {{serverDir}} etc.
    template: string;   // filename of Handlebars template
    when?: Template;    // optional: only create for this template
}

export interface FileInjectionSpec {
    when?: Template;
    type: 'append' | 'insert_before' | 'insert_after';
    file: string;       // Handlebars path template
    template: string;   // HBS template file
    pattern?: string;   // regex string for insert_before/insert_after
    guard?: string;     // if this string exists in the file, skip (idempotency)
}

export interface EntryInjection {
    when?: Template;                              // optional: only apply for this template
    type: 'express_router' | 'replit_routes';
    mount: string;
    import: string;
    targetFile?: string;   // for replit_routes: file to inject into, e.g. "{{serverDir}}/routes.ts"
    before_body_parser?: boolean; // for raw-body routes such as signed webhooks
}

export interface MutationDependency {
    name: string;
    version: string;
}

export interface MutationSpec {
    id: string;
    version: string;
    description: string;
    files: MutationSpecFile[];
    file_injections?: FileInjectionSpec[];
    dependencies: Array<string | MutationDependency>;
    env: string[];
    entry_injection?: EntryInjection | EntryInjection[];
}

// ─── Patch Plan ───────────────────────────────────────────────────────────────

export interface CreateFileOp {
    type: 'create_file';
    path: string;   // absolute
    content: string;
}

export interface ModifyFileOp {
    type: 'modify_file';
    path: string;   // absolute
    modification: 'express_inject_router' | 'replit_routes_inject';
    mount: string;
    importPath: string;
    importSymbol: string;
    beforeBodyParser: boolean;
}

export interface AddDependencyOp {
    type: 'add_dependency';
    name: string;
    version: string;
}

export interface AddEnvOp {
    type: 'add_env';
    key: string;
}

export interface AppendFileOp {
    type: 'append_file';
    path: string;   // absolute
    content: string;
    guard?: string; // if this string exists in the file, skip
}

export interface InsertBeforePatternOp {
    type: 'insert_before_pattern';
    path: string;   // absolute
    pattern: string; // regex string
    content: string;
    guard?: string;
}

export type PatchOperation = CreateFileOp | ModifyFileOp | AddDependencyOp | AddEnvOp | AppendFileOp | InsertBeforePatternOp;

export interface PatchPlan {
    mutationId: string;
    version: string;
    operations: PatchOperation[];
    // Convenience accessors for display
    filesToCreate: string[];   // relative paths
    filesToModify: string[];   // relative paths
    depsToAdd: string[];
    envToAdd: string[];
}

// ─── Ledger ───────────────────────────────────────────────────────────────────

export interface LedgerEntry {
    id: string;    // rollback ID, e.g. "add-auth-1741132968000"
    mutation: string;
    version: string;
    applied_at: string;    // ISO timestamp
    files_created: string[];  // project-relative paths
    files_modified: string[];  // project-relative paths (backups stored by rollback engine)
    backup_dir: string;       // project-relative path to .injext/backups/<id>/
}

export interface Ledger {
    entries: LedgerEntry[];
}

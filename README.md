# Injext: Code Mutation Engine for Replit

> A mutation compiler that safely installs complete features into an existing codebase — auth, billing, admin dashboards, and more — as a CLI command instead of a copy-pasted tutorial.

Injext is StackMod's open-source code mutation engine for Replit-style full-stack and Express projects. It scans your project, works out how it is structured, and applies a **mutation**: a spec plus Handlebars templates that create files and inject imports or routes. Local CLI mutations are recorded in a private `.injext` ledger and can be rolled back.

The project is pre-1.0. Review every dry run and generated change before using it in production.

## Requirements

- Node.js 20 or newer
- npm
- An Express JavaScript or TypeScript project

## Current Limitations

- Framework detection is currently limited to Express.
- Injection is string- and pattern-based, so unusual project layouts or formatting may require manual edits.
- Replit-style full-stack mutations assume a React client using Wouter and shadcn/ui plus a shared Drizzle schema and conventional `App.tsx` route patterns.
- Built-in mutations generate starter implementations. Review their authentication, authorization, validation, persistence, and operational behavior against your application's requirements.

## Quick Start

```bash
# Install locked dependencies and build
npm ci
npm run build

# Link globally so `stackmod` works in any project
npm link
```

```bash
# Inside the project you want to modify
cd /path/to/your-app

stackmod scan                # inspect the detected profile (framework, entry file, etc.)
stackmod add auth            # preview + apply the auth mutation
stackmod add auth --yes      # apply without the confirmation prompt
stackmod add auth --dry-run  # print the patch plan only, don't touch anything
stackmod add route users     # parameterized mutation: creates src/routes/users.ts
stackmod history              # list applied mutations and their rollback IDs
stackmod rollback <id>        # undo a mutation: deletes created files, restores modified ones
```

Or run it directly without installing, via `ts-node`:

```bash
npx ts-node src/cli.ts add auth
```

## Built-in Mutations

| Mutation | What it adds |
|---|---|
| `auth` | JWT-based authentication (register/login/me routes + middleware) |
| `route <name>` | A named Express route module, registered in your entry file |
| `admin` | Admin dashboard with user management, role-based access, system stats |
| `analytics` | Event tracking, usage analytics, and a simple analytics dashboard |
| `api-keys` | API key generation, validation middleware, key rotation (SHA-256 hash storage) |
| `background-jobs` | In-memory job queue with retry logic, exponential backoff, status endpoint |
| `billing` | Stripe checkout, subscription management, billing portal, webhook handling |
| `feature-flags` | Feature flag CRUD, rollout percentage config, runtime toggle endpoint |
| `file-storage` | File upload via multer (local disk), validation, serve endpoint |
| `notifications` | Email notifications via nodemailer, in-memory queue, template support |
| `observability` | `/health`, `/metrics`, `/version` endpoints plus request logging middleware |

Each mutation adapts its output to your project's detected shape — e.g. `auth` targets `shared/schema.ts` + Drizzle on a Replit-style fullstack app, or an in-memory store on a plain Express app.

## How It Works

```
scan  →  plan  →  patch  →  ledger
```

1. **Scan** (`src/engine/scan.ts`) — detects the framework/template (`express` or `replit-fullstack`), the entry file, server/shared directories, and the DB access module.
2. **Plan** (`src/engine/planner.ts`) — loads the mutation's `spec.json`, renders its Handlebars templates against the detected profile, and compiles a `PatchPlan`: files to create, files to modify, dependencies to add, env vars to add.
3. **Patch** (`src/engine/patcher.ts`) — applies the plan to disk. Every file that gets modified (not created) is backed up first.
4. **Ledger** (`src/engine/ledger.ts`) — records the mutation, its id, and the backup location in `.injext/ledger.json` inside the target project, so it can be looked up (`history`) or reversed (`rollback`).

## Project Structure

```
stackmod/
  src/
    cli.ts                    ← CLI entry point (Commander)
    engine/
      profile.ts               ← Shared type definitions
      scan.ts                  ← Codebase scanner
      planner.ts                ← spec.json → PatchPlan compiler
      patcher.ts                ← Applies a plan to the filesystem
      ledger.ts                 ← Mutation history (.injext/ledger.json)
      rollback.ts                ← Reverses an applied mutation
    mutations/
      add-<name>/
        spec.json                ← Mutation spec (files, injections, deps, env)
        templates/                ← Handlebars templates
    server/
      server.ts                  ← Fastify HTTP wrapper around the CLI (see below)
    utils/
  bin/
    stackmod.js                  ← Cross-env launcher (dist/ if built, ts-node otherwise)
```

## State Files (written into the target project)

```
your-project/
  .injext/
    .gitignore           ← Prevents generated state from being committed
    ledger.json          ← Mutation history + rollback metadata
    backups/
      add-auth-<ts>/      ← Pre-mutation snapshots of modified files
  .env.example            ← Env var stubs appended by mutations
```

`.injext/backups/` can contain copies of application source. StackMod writes a nested ignore file to keep this state out of Git, but you should still verify it is not tracked before pushing a target project. Delete old state securely when you no longer need rollback history.

## Writing a New Mutation

1. Create `src/mutations/<name>/spec.json` describing the files to create, any entry-file injections, dependencies, and env vars.
2. Add the corresponding Handlebars templates under `src/mutations/<name>/templates/`.
3. Run `stackmod add <name>` inside a test project to iterate. `test-fixture/` is a minimal Express project kept in the repo for exactly this.

No registry or extra config needed — dropping a folder into `src/mutations/` is enough to make `stackmod add <name>` work.

## Self-Hosting the Engine

The CLI is the core of the project and works entirely offline. `src/server/server.ts` is an optional Fastify wrapper: `POST` a tar.gz project to `/mutate?mutation=<name>` and receive a tar.gz containing only changed files.

The HTTP engine requires a bearer token and rejects archive links, traversal paths, `.git` data, `.injext` state, and requests over configured limits. It is still a code-processing service: deploy it in an isolated runtime behind network controls, TLS, rate limiting, logging, and resource quotas.

To run it yourself:

```bash
npm run build
export STACKMOD_API_TOKEN="$(openssl rand -hex 32)"
npm start
```

Or with Docker:

```bash
docker build -t stackmod-engine .
docker run --rm -p 3000:3000 \
  -e STACKMOD_API_TOKEN="$STACKMOD_API_TOKEN" \
  stackmod-engine
```

Example client-side usage:

```bash
tar -czf /tmp/sm.tar.gz --exclude=.git --exclude=node_modules --exclude=.injext -C . . && \
curl -X POST "http://localhost:3000/mutate?mutation=auth" \
  -H "Authorization: Bearer $STACKMOD_API_TOKEN" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @/tmp/sm.tar.gz \
  -o /tmp/sm-result.tar.gz && \
tar -xzf /tmp/sm-result.tar.gz -C .
```

Hosted responses intentionally omit the server-side ledger and backups because they contain environment-specific paths and source snapshots. Use version control or your own local backup before extracting a hosted result.

See `.env.example` for optional upload, extraction, entry-count, timeout, and port limits.

## Status

| Feature | Status |
|---|---|
| Codebase scanner (Express, Replit fullstack) | ✅ |
| Mutation spec + Handlebars templates | ✅ |
| Entry-file injection (string-based) | ✅ |
| `package.json` / `.env.example` updates | ✅ |
| Ledger, idempotency, rollback | ✅ |
| 11 built-in mutations | ✅ |
| Authenticated hosted HTTP engine (Fastify) | ✅ (deployment hardening still required) |
| AST-based injection | 🔜 |
| Mutation registry / third-party mutations | 🔜 |

## Development and Security

Run `npm test` for the engine integration tests or `npm run check` for the complete local release check.

See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute, [SECURITY.md](SECURITY.md) to report vulnerabilities privately, and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community expectations.

## License

[MIT](LICENSE)

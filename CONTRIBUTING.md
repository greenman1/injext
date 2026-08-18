# Contributing

Contributions are welcome through GitHub issues and pull requests.

Read [the architecture guide](docs/ARCHITECTURE.md) for the engine and mutation contracts and [the vision document](docs/VISION.md) for the design questions the project is exploring.

## Development

Requirements:

- Node.js 20 or newer
- npm

```bash
npm ci
npm test
npm run check
```

Keep changes focused, add or update tests for behavior changes, and never commit credentials, `.env` files, `.injext` state, generated archives, build output, or dependency directories.

## Pull requests

1. Explain the problem and the chosen approach.
2. Include reproduction or verification steps.
3. Confirm that `npm run check` passes.
4. Call out security-sensitive behavior, breaking changes, or new dependencies.

By contributing, you agree that your contribution is licensed under the repository's MIT License.

# Security Policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use [GitHub private vulnerability reporting](https://github.com/greenman1/injext/security/advisories/new) and include the affected version, reproduction steps, impact, and any suggested mitigation. Please allow a reasonable remediation window before public disclosure.

## Supported versions

Security fixes are provided for the latest release. The `main` branch is development code and may change without notice.

## Deployment note

The CLI runs with the invoking user's filesystem permissions and modifies the selected project. Review a dry run before applying a mutation to valuable code.

The optional HTTP engine processes untrusted project archives and must not be exposed without its required bearer token, network-level access controls, request limits, monitoring, and an isolated runtime. Rotate `STACKMOD_API_TOKEN` immediately if it may have been disclosed.

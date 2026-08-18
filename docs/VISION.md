# Injext vision

## The thesis

AI coding agents can reason through a wide range of software tasks, but they often solve the same classes of change from first principles each time.

Injext explores a complementary abstraction:

> Turn known classes of software change into structured, reusable, inspectable mutations that a developer or AI system can invoke.

The underlying question is not whether generative AI belongs in software development. It is where probabilistic reasoning creates the most value—and where a stable operation should be elevated into a deterministic capability.

## The capability boundary

An effective AI-assisted engineering system can use different mechanisms for different kinds of work.

Reasoning is valuable when the system must:

- understand an ambiguous goal;
- inspect unfamiliar architecture;
- choose among approaches;
- determine whether a known capability fits;
- fill in application-specific decisions;
- review failures and adapt.

Deterministic execution is valuable when the system should:

- apply a previously defined transformation;
- enforce path and input constraints;
- produce the same class of operation repeatedly;
- expose the intended change for inspection;
- record what happened;
- support controlled recovery.

In that model, an agent does not disappear. It moves up a level: from regenerating every implementation detail to selecting, parameterizing, composing, and validating capabilities.

## Why a mutation rather than another prompt?

A prompt is flexible, but its procedure is implicit. A mutation makes the procedure an artifact.

That artifact can carry:

- an explicit set of files and injections;
- target-shape conditions;
- dependency and environment requirements;
- implementation templates;
- version metadata.

Injext can then record an application of that artifact in its local ledger. Because the procedure is source-controlled, it also becomes a stable target for tests and security review. This does not make the result universally correct. A predefined transformation can still encode bad assumptions, target the wrong project shape, or emit code that needs substantial adaptation. The value is that those assumptions become visible and improvable in one place.

## Why this is more than file generation

Injext operates on an existing application:

- it profiles the project before selecting templates;
- it creates files and injects imports, routes, and schema fragments;
- it updates dependencies and environment stubs;
- it backs up modified files and records local mutation state;
- it can expose the same engine through a remote archive-processing adapter.

The current transformation layer is text-based and convention-driven. That is enough to test the abstraction, while also making clear why richer preconditions, AST-aware operations, compatibility metadata, and post-application validation matter.

## What the prototype demonstrates

The repository demonstrates that a relatively small shared engine can support a varied library of software capabilities:

- authentication and admin access;
- billing and signed webhooks;
- API keys and feature flags;
- analytics and notifications;
- background jobs, file storage, observability, and generic routes.

The important artifact is not any single generated feature. It is the representation that lets those features share one scan–plan–patch–record lifecycle.

It also demonstrates two invocation surfaces:

- a local CLI for human-controlled application and rollback;
- an authenticated HTTP adapter that external systems can call.

There is no built-in agent runtime today. The prototype establishes a callable deterministic layer that an agent platform could integrate with.

## Open architectural questions

Moving from a mutation engine to a dependable agent-capability platform raises questions the current prototype does not yet answer:

### Discovery and contracts

How should an agent discover available mutations, understand typed parameters, inspect preconditions, and know what evidence is required before invocation?

### Compatibility

How should a mutation express supported frameworks, versions, project conventions, required files, and expected anchors? What should happen when a target only partially matches?

### Composition

How should the system plan multiple mutations, order dependencies, detect conflicting edits, and reconcile overlapping assumptions?

### Validation

What postconditions should prove that a mutation succeeded—type checking, tests, schema checks, static analysis, runtime probes, or all of them?

### Trust and provenance

How should teams decide which mutation authors and versions are allowed? What signing, review, policy, and audit mechanisms belong around third-party capabilities?

### Isolation

What execution model safely handles untrusted projects and mutations while preserving enough filesystem and tool access to do useful work?

### Agent feedback

When a deterministic operation cannot match a target project, what structured failure information should return to the agent so reasoning can resume productively?

## Direction

The near-term value is a better-tested mutation format and execution engine for known TypeScript application shapes.

The longer-term opportunity is broader: a capability layer where agents can discover reliable operations, reason about when to use them, and spend their model context on the parts of engineering that are genuinely specific to the problem.

AI is not interesting only because it can rebuild existing software faster. It also makes new system boundaries practical. Injext is an experiment in one of those boundaries.

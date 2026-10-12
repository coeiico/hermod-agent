# Code Design

> **Write no more code than the problem and its known constraints require.**

Optimise for correctness, clarity, and total system complexity—not brevity, line count, symmetry, or theoretical purity.

## Precedence

1. Correctness, security, and clear behaviour win.
2. Follow the language, framework, and project’s coherent local conventions.
3. Then apply the preferences below.

Do not introduce a new pattern merely for stylistic consistency.

## Simplicity

* Implement the current requirement and known constraints. Do not add speculative options, hooks, parameters, or generality.
* Prefer straightforward code over clever compression.
* Remove code that has become unnecessary, but never treat a smaller diff or fewer lines as an objective by itself.
* Use the simplest construct that accurately represents the responsibility. Choose functions, classes, composition, inheritance, or other mechanisms according to the problem and ecosystem.
* Comments should explain intent, constraints, trade-offs, or non-obvious behaviour. Do not use comments to compensate for unnecessarily obscure code.

## Responsibilities and flow

* Keep each unit focused on a coherent responsibility and abstraction level.
* Split code when doing so clarifies ownership, invariants, testing, reuse, or control flow—not merely to make functions shorter.
* Prefer clear control flow. Use guard clauses when they simplify the path; do not flatten code mechanically.
* Separate pure computation from side effects when it improves reasoning and testing. Keep I/O, mutation, time, randomness, and external state explicit.
* Group values into a named type when they form one meaningful concept or share invariants—not according to a fixed parameter count.

## Abstractions

* Introduce an abstraction when it represents a stable concept, boundary, invariant, or meaningful variation and reduces total complexity.
* Repetition is evidence for an abstraction, not sufficient proof.
* Prefer limited duplication over a shared abstraction that requires flags, unrelated options, or knowledge of every caller.
* Every layer must provide meaningful separation, ownership, policy, adaptation, or reuse. Remove forwarding layers that add none.
* A single-implementation interface is valid when it marks a genuine contract or dependency boundary.

## Data and state

* Model important states and transitions explicitly.
* Use types and invariants to prevent meaningful invalid states when proportionate to the risk and complexity.
* Convert untrusted input into trusted representations at boundaries, and enforce invariants whenever data crosses a new trust boundary or changes state.
* Avoid unrelated optional fields standing in for distinct states.
* Prefer immutable values when they simplify reasoning, but allow controlled mutation where lifecycle, performance, framework, or persistence requirements justify it.

## Dependencies and boundaries

* Dependencies should follow clear responsibility, ownership, and stability boundaries.
* Keep core policy independent of volatile frameworks, providers, and delivery mechanisms when that separation provides real value.
* Respect module encapsulation. Expand an interface deliberately when another module genuinely requires behaviour it owns.
* Expose the smallest useful public surface.

## Errors and resilience

* Handle an error at the lowest boundary that has enough knowledge to recover, retry, degrade, translate, or report it correctly. Otherwise propagate it with useful context.
* Never silently discard unexpected failure or continue with state known to be corrupt.
* Intentional fallback, partial processing, or degradation must be explicit and observable.
* Error messages should identify the failed expectation and relevant safe context without exposing secrets or sensitive data.
* Preserve original causes when translating errors.

## Production constraints

* Treat security, compatibility, resource lifetime, concurrency, cancellation, idempotency, observability, and performance as requirements when relevant.
* Add or update verification proportionate to the behavioural change.
* Prefer designs whose failure modes and operational behaviour are understandable.

## Change discipline

* Keep changes within the task’s genuine blast radius.
* Improve adjacent code only where the requested change already requires touching it or where leaving it unchanged would make the result unsafe or incoherent.
* Do not apply these preferences retroactively across unrelated code.
* When a guideline conflicts with the correct solution or an established ecosystem requirement, choose the correct solution.
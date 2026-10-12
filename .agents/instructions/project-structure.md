# Project Structure

Structure the repository so it communicates the system’s responsibilities, boundaries, and operational shape—not merely the frameworks, patterns, or tools used to implement them.

A reader should be able to predict where code belongs from what it means, who owns it, and what role it plays.

## Precedence

Apply structural decisions in this order:

1. Follow layouts required or strongly established by the language, framework, build system, or tool.
2. Follow the project’s existing coherent structure.
3. Then organise new boundaries according to the principles below.

Do not introduce indirection merely to hide conventional files or framework structure.

## Boundaries

Prefer directories that represent cohesive responsibilities, such as product capabilities, domain concepts, interfaces, integrations, operational concerns, or repository support.

Do not create directories solely because files share an implementation pattern such as handlers, services, processors, or helpers, unless that pattern is itself a meaningful architectural boundary.

Keep code that changes together close together. Place cross-cutting code outside a capability only when it is genuinely shared and has a clear responsibility.

Generic buckets such as `common/`, `utils/`, `helpers/`, and `misc/` require scrutiny. Use them only when no more meaningful and stable boundary exists.

Similar terms may coexist when they represent different concepts. Do not use near-synonyms for the same architectural role.

## Depth and nesting

Keep the tree as flat as the domain allows. Depth should express real containment, ownership, or dependency structure—not the desire to subdivide a directory that has simply grown long.

A nested boundary earns its existence the same way a top-level one does: it separates responsibilities, dependencies, ownership, or lifecycle concerns that actually differ. A directory whose children all share the parent's responsibility and dependencies adds a path segment without adding meaning; keep those files flat.

Add a level of nesting when a concept has its own internal parts that a reader would look for *within* it, and when those parts are not referenced independently from outside. Promote a nested concept to a higher boundary when it begins to be owned, depended on, or evolved independently of its parent—at that point the nesting misrepresents the dependency structure.

Prefer paths that stay predictable and readable as phrases. If a reader can no longer guess an item's location from its meaning, or a path accumulates segments that repeat or restate one another, the nesting has outrun its value—flatten or rename until placement is obvious again.

## Placement

Place an item according to its primary responsibility and owner.

Ask:

1. What responsibility or concept does it represent?
2. Which boundary owns that responsibility?
3. What depends on it, and what may it depend on?
4. Is the implementation part of its meaning, or merely replaceable machinery?
5. Would a reader reasonably look for it here?

Stable domain and architectural boundaries should not expose incidental implementation details. Technology-specific adapters and operational definitions should name their implementation honestly.

A directory boundary is meaningful only when its responsibilities and dependency direction are coherent.

## Operations and tooling

Keep product behaviour, operational infrastructure, and developer tooling distinguishable, while following ecosystem conventions.

Encode repeatable build, test, deployment, migration, and operational procedures in version-controlled executable or declarative automation. Do not leave essential procedures only in shell history, chat, or personal knowledge.

Use root-level bridges only when they provide genuine integration value. Do not add indirection solely for structural purity.

## Change discipline

Do not restructure unrelated working code merely to express a preference.

Restructure when the current layout causes material ambiguity, coupling, dependency problems, unclear ownership, poor discoverability, or friction for the requested work.

Do not add speculative boundaries. A boundary earns its existence by separating responsibilities, dependencies, ownership, or lifecycle concerns that actually differ.

Clarity, convention, consistency, and coherent dependencies outrank visual elegance.

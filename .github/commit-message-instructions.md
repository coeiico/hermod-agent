# Commit message instructions

Use Conventional Commits

<type>(<optional-scope>): <description>

Allowed types:
- feat
- fix
- docs
- style
- refactor
- perf
- test
- build
- ci
- chore
- revert

Scope examples:
- api
- auth
- ui
- db
- cli
- config
- deps
- routing
- validation
- logging
- cache
- payments
- users
- admin
- search
- email
- tests
- docs
- build

Examples of valid output:
feat(auth): add refresh token support
fix(api): handle missing user id
refactor(database): simplify query builder
chore: update dependencies
feat(auth): add MFA support
fix(api): reject malformed requests
refactor(db): simplify transaction handling
perf(cache): reduce lookup latency
test(payments): cover failed transactions
docs(cli): document login command
ci(build): cache dependencies

Examples of INVALID output:
Add refresh token support
Updated dependencies
Implement user authentication

Rules:
- Use lowercase for type and description.
- Use imperative mood.
- Do not capitalize the first word of the description.
- Do not end the subject line with a period.
- Prefer a single-line commit message.
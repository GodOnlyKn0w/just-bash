/**
 * Documentation validation for README.md and SKILL.md.
 *
 * Goals:
 *   1. Both files exist and have substantive content.
 *   2. SKILL.md has the expected agent-facing structure (frontmatter, sections).
 *   3. Every fenced TypeScript code block in either file parses as valid TS
 *      syntax. We do NOT type-check (many snippets reference undeclared
 *      identifiers like INTROSPECTION_JSON or `tools.foo.bar` proxy access);
 *      syntax-only catches typos that would mislead readers.
 */
export {};

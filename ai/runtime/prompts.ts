// Rendering an agent's task.md. Deliberately tiny: MV3 extension pages and
// workers forbid eval, which rules out compiling template engines, and the
// prompts only need variable substitution.

const PLACEHOLDER = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * Replaces `{{ name }}` with `variables.name`. A placeholder without a variable
 * fails the render: left lenient, a misspelt or missing input would render as
 * nothing and the model would reason without it, unnoticed.
 */
export function renderTemplate(template: string, variables: Readonly<Record<string, string>>, label: string): string {
  const rendered = template.replace(PLACEHOLDER, (_, name: string) => {
    const value = variables[name];
    if (value === undefined) throw new Error(`${label} uses {{ ${name} }}, which was not given.`);
    return value;
  });
  return rendered.trim();
}

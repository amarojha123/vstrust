export default { darkMode: ['class', '[data-theme="dark"]'], content: ['./index.html', './src/**/*.{ts,tsx}'],
theme: { extend: {
 colors: { paper: 'rgb(var(--paper) / <alpha-value>)', surface: 'rgb(var(--surface) / <alpha-value>)', ink: 'rgb(var(--ink) / <alpha-value>)', muted: 'rgb(var(--muted) / <alpha-value>)', line: 'rgb(var(--line) / <alpha-value>)', seal: 'rgb(var(--seal) / <alpha-value>)',
  sev: { critical: 'rgb(var(--sev-critical) / <alpha-value>)', high: 'rgb(var(--sev-high) / <alpha-value>)', medium: 'rgb(var(--sev-medium) / <alpha-value>)', low: 'rgb(var(--sev-low) / <alpha-value>)' } },
 fontFamily: { sans: ['"IBM Plex Sans"', 'system-ui', 'sans-serif'], display: ['"Source Serif 4"', 'Georgia', 'serif'] } } } }

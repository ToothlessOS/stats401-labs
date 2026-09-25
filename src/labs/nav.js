// Shared navigation bar. Imported by every page entry so the page links
// live in exactly one place. Uses import.meta.env.BASE_URL so paths stay
// correct under the /stats401-labs/ GitHub Pages subpath and the local
// /stats401-labs/ Vite dev path.

const LAB_COUNT = 10;

// Pill order is this array's order. The labs are generated; pages that are
// not labs get an explicit entry. Adding a lab still needs no edit here.
// `label` is injected via innerHTML, so an ampersand must be written `&amp;`.
const pages = [
    ...Array.from({ length: LAB_COUNT }, (_, i) => ({
        href: `lab${i + 1}/`,
        label: `Lab ${i + 1}`,
    })),
    { href: 'critique/', label: 'Critique &amp; Redesign' },
];

export function mountNav(selector = '#nav') {
    const target = document.querySelector(selector);
    if (!target) return;

    // Vite guarantees a trailing slash on BASE_URL.
    const base = import.meta.env.BASE_URL.replace(/\/$/, '');

    const items = pages
        .map(p => `<a href="${base}/${p.href}">${p.label}</a>`)
        .join('');

    target.innerHTML = `<nav class="lab-nav">${items}</nav>`;
}
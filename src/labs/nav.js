// Shared navigation bar. Imported by every page entry so the Lab 1–10
// links live in exactly one place. Uses import.meta.env.BASE_URL so
// paths stay correct under the /stats401-labs/ GitHub Pages subpath
// and the local /stats401-labs/ Vite dev path.

const labs = Array.from({ length: 10 }, (_, i) => i + 1);

export function mountNav(selector = '#nav') {
    const target = document.querySelector(selector);
    if (!target) return;

    // Vite guarantees a trailing slash on BASE_URL.
    const base = import.meta.env.BASE_URL.replace(/\/$/, '');

    const items = labs
        .map(n => `<a href="${base}/lab${n}/">Lab ${n}</a>`)
        .join('');

    target.innerHTML = `<nav class="lab-nav">${items}</nav>`;
}
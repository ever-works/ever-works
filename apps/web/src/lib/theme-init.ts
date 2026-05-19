// This script should be injected inline in the <head> to avoid FOUC.
// Every browser API call is wrapped in try/catch because Brave, Safari
// ITP, private-browsing modes, and locked-down enterprise environments
// can make `localStorage` and `matchMedia` throw. An uncaught throw
// here aborts inline-script execution before React boots and leaves
// the page blank — exactly what the feature-detect-storage e2e
// contract checks for.
export const themeInitScript = `
 (function() {
    var theme = null;
    try { theme = localStorage.getItem('theme'); } catch (_) {}
    var prefersDark = false;
    try {
        prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch (_) {}
    try {
        if (theme === 'dark' || (!theme && prefersDark)) {
            document.documentElement.classList.add('dark');
        } else {
            document.documentElement.classList.remove('dark');
        }
    } catch (_) {}
})();
`;

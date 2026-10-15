// Sibling script of csp-self-inline.html. It renders nothing; it only records that it ran, so a test can
// tell whether the deck's script-src 'self' admitted a file served from the -files origin (SPEC 9.1).
document.documentElement.dataset.siblingScriptRan = 'yes';

// Inserted by a nonce-trusted script in csp-nonce-strict-dynamic.html. Under 'strict-dynamic' it runs without
// a nonce of its own. It records that it ran and adds one line of text. That text comes from an external script,
// which Strategy 2 never parses (SPEC 9.2: inline scripts only), so it has no run.
document.documentElement.dataset.dynamicScriptRan = 'yes';
var stamp = document.createElement('p');
stamp.className = 'lede';
stamp.textContent = 'Status pulled from the design-ops tracker every Monday';
document.getElementById('next').after(stamp);

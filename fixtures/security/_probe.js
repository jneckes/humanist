// Shared probe runtime for the security fixtures (fixtures/security/README.md). Loaded inline by each
// fixture (copied in by the suite; it is not a network resource). It records, for each named check, whether
// the page was blocked (good, in Protected view) or got data it should not have. The suite's own verdict for
// the network comes from its servers; the page's record is a second opinion.
(function () {
  var results = {};
  var phases = { load: false };
  function set(name, kind, status, detail) {
    results[name] = { kind: kind, status: status, detail: String(detail == null ? '' : detail).slice(0, 300) };
  }
  function errText(e) {
    return e && e.name ? e.name + ': ' + (e.message || '') : String(e);
  }
  var cfg = window.__BL_CFG || {};
  // Build a URL for one check: a host unique to the check, under the run's unique label and the test zone.
  function url(name, scheme, path) {
    var host = name + '.' + cfg.uniq + '.' + cfg.zone;
    return (scheme || 'http') + '://' + host + ':' + cfg.port + '/' + cfg.uniq + '/' + name + (path || '');
  }
  // A URL to the test host by address (the sink IP), not by name: exercises the policy for an IP literal.
  function addr(name, scheme, path) {
    return (scheme || 'http') + '://' + cfg.sink + ':' + cfg.port + '/' + cfg.uniq + '/' + name + (path || '');
  }
  window.__bl = {
    cfg: cfg,
    results: results,
    phases: phases,
    set: set,
    errText: errText,
    url: url,
    addr: addr,
    done: function (phase) {
      phases[phase || 'load'] = true;
    },
  };
})();

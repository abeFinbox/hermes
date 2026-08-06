package hera

// The fixed part of every generated k6 script.
//
// This text must stay byte-identical to HERA_PRELUDE in
// backend/src/hera/prelude.ts — the script-parity fixture diffs the two
// generators' output, so any drift fails immediately and loudly.
//
// Constraints on editing:
//   - no backticks and no "${" anywhere, so both a JS template literal and this
//     Go raw string literal can hold it unescaped
//   - ES5-style var/function only; goja is what runs this, not V8
//
// What it is: a reimplementation of the Hermes script API
// (internal/runner/sandbox.go) on k6 primitives, so user capture/validation
// scripts run VERBATIM rather than being translated. Divergences, by design:
//   - variables.set(..., 'global') is iteration-local; k6 has no DB access
//   - console.log only emits on the first iteration of VU 1
//   - there is no 2s per-script timeout
const heraPrelude = `
// ---------------------------------------------------------------------------
// Hera runtime — reimplements the Hermes script API on k6 primitives.
// ---------------------------------------------------------------------------

var HERA_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
var HERA_TOKEN = /\{\{\s*([^}\s]+)\s*\}\}/g;
var HERA_PATH_TOKEN = /^(?:\.([A-Za-z_$][A-Za-z0-9_$]*)|\[(\d+)\]|\["([^"]*)"\]|\['([^']*)'\])/;

function heraLog(msg) {
  // First iteration of VU 1 only — see the note on console.log above.
  if (__VU <= 1 && __ITER === 0) { console.log(msg); }
}

function heraFmt(v) {
  return typeof v === 'string' ? '"' + v + '"' : JSON.stringify(v);
}

// Mirrors VarScope.resolve: up to 5 passes, unknown tokens left literal.
function heraInterp(text, vars) {
  var out = String(text);
  for (var pass = 0; pass < 5; pass++) {
    if (out.indexOf('{{') === -1) { break; }
    var before = out;
    out = out.replace(HERA_TOKEN, function (whole, key) {
      var v = vars.get(key);
      return v === undefined ? whole : v;
    });
    if (out === before) { break; }
  }
  return out;
}

// Supported subset of JSONPath: dot names, [n] and ["name"] indexing. Anything
// else throws, and preflight warns about it before the run starts.
function heraJsonPath(bodyText, expression) {
  var expr = String(expression === undefined || expression === null ? '' : expression).trim();
  if (expr.charAt(0) !== '$') {
    expr = '$' + (expr.charAt(0) === '[' ? '' : '.') + expr;
  }
  var rest = expr.slice(1);
  var cur = JSON.parse(bodyText);
  while (rest.length > 0) {
    var m = HERA_PATH_TOKEN.exec(rest);
    if (m === null) { throw new Error('unsupported JSONPath for load testing: ' + expression); }
    var key = m[1] !== undefined ? m[1] : m[2] !== undefined ? Number(m[2]) : m[3] !== undefined ? m[3] : m[4];
    if (cur === null || cur === undefined) { return undefined; }
    cur = cur[key];
    rest = rest.slice(m[0].length);
  }
  return cur;
}

function heraExpect(actual) {
  return {
    toBe: function (exp) {
      if (actual !== exp) { throw new Error('expected ' + heraFmt(actual) + ' to be ' + heraFmt(exp)); }
    },
    toEqual: function (exp) {
      if (JSON.stringify(actual) !== JSON.stringify(exp)) { throw new Error('expected ' + heraFmt(actual) + ' to equal ' + heraFmt(exp)); }
    },
    toContain: function (exp) {
      if (typeof actual === 'string' || Array.isArray(actual)) {
        if (actual.indexOf(exp) === -1) { throw new Error('expected ' + heraFmt(actual) + ' to contain ' + heraFmt(exp)); }
      } else {
        throw new Error('toContain expects a string or array');
      }
    },
    toMatch: function (re) {
      var rx = typeof re === 'string' ? new RegExp(re) : re;
      if (!rx.test(String(actual))) { throw new Error('expected ' + heraFmt(actual) + ' to match ' + rx); }
    },
    toBeLessThan: function (exp) {
      if (!(Number(actual) < exp)) { throw new Error('expected ' + heraFmt(actual) + ' to be less than ' + exp); }
    },
    toBeGreaterThan: function (exp) {
      if (!(Number(actual) > exp)) { throw new Error('expected ' + heraFmt(actual) + ' to be greater than ' + exp); }
    },
    toBeDefined: function () {
      if (actual === undefined || actual === null) { throw new Error('expected value to be defined, got ' + heraFmt(actual)); }
    }
  };
}

function heraResponse(res) {
  var parsed;
  var didParse = false;
  var headers = {};
  for (var k in res.headers) {
    if (Object.prototype.hasOwnProperty.call(res.headers, k)) { headers[k.toLowerCase()] = res.headers[k]; }
  }
  var bodyText = res.body === null || res.body === undefined ? '' : String(res.body);
  return Object.freeze({
    status: res.status,
    statusText: res.status_text === undefined ? '' : res.status_text,
    headers: Object.freeze(headers),
    time: res.timings === undefined ? 0 : res.timings.duration,
    json: function () {
      if (!didParse) { parsed = JSON.parse(bodyText); didParse = true; }
      return parsed;
    },
    text: function () { return bodyText; },
    header: function (name) { return headers[String(name).toLowerCase()]; }
  });
}

// Runs a user script verbatim with the Hermes globals bound. new Function is
// goja's equivalent of node:vm here — verified working under k6.
function heraRunScript(code, res, vars, mode, ctl, stepTag) {
  if (!code || !code.trim()) { return; }
  var response = heraResponse(res);
  var variables = Object.freeze({
    get: function (key) { return vars.get(String(key)); },
    set: function (key, value, scope) {
      if (mode !== 'capture') { throw new Error('variables.set() is only available in capture scripts — use the Capture tab'); }
      var k = String(key);
      if (!HERA_VAR_NAME.test(k)) { throw new Error('Invalid variable name: ' + k); }
      var s = scope === 'global' ? 'global' : scope === 'runtime' ? 'runtime' : 'suite';
      if (s === 'global') { heraGlobalWrites.add(1, { hera_step: stepTag }); }
      vars.set(k, typeof value === 'string' ? value : JSON.stringify(value));
    }
  });
  var test = function (name, fn) {
    var testName = String(name);
    if (typeof fn !== 'function') {
      heraBool(testName, false, stepTag);
      ctl.failed = true;
      return;
    }
    try {
      fn();
      heraBool(testName, true, stepTag);
    } catch (e) {
      heraBool(testName, false, stepTag);
      ctl.failed = true;
      heraLog('test "' + testName + '" failed: ' + heraErr(e));
    }
  };
  var fail = function (message) { throw new Error(message ? String(message) : 'fail() called'); };
  var stop = function () { ctl.stopRequested = true; };
  var log = Object.freeze({
    log: function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) {
        var a = arguments[i];
        parts.push(typeof a === 'string' ? a : JSON.stringify(a));
      }
      heraLog(parts.join(' '));
    }
  });
  try {
    var fn = new Function('response', 'variables', 'expect', 'test', 'fail', 'stop', 'console', code);
    fn(response, variables, heraExpect, test, fail, stop, log);
  } catch (e) {
    ctl.failed = true;
    heraScriptErrors.add(1, { hera_step: stepTag });
    heraLog('script error: ' + heraErr(e));
  }
}

function heraErr(e) {
  return e && e.message ? e.message : String(e);
}

function heraBool(name, ok, stepTag) {
  check(null, Object.defineProperty({}, name, { value: function () { return ok; }, enumerable: true }), { hera_step: stepTag });
}

// Mirrors describeAssertion in runner/executor.ts so check names match the
// functional runner exactly.
function heraDescribe(a) {
  if (a.type === 'status-equals') { return 'status = ' + a.expected; }
  if (a.type === 'jsonpath-exists') { return a.expression + ' exists'; }
  if (a.type === 'jsonpath-equals') { return a.expression + ' = ' + a.expected; }
  if (a.type === 'header-equals') { return 'header ' + a.expression + ' = ' + a.expected; }
  if (a.type === 'body-contains') { return 'body contains "' + a.expected + '"'; }
  if (a.type === 'response-time-below') { return 'response time < ' + a.expected + 'ms'; }
  return 'assertion';
}

// Mirrors runVisualAssertion in runner/executor.ts.
function heraAssert(a, res, ctl, stepTag) {
  var r = heraResponse(res);
  var ok = false;
  try {
    if (a.type === 'status-equals') {
      ok = r.status === Number(a.expected);
    } else if (a.type === 'jsonpath-exists') {
      ok = heraJsonPath(r.text(), a.expression) !== undefined;
    } else if (a.type === 'jsonpath-equals') {
      var v = heraJsonPath(r.text(), a.expression);
      ok = (typeof v === 'string' ? v : JSON.stringify(v)) === a.expected;
    } else if (a.type === 'header-equals') {
      ok = r.header(a.expression) === a.expected;
    } else if (a.type === 'body-contains') {
      ok = r.text().indexOf(a.expected === undefined ? '' : a.expected) !== -1;
    } else if (a.type === 'response-time-below') {
      ok = r.time < Number(a.expected);
    }
  } catch (e) {
    ok = false;
    heraLog('assertion "' + heraDescribe(a) + '" errored: ' + heraErr(e));
  }
  if (!ok) { ctl.failed = true; }
  heraBool(heraDescribe(a), ok, stepTag);
}

// Mirrors runVisualCapture in runner/executor.ts.
function heraCapture(c, res, vars, ctl, stepTag) {
  var r = heraResponse(res);
  try {
    var value;
    if (c.source === 'status') {
      value = String(r.status);
    } else if (c.source === 'header') {
      value = r.header(c.expression);
      if (value === undefined) { throw new Error('header "' + c.expression + '" not present'); }
    } else if (c.source === 'body-text') {
      value = r.text();
    } else if (c.source === 'body-jsonpath') {
      var v = heraJsonPath(r.text(), c.expression);
      if (v === undefined) { throw new Error('JSONPath "' + c.expression + '" matched nothing'); }
      value = typeof v === 'string' ? v : JSON.stringify(v);
    } else {
      throw new Error('unknown capture source ' + c.source);
    }
    if (c.scope === 'global') { heraGlobalWrites.add(1, { hera_step: stepTag }); }
    vars.set(c.target, value);
  } catch (e) {
    ctl.failed = true;
    heraScriptErrors.add(1, { hera_step: stepTag });
    heraLog('capture into "' + c.target + '" failed: ' + heraErr(e));
  }
}

function heraBuildRequest(def, vars) {
  var url = heraInterp(def.url, vars);
  var qs = [];
  for (var i = 0; i < def.params.length; i++) {
    qs.push(encodeURIComponent(heraInterp(def.params[i][0], vars)) + '=' + encodeURIComponent(heraInterp(def.params[i][1], vars)));
  }
  if (qs.length > 0) { url = url + (url.indexOf('?') === -1 ? '?' : '&') + qs.join('&'); }

  var headers = {};
  for (var h = 0; h < def.headers.length; h++) {
    headers[def.headers[h][0]] = heraInterp(def.headers[h][1], vars);
  }
  if (def.auth.type === 'bearer') {
    headers.Authorization = 'Bearer ' + heraInterp(def.auth.token, vars);
  } else if (def.auth.type === 'basic') {
    headers.Authorization = 'Basic ' + b64encode(heraInterp(def.auth.username, vars) + ':' + heraInterp(def.auth.password, vars));
  }
  if (def.hostHeader) { headers.Host = def.hostHeader; }

  var body = null;
  if (def.bodyMode === 'json' || def.bodyMode === 'raw') {
    body = heraInterp(def.body, vars);
    if (def.bodyMode === 'json' && headers['Content-Type'] === undefined) { headers['Content-Type'] = 'application/json'; }
  } else if (def.bodyMode === 'form') {
    body = heraInterp(def.body, vars);
    if (headers['Content-Type'] === undefined) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
  } else if (def.bodyMode === 'form-data') {
    body = {};
    for (var f = 0; f < def.formData.length; f++) {
      var part = def.formData[f];
      if (part.kind === 'file') {
        body[part.key] = http.file(HERA_FILES[part.fileId], part.filename, part.mime);
      } else {
        body[part.key] = heraInterp(part.value, vars);
      }
    }
  }

  return {
    url: url,
    body: body,
    params: { headers: headers, tags: { hera_step: def.tag }, redirects: 0 }
  };
}

function heraSend(def, vars) {
  var built = heraBuildRequest(def, vars);
  return http.request(def.method, built.url, built.body, built.params);
}

function heraRunStep(def, vars) {
  var ctl = { failed: false, stopRequested: false };
  var res = heraSend(def, vars);

  if (def.polling && def.polling.enabled) {
    // Polling models an async pipeline: the VU waits like a real user would.
    // Attempts and total wait are recorded as Trends, which is what gives a
    // p95 on "how long until the work actually finished" under concurrency.
    var attempts = 1;
    var waited = 0;
    var interval = def.polling.intervalMs < 250 ? 250 : def.polling.intervalMs;
    heraRunScript(def.polling.stopScript, res, vars, 'poll', ctl, def.tag);
    while (!ctl.stopRequested && waited < def.polling.timeoutMs) {
      sleep(interval / 1000);
      waited = waited + interval;
      res = heraSend(def, vars);
      attempts = attempts + 1;
      ctl.stopRequested = false;
      heraRunScript(def.polling.stopScript, res, vars, 'poll', ctl, def.tag);
    }
    heraPollAttempts.add(attempts, { hera_step: def.tag });
    heraPollWaitMs.add(waited, { hera_step: def.tag });
    if (!ctl.stopRequested) {
      ctl.failed = true;
      heraBool('polling completed within ' + def.polling.timeoutMs + 'ms', false, def.tag);
      heraLog('step "' + def.name + '" polled ' + attempts + ' time(s) over ' + waited + 'ms without meeting its stop condition');
    }
  }

  for (var i = 0; i < def.assertions.length; i++) { heraAssert(def.assertions[i], res, ctl, def.tag); }
  heraRunScript(def.validateScript, res, vars, 'validate', ctl, def.tag);
  if (!ctl.failed || HERA_RUN_CAPTURES_ON_FAILURE) {
    for (var c = 0; c < def.captures.length; c++) { heraCapture(def.captures[c], res, vars, ctl, def.tag); }
    heraRunScript(def.captureScript, res, vars, 'capture', ctl, def.tag);
  }
  return !ctl.failed;
}

export default function () {
  var vars = new Map();
  for (var i = 0; i < HERA_SEED.length; i++) { vars.set(HERA_SEED[i][0], HERA_SEED[i][1]); }
  for (var s = 0; s < HERA_STEPS.length; s++) {
    var def = HERA_STEPS[s];
    var passed = true;
    group(def.name, function () { passed = heraRunStep(def, vars); });
    if (!passed && HERA_STOP_ON_FAILURE) { break; }
    if (HERA_THINK_TIME_MS > 0) { sleep(HERA_THINK_TIME_MS / 1000); }
  }
}

// Extraction lives HERE, inside the generated script, so the k6-version-coupled
// summary shape is handled in exactly one place that both backends emit
// identically. Both parsers then only ever see this frozen document.
export function handleSummary(data) {
  function metric(name) {
    var m = data.metrics[name];
    return m === undefined ? null : m;
  }
  function trend(name) {
    var m = metric(name);
    if (m === null || m.values === undefined) { return null; }
    var v = m.values;
    return {
      min: v.min === undefined ? 0 : v.min,
      avg: v.avg === undefined ? 0 : v.avg,
      p50: v.med === undefined ? 0 : v.med,
      p90: v['p(90)'] === undefined ? 0 : v['p(90)'],
      p95: v['p(95)'] === undefined ? 0 : v['p(95)'],
      p99: v['p(99)'] === undefined ? 0 : v['p(99)'],
      max: v.max === undefined ? 0 : v.max
    };
  }
  function counter(name) {
    var m = metric(name);
    return m === null || m.values === undefined || m.values.count === undefined ? 0 : m.values.count;
  }
  function rate(name) {
    var m = metric(name);
    return m === null || m.values === undefined || m.values.rate === undefined ? 0 : m.values.rate;
  }

  var checksPassed = counter('checks');
  var checksTotal = checksPassed;
  var checksMetric = metric('checks');
  if (checksMetric !== null && checksMetric.values !== undefined) {
    if (checksMetric.values.passes !== undefined) { checksPassed = checksMetric.values.passes; }
    if (checksMetric.values.fails !== undefined) { checksTotal = checksPassed + checksMetric.values.fails; }
  }

  var steps = [];
  for (var i = 0; i < HERA_STEPS.length; i++) {
    var st = HERA_STEPS[i];
    var sel = '{hera_step:' + st.tag + '}';
    steps.push({
      stepId: st.stepId,
      name: st.name,
      method: st.method,
      url: st.url,
      requests: counter('http_reqs' + sel),
      errorRate: rate('http_req_failed' + sel),
      latency: trend('http_req_duration' + sel),
      pollAttempts: trend('hera_poll_attempts' + sel),
      pollWaitMs: trend('hera_poll_wait_ms' + sel),
      scriptErrors: counter('hera_script_errors' + sel)
    });
  }

  var out = {
    heraSchema: 1,
    summary: {
      requests: counter('http_reqs'),
      errorRate: rate('http_req_failed'),
      rps: (function () {
        var m = metric('http_reqs');
        return m === null || m.values === undefined || m.values.rate === undefined ? 0 : m.values.rate;
      })(),
      iterations: counter('iterations'),
      iterationDuration: trend('iteration_duration'),
      latency: trend('http_req_duration'),
      checksPassed: checksPassed,
      checksTotal: checksTotal,
      scriptErrors: counter('hera_script_errors'),
      suppressedGlobalWrites: counter('hera_suppressed_global_writes'),
      dataSent: counter('data_sent'),
      dataReceived: counter('data_received'),
      droppedIterations: counter('dropped_iterations'),
      vusMax: (function () {
        var m = metric('vus_max');
        return m === null || m.values === undefined || m.values.max === undefined ? 0 : m.values.max;
      })()
    },
    steps: steps,
    thresholdsFailed: (function () {
      var failed = [];
      for (var key in data.metrics) {
        if (!Object.prototype.hasOwnProperty.call(data.metrics, key)) { continue; }
        var m = data.metrics[key];
        if (m.thresholds === undefined) { continue; }
        for (var t in m.thresholds) {
          if (!Object.prototype.hasOwnProperty.call(m.thresholds, t)) { continue; }
          var th = m.thresholds[t];
          var ok = th === true || (th && th.ok === true);
          if (!ok) { failed.push(key + ' ' + t); }
        }
      }
      failed.sort();
      return failed;
    })()
  };
  return { stdout: JSON.stringify(out) + '\n' };
}
`

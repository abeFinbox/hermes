package runner

import (
	"encoding/json"
	"strings"
	"time"

	"github.com/dop251/goja"
	"github.com/finbox/hermes/backend-go/internal/model"
)

// AssertionResult is re-exported from model so existing sandbox call sites and
// the parity harness keep working while the executor shares one type.
type AssertionResult = model.AssertionResult

// Sandbox for user-authored capture & validation scripts — Go port of
// backend/src/runner/sandbox.ts. Uses goja (pure-Go ECMAScript) with a hard
// timeout. The expect/test/error-formatting logic is injected AS JavaScript
// (see prelude) so it inherits identical JSON.stringify / RegExp / coercion
// semantics as the Node node:vm implementation; only host effects
// (variable get/set, logging, test results) bridge back to Go.
//
// NOTE: like node:vm, goja is not a hard security boundary. For untrusted
// multi-tenant use, add resource caps / a broker in front of this.

// SandboxResponse mirrors the TS SandboxResponse. JSON tags match the field
// names the prelude reads via JSON.parse(__respJSON).
type SandboxResponse struct {
	Status     int               `json:"status"`
	StatusText string            `json:"statusText"`
	Headers    map[string]string `json:"headers"`
	Time       float64           `json:"time"` // ms
	BodyText   string            `json:"bodyText"`
}

// SetVariable mirrors an entry of the TS setVariables array.
type SetVariable struct {
	Key   string `json:"key"`
	Value string `json:"value"`
	Scope string `json:"scope"` // suite | global | runtime
}

// SandboxOutcome mirrors the TS SandboxOutcome.
type SandboxOutcome struct {
	Tests        []AssertionResult `json:"tests"`
	Logs         []string          `json:"logs"`
	SetVariables []SetVariable     `json:"setVariables"`
	Failed       bool              `json:"failed"`
	Error        string            `json:"error,omitempty"`
}

const timeoutMS = 2000

// prelude builds the response / variables / expect / test / fail / console
// globals in JS, using the __-prefixed host bridges installed from Go. This is
// a line-for-line translation of the object literals in sandbox.ts.
const prelude = `
;(function () {
  var __parsed = false, __json;
  var __resp = JSON.parse(__respJSON);
  globalThis.response = Object.freeze({
    status: __resp.status,
    statusText: __resp.statusText,
    headers: Object.freeze(__resp.headers || {}),
    time: __resp.time,
    json: function () { if (!__parsed) { __json = JSON.parse(__resp.bodyText); __parsed = true; } return __json; },
    text: function () { return __resp.bodyText; },
    header: function (name) { return (__resp.headers || {})[String(name).toLowerCase()]; },
  });
  globalThis.variables = Object.freeze({
    get: function (key) { return __getVar(String(key)); },
    set: function (key, value, scope) {
      if (__mode === 'validate') throw new Error('variables.set() is only available in capture scripts — use the Capture tab');
      var k = String(key);
      if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(k)) throw new Error('Invalid variable name: ' + k);
      var s = scope === 'global' ? 'global' : scope === 'runtime' ? 'runtime' : 'suite';
      __setVar(k, (typeof value === 'string') ? value : JSON.stringify(value), s);
    },
  });
  function fmt(v) { return (typeof v === 'string') ? ('"' + v + '"') : JSON.stringify(v); }
  globalThis.expect = function (actual) {
    return {
      toBe: function (exp) { if (actual !== exp) throw new Error('expected ' + fmt(actual) + ' to be ' + fmt(exp)); },
      toEqual: function (exp) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error('expected ' + fmt(actual) + ' to equal ' + fmt(exp)); },
      toContain: function (exp) {
        if (typeof actual === 'string' || Array.isArray(actual)) {
          if (!actual.includes(exp)) throw new Error('expected ' + fmt(actual) + ' to contain ' + fmt(exp));
        } else throw new Error('toContain expects a string or array');
      },
      toMatch: function (re) {
        var rx = (typeof re === 'string') ? new RegExp(re) : re;
        if (!rx.test(String(actual))) throw new Error('expected ' + fmt(actual) + ' to match ' + rx);
      },
      toBeLessThan: function (exp) { if (!(Number(actual) < exp)) throw new Error('expected ' + fmt(actual) + ' to be less than ' + exp); },
      toBeGreaterThan: function (exp) { if (!(Number(actual) > exp)) throw new Error('expected ' + fmt(actual) + ' to be greater than ' + exp); },
      toBeDefined: function () { if (actual === undefined || actual === null) throw new Error('expected value to be defined, got ' + fmt(actual)); },
    };
  };
  globalThis.test = function (name, fn) {
    var testName = String(name);
    if (typeof fn !== 'function') { __pushTest(testName, false, 'test() requires a function as second argument'); return; }
    try { fn(); __pushTest(testName, true, ''); }
    catch (e) { __pushTest(testName, false, (e && e.message) ? e.message : String(e)); }
  };
  globalThis.fail = function (message) { throw new Error(message ? String(message) : 'fail() called'); };
  globalThis.console = Object.freeze({
    log: function () {
      var args = Array.prototype.slice.call(arguments);
      __log(args.map(function (a) { return (typeof a === 'string') ? a : JSON.stringify(a); }).join(' '));
    },
  });
})();
`

// RunScript executes user script code and returns the outcome. getVariable
// returns (value, found); found=false surfaces as JS `undefined` (matching the
// TS closure that returns undefined for missing keys). mode is "capture" or
// "validate".
func RunScript(code string, response SandboxResponse, getVariable func(key string) (string, bool), mode string) SandboxOutcome {
	outcome := SandboxOutcome{Tests: []AssertionResult{}, Logs: []string{}, SetVariables: []SetVariable{}}
	if strings.TrimSpace(code) == "" {
		return outcome
	}

	vm := goja.New()

	respJSON, _ := json.Marshal(response)
	_ = vm.Set("__respJSON", string(respJSON))
	_ = vm.Set("__mode", mode)

	_ = vm.Set("__getVar", func(call goja.FunctionCall) goja.Value {
		if v, ok := getVariable(call.Argument(0).String()); ok {
			return vm.ToValue(v)
		}
		return goja.Undefined()
	})
	_ = vm.Set("__setVar", func(call goja.FunctionCall) goja.Value {
		outcome.SetVariables = append(outcome.SetVariables, SetVariable{
			Key:   call.Argument(0).String(),
			Value: call.Argument(1).String(),
			Scope: call.Argument(2).String(),
		})
		return goja.Undefined()
	})
	_ = vm.Set("__log", func(call goja.FunctionCall) goja.Value {
		outcome.Logs = append(outcome.Logs, call.Argument(0).String())
		return goja.Undefined()
	})
	_ = vm.Set("__pushTest", func(call goja.FunctionCall) goja.Value {
		name := call.Argument(0).String()
		passed := call.Argument(1).ToBoolean()
		ar := AssertionResult{Name: name, Passed: passed}
		if !passed {
			ar.Message = call.Argument(2).String()
			outcome.Failed = true
		}
		outcome.Tests = append(outcome.Tests, ar)
		return goja.Undefined()
	})

	// Hard timeout, mirroring node:vm's { timeout: 2000 }.
	timer := time.AfterFunc(timeoutMS*time.Millisecond, func() {
		vm.Interrupt("script execution timed out")
	})
	defer timer.Stop()

	if _, err := vm.RunString(prelude); err != nil {
		// A broken prelude is a bug, not user error — still surface it.
		outcome.Failed = true
		outcome.Error = jsErrMessage(err)
		return outcome
	}
	if _, err := vm.RunString(code); err != nil {
		outcome.Failed = true
		outcome.Error = jsErrMessage(err)
	}
	return outcome
}

// jsErrMessage extracts the .message of a thrown Error to match the TS
// top-level catch (`e?.message || String(e)`).
func jsErrMessage(err error) string {
	if ex, ok := err.(*goja.Exception); ok {
		if v := ex.Value(); v != nil {
			if obj, ok := v.(*goja.Object); ok {
				if m := obj.Get("message"); m != nil && !goja.IsUndefined(m) && !goja.IsNull(m) {
					return m.String()
				}
			}
			return v.String()
		}
	}
	return err.Error()
}

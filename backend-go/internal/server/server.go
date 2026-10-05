// Package server wires the chi router and ports the Express routes:
// collections, suites, variables, docs, files, metrics, runs and the /mock
// demo API. Route shapes and status codes match backend/src exactly.
package server

import (
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/finbox/hermes/backend-go/internal/auth"
	"github.com/finbox/hermes/backend-go/internal/bundle"
	"github.com/finbox/hermes/backend-go/internal/model"
	"github.com/finbox/hermes/backend-go/internal/postman"
	"github.com/finbox/hermes/backend-go/internal/store"
	"github.com/finbox/hermes/backend-go/internal/web"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

// New builds the top-level handler.
func New() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Recoverer)
	r.Use(corsMiddleware)

	r.Get("/api/health", func(w http.ResponseWriter, _ *http.Request) {
		web.JSON(w, http.StatusOK, map[string]bool{"ok": true})
	})

	r.Mount("/api/auth", auth.Router())
	r.Mount("/api/users", auth.UsersRouter())

	r.Group(func(r chi.Router) {
		r.Use(auth.RequireAuth, auth.EnforcePermissions)
		r.Mount("/api/collections", collectionsRouter())
		r.Mount("/api/suites", suitesRouter())
		r.Mount("/api/variables", variablesRouter())
		r.Mount("/api/environments", environmentsRouter())
		r.Mount("/api/runs", runsRouter())
		r.Mount("/api/docs", docsRouter())
		r.Mount("/api/files", filesRouter())
		r.Mount("/api/metrics", metricsRouter())
		r.Mount("/api/hera", heraRouter())
	})

	r.Mount("/mock", mockRouter())

	serveStatic(r)
	return r
}

// corsMiddleware reflects the request Origin and allows credentials, so the
// frontend can also hit this backend directly (cross-origin) if not proxied.
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ---------------- collections ----------------

func collectionsRouter() chi.Router {
	r := chi.NewRouter()
	r.Get("/", listCollections)
	r.Post("/import", importCollectionHandler)
	r.Get("/{id}", getCollection)
	r.Delete("/{id}", deleteCollection)
	return r
}

func listCollections(w http.ResponseWriter, _ *http.Request) {
	rows, err := store.DB.Query("SELECT id, name, created_at FROM collections ORDER BY created_at DESC")
	if err != nil {
		web.Err(w, 500, err.Error())
		return
	}
	defer rows.Close()
	out := []map[string]interface{}{}
	for rows.Next() {
		var id, name, createdAt string
		rows.Scan(&id, &name, &createdAt)
		out = append(out, map[string]interface{}{"id": id, "name": name, "createdAt": createdAt})
	}
	web.JSON(w, 200, out)
}

func getCollection(w http.ResponseWriter, r *http.Request) {
	var id, name, treeJSON, createdAt string
	err := store.DB.QueryRow("SELECT id, name, tree_json, created_at FROM collections WHERE id = ?", chi.URLParam(r, "id")).
		Scan(&id, &name, &treeJSON, &createdAt)
	if err == sql.ErrNoRows {
		web.Err(w, 404, "Collection not found")
		return
	}
	if err != nil {
		web.Err(w, 500, err.Error())
		return
	}
	var tree interface{}
	json.Unmarshal([]byte(treeJSON), &tree)
	web.JSON(w, 200, map[string]interface{}{"id": id, "name": name, "tree": tree, "createdAt": createdAt})
}

func importCollectionHandler(w http.ResponseWriter, r *http.Request) {
	var body struct {
		JSON        json.RawMessage `json:"json"`
		CreateSuite *bool           `json:"createSuite"`
	}
	if err := web.Decode(r, &body); err != nil {
		web.Err(w, 400, "Invalid request body")
		return
	}
	// json may be a string (stringified collection) or an object
	var parsedInput interface{}
	raw := body.JSON
	var asString string
	if json.Unmarshal(raw, &asString) == nil {
		json.Unmarshal([]byte(asString), &parsedInput)
		raw = []byte(asString)
	} else {
		json.Unmarshal(raw, &parsedInput)
	}

	imp, err := postman.ImportCollection(parsedInput)
	if err != nil {
		web.Err(w, 400, "Import failed: "+err.Error())
		return
	}
	id := model.NewID()
	now := nowISO()
	treeJSON, _ := json.Marshal(imp.Tree)
	rawStore, _ := json.Marshal(parsedInput)
	if _, err := store.DB.Exec("INSERT INTO collections (id, name, raw_json, tree_json, created_at) VALUES (?, ?, ?, ?, ?)",
		id, imp.Name, string(rawStore), string(treeJSON), now); err != nil {
		web.Err(w, 500, err.Error())
		return
	}

	var suiteID interface{}
	if body.CreateSuite == nil || *body.CreateSuite {
		sid := model.NewID()
		suiteID = sid
		vars := make([]model.SuiteVariable, 0, len(imp.Variables))
		for _, v := range imp.Variables {
			vars = append(vars, model.SuiteVariable{Key: v.Key, Value: v.Value, Secret: false})
		}
		stepsJSON, _ := json.Marshal(imp.Steps)
		varsJSON, _ := json.Marshal(vars)
		settingsJSON, _ := json.Marshal(model.DefaultSettings())
		store.DB.Exec(
			"INSERT INTO suites (id, name, description, collection_id, steps_json, variables_json, settings_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			sid, imp.Name, "Suite generated from imported collection \""+imp.Name+"\"", id,
			string(stepsJSON), string(varsJSON), string(settingsJSON), now, now,
		)
	}
	web.JSON(w, 201, map[string]interface{}{"id": id, "name": imp.Name, "suiteId": suiteID, "stepCount": len(imp.Steps)})
}

func deleteCollection(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	store.DB.Exec("DELETE FROM collections WHERE id = ?", id)
	store.DB.Exec("UPDATE suites SET collection_id = NULL WHERE collection_id = ?", id)
	web.JSON(w, 200, map[string]bool{"ok": true})
}

// ---------------- suites ----------------

func suitesRouter() chi.Router {
	r := chi.NewRouter()
	r.Get("/", listSuites)
	r.Post("/", createSuite)
	r.Get("/{id}", getSuiteHandler)
	r.Put("/{id}", updateSuite)
	// declared before the /{id} routes so "import-bundle" is never read as an id
	r.Post("/import-bundle", importSuiteBundle)
	r.Get("/{id}/bundle", exportSuiteBundle)
	r.Get("/{id}/export", exportSuite)
	r.Post("/{id}/duplicate", duplicateSuite)
	r.Delete("/{id}", deleteSuite)
	return r
}

func rowToSuite(scan func(dest ...interface{}) error) (*model.Suite, error) {
	var (
		id, name, description, stepsJSON, varsJSON, settingsJSON, createdAt, updatedAt string
		collectionID, defaultEnvID                                                     sql.NullString
	)
	if err := scan(&id, &name, &description, &collectionID, &stepsJSON, &varsJSON, &settingsJSON, &createdAt, &updatedAt, &defaultEnvID); err != nil {
		return nil, err
	}
	s := &model.Suite{ID: id, Name: name, Description: description, CreatedAt: createdAt, UpdatedAt: updatedAt}
	if collectionID.Valid {
		v := collectionID.String
		s.CollectionID = &v
	}
	if defaultEnvID.Valid && defaultEnvID.String != "" {
		v := defaultEnvID.String
		s.DefaultEnvID = &v
	}
	json.Unmarshal([]byte(stepsJSON), &s.Steps)
	json.Unmarshal([]byte(varsJSON), &s.Variables)
	settings := model.DefaultSettings() // spread-merge: defaults then override
	json.Unmarshal([]byte(settingsJSON), &settings)
	s.Settings = settings
	if s.Steps == nil {
		s.Steps = []model.Step{}
	}
	if s.Variables == nil {
		s.Variables = []model.SuiteVariable{}
	}
	return s, nil
}

const suiteCols = "id, name, description, collection_id, steps_json, variables_json, settings_json, created_at, updated_at, default_env_id"

func getSuite(id string) (*model.Suite, error) {
	row := store.DB.QueryRow("SELECT "+suiteCols+" FROM suites WHERE id = ?", id)
	s, err := rowToSuite(row.Scan)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return s, err
}

func listSuites(w http.ResponseWriter, _ *http.Request) {
	rows, err := store.DB.Query("SELECT " + suiteCols + " FROM suites ORDER BY updated_at DESC")
	if err != nil {
		web.Err(w, 500, err.Error())
		return
	}
	defer rows.Close()
	out := []map[string]interface{}{}
	for rows.Next() {
		s, err := rowToSuite(rows.Scan)
		if err != nil {
			web.Err(w, 500, err.Error())
			return
		}
		out = append(out, map[string]interface{}{
			"id": s.ID, "name": s.Name, "description": s.Description, "collectionId": s.CollectionID,
			"stepCount": len(s.Steps), "createdAt": s.CreatedAt, "updatedAt": s.UpdatedAt,
		})
	}
	web.JSON(w, 200, out)
}

func getSuiteHandler(w http.ResponseWriter, r *http.Request) {
	s, err := getSuite(chi.URLParam(r, "id"))
	if err != nil {
		web.Err(w, 500, err.Error())
		return
	}
	if s == nil {
		web.Err(w, 404, "Suite not found")
		return
	}
	web.JSON(w, 200, s)
}

func createSuite(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	_ = web.Decode(r, &body)
	if strings.TrimSpace(body.Name) == "" {
		web.Err(w, 400, "Suite name is required")
		return
	}
	id := model.NewID()
	now := nowISO()
	stepsJSON, _ := json.Marshal([]model.Step{model.EmptyStep("")})
	settingsJSON, _ := json.Marshal(model.DefaultSettings())
	if _, err := store.DB.Exec(
		"INSERT INTO suites (id, name, description, collection_id, steps_json, variables_json, settings_json, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)",
		id, strings.TrimSpace(body.Name), body.Description, string(stepsJSON), "[]", string(settingsJSON), now, now,
	); err != nil {
		web.Err(w, 500, err.Error())
		return
	}
	s, _ := getSuite(id)
	web.JSON(w, 201, s)
}

func updateSuite(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	existing, err := getSuite(id)
	if err != nil {
		web.Err(w, 500, err.Error())
		return
	}
	if existing == nil {
		web.Err(w, 404, "Suite not found")
		return
	}
	var body struct {
		Name        *string                `json:"name"`
		Description *string                `json:"description"`
		Steps       *[]model.Step          `json:"steps"`
		Variables   *[]model.SuiteVariable `json:"variables"`
		Settings    map[string]interface{} `json:"settings"`
		// Raw so absent (leave alone) stays distinct from null (clear it) —
		// encoding/json decodes both to a nil pointer.
		DefaultEnvID json.RawMessage `json:"defaultEnvId"`
	}
	if err := web.Decode(r, &body); err != nil {
		web.Err(w, 400, "Invalid request body")
		return
	}
	if body.Name != nil && strings.TrimSpace(*body.Name) == "" {
		web.Err(w, 400, "Suite name cannot be empty")
		return
	}
	defaultEnvID := existing.DefaultEnvID
	if len(body.DefaultEnvID) > 0 {
		var next *string
		if err := json.Unmarshal(body.DefaultEnvID, &next); err != nil {
			web.Err(w, 400, "defaultEnvId must be an environment id or null")
			return
		}
		if next != nil && *next == "" {
			next = nil // treat "" like null, matching the Node route
		}
		if next != nil && store.GetEnvironment(*next) == nil {
			web.Err(w, 404, "Environment not found")
			return
		}
		defaultEnvID = next
	}

	name := existing.Name
	if body.Name != nil {
		name = strings.TrimSpace(*body.Name)
	}
	description := existing.Description
	if body.Description != nil {
		description = *body.Description
	}
	steps := existing.Steps
	if body.Steps != nil {
		steps = *body.Steps
	}
	vars := existing.Variables
	if body.Variables != nil {
		vars = *body.Variables
	}
	settings := existing.Settings
	if body.Settings != nil {
		// merge partial settings over existing
		merged, _ := json.Marshal(existing.Settings)
		cur := map[string]interface{}{}
		json.Unmarshal(merged, &cur)
		for k, v := range body.Settings {
			cur[k] = v
		}
		reb, _ := json.Marshal(cur)
		s2 := model.DefaultSettings()
		json.Unmarshal(reb, &s2)
		settings = s2
	}

	stepsJSON, _ := json.Marshal(steps)
	varsJSON, _ := json.Marshal(vars)
	settingsJSON, _ := json.Marshal(settings)
	var envArg interface{}
	if defaultEnvID != nil {
		envArg = *defaultEnvID
	}
	if _, err := store.DB.Exec(
		"UPDATE suites SET name = ?, description = ?, steps_json = ?, variables_json = ?, settings_json = ?, default_env_id = ?, updated_at = ? WHERE id = ?",
		name, description, string(stepsJSON), string(varsJSON), string(settingsJSON), envArg, nowISO(), id,
	); err != nil {
		web.Err(w, 500, err.Error())
		return
	}
	s, _ := getSuite(id)
	web.JSON(w, 200, s)
}

// exportSuiteBundle serves a native bundle — lossless, unlike exportSuite
// below (which cannot carry polling, settings, sandbox scripts or file bytes).
func exportSuiteBundle(w http.ResponseWriter, r *http.Request) {
	s, _ := getSuite(chi.URLParam(r, "id"))
	if s == nil {
		web.Err(w, 404, "Suite not found")
		return
	}
	includeFiles := r.URL.Query().Get("includeFiles") != "0"
	wantsSecrets := r.URL.Query().Get("includeSecrets") == "1"
	// plaintext secrets leave the instance in a downloadable file — admin only,
	// even though GET is otherwise readable by every role
	if wantsSecrets {
		u := auth.UserFrom(r)
		if u == nil || u.Role != "admin" {
			web.Err(w, 403, "Only an admin can export secret values")
			return
		}
	}

	b, warnings, err := bundle.Build(*s, bundle.BuildOptions{IncludeFiles: includeFiles, IncludeSecrets: wantsSecrets})
	if err != nil {
		web.Err(w, 500, err.Error())
		return
	}
	if r.URL.Query().Get("download") == "0" {
		web.JSON(w, 200, map[string]interface{}{"bundle": b, "warnings": warnings})
		return
	}
	w.Header().Set("Content-Disposition", `attachment; filename="`+sanitizeFilename(s.Name)+`.hermes-bundle.json"`)
	if len(warnings) > 0 {
		if raw, err := json.Marshal(warnings); err == nil {
			w.Header().Set("X-Hermes-Bundle-Warnings", string(raw))
		}
	}
	web.JSON(w, 200, b)
}

// importSuiteBundle accepts { bundle, name?, includeGlobals?, overwriteGlobals? }.
func importSuiteBundle(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Bundle           json.RawMessage `json:"bundle"`
		Name             string          `json:"name"`
		IncludeGlobals   *bool           `json:"includeGlobals"`
		OverwriteGlobals *bool           `json:"overwriteGlobals"`
	}
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		web.Err(w, 400, "Could not read request body")
		return
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		web.Err(w, 400, "Invalid JSON: "+err.Error())
		return
	}
	payload := body.Bundle
	if len(payload) == 0 {
		payload = raw // allow posting a bare bundle
	}

	b, err := bundle.Parse(payload)
	if err != nil {
		if bundle.IsBadBundle(err) {
			web.Err(w, 400, err.Error())
		} else {
			web.Err(w, 400, "Could not read bundle: "+err.Error())
		}
		return
	}

	opts := bundle.ImportOptions{Name: body.Name, IncludeGlobals: true}
	if body.IncludeGlobals != nil {
		opts.IncludeGlobals = *body.IncludeGlobals
	}
	if body.OverwriteGlobals != nil {
		opts.OverwriteGlobals = *body.OverwriteGlobals
	}

	result, err := bundle.Import(b, opts)
	if err != nil {
		web.Err(w, 500, "Import failed: "+err.Error())
		return
	}
	web.JSON(w, 201, result)
}

func exportSuite(w http.ResponseWriter, r *http.Request) {
	s, _ := getSuite(chi.URLParam(r, "id"))
	if s == nil {
		web.Err(w, 404, "Suite not found")
		return
	}
	collection := postman.ExportSuiteAsCollection(*s)
	filename := sanitizeFilename(s.Name) + ".postman_collection.json"
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	web.JSON(w, 200, collection)
}

func duplicateSuite(w http.ResponseWriter, r *http.Request) {
	s, _ := getSuite(chi.URLParam(r, "id"))
	if s == nil {
		web.Err(w, 404, "Suite not found")
		return
	}
	id := model.NewID()
	now := nowISO()
	stepsJSON, _ := json.Marshal(s.Steps)
	varsJSON, _ := json.Marshal(s.Variables)
	settingsJSON, _ := json.Marshal(s.Settings)
	var collID interface{}
	if s.CollectionID != nil {
		collID = *s.CollectionID
	}
	var envID interface{}
	if s.DefaultEnvID != nil {
		envID = *s.DefaultEnvID
	}
	store.DB.Exec(
		"INSERT INTO suites (id, name, description, collection_id, steps_json, variables_json, settings_json, default_env_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		id, s.Name+" (copy)", s.Description, collID, string(stepsJSON), string(varsJSON), string(settingsJSON), envID, now, now,
	)
	ns, _ := getSuite(id)
	web.JSON(w, 201, ns)
}

func deleteSuite(w http.ResponseWriter, r *http.Request) {
	store.DB.Exec("DELETE FROM suites WHERE id = ?", chi.URLParam(r, "id"))
	web.JSON(w, 200, map[string]bool{"ok": true})
}

// ---------------- variables ----------------

var varKeyRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.-]*$`)

func variablesRouter() chi.Router {
	r := chi.NewRouter()
	r.Get("/", func(w http.ResponseWriter, _ *http.Request) {
		g, _ := store.GetGlobals()
		web.JSON(w, 200, g)
	})
	r.Post("/", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Key    string `json:"key"`
			Value  string `json:"value"`
			Secret bool   `json:"secret"`
		}
		_ = web.Decode(r, &body)
		if body.Key == "" || !varKeyRe.MatchString(body.Key) {
			web.Err(w, 400, "Variable key must start with a letter/underscore and contain only letters, digits, _ . -")
			return
		}
		store.SetGlobal(body.Key, body.Value, body.Secret)
		web.JSON(w, 201, map[string]interface{}{"key": body.Key, "value": body.Value, "secret": body.Secret})
	})
	r.Put("/", func(w http.ResponseWriter, r *http.Request) {
		var list []model.GlobalVariable
		if err := web.Decode(r, &list); err != nil || list == nil {
			web.Err(w, 400, "Expected an array of variables")
			return
		}
		for _, v := range list {
			if v.Key == "" || !varKeyRe.MatchString(v.Key) {
				web.Err(w, 400, "Invalid variable key: "+v.Key)
				return
			}
		}
		store.DB.Exec("DELETE FROM global_variables")
		for _, v := range list {
			store.SetGlobal(v.Key, v.Value, v.Secret)
		}
		g, _ := store.GetGlobals()
		web.JSON(w, 200, g)
	})
	r.Delete("/{key}", func(w http.ResponseWriter, r *http.Request) {
		store.DB.Exec("DELETE FROM global_variables WHERE key = ?", chi.URLParam(r, "key"))
		web.JSON(w, 200, map[string]bool{"ok": true})
	})
	return r
}

// ---------------- environments ----------------
//
// Named, reusable variable sets. Port of backend/src/routes/environments.ts —
// same paths, same status codes, same messages.

/*
resolveEnvID decides which environment a run uses:

	field absent    -> the suite's default
	field null      -> no environment (an explicit override of that default)
	field "<id>"    -> that environment

The field is taken as raw JSON because encoding/json cannot tell absent from
null: unmarshalling either into *string OR **string yields nil, which would
silently turn "run this with no environment" back into the suite default.
*/
func resolveEnvID(raw json.RawMessage, suiteDefault *string) string {
	if len(raw) == 0 {
		if suiteDefault != nil {
			return *suiteDefault
		}
		return ""
	}
	var s *string
	if err := json.Unmarshal(raw, &s); err != nil || s == nil {
		return ""
	}
	return *s
}

// validateEnvVars checks a posted variable array. Returns the cleaned list.
func validateEnvVars(list []model.EnvironmentVariable) ([]model.EnvironmentVariable, string) {
	out := make([]model.EnvironmentVariable, 0, len(list))
	seen := map[string]bool{}
	for _, v := range list {
		if v.Key == "" || !varKeyRe.MatchString(v.Key) {
			key := v.Key
			if key == "" {
				key = "(empty)"
			}
			return nil, "Invalid variable name: \"" + key + "\" — start with a letter/underscore, then letters, digits, _ . -"
		}
		if seen[v.Key] {
			return nil, "Duplicate variable name: " + v.Key
		}
		seen[v.Key] = true
		out = append(out, v)
	}
	return out, ""
}

func environmentsRouter() chi.Router {
	r := chi.NewRouter()

	r.Get("/", func(w http.ResponseWriter, _ *http.Request) {
		web.JSON(w, 200, store.ListEnvironments())
	})

	r.Get("/{id}", func(w http.ResponseWriter, r *http.Request) {
		env := store.GetEnvironment(chi.URLParam(r, "id"))
		if env == nil {
			web.Err(w, 404, "Environment not found")
			return
		}
		web.JSON(w, 200, env)
	})

	r.Post("/", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name        string                       `json:"name"`
			Description string                       `json:"description"`
			Variables   []model.EnvironmentVariable  `json:"variables"`
		}
		_ = web.Decode(r, &body)
		name := strings.TrimSpace(body.Name)
		if name == "" {
			web.Err(w, 400, "Environment name is required")
			return
		}
		vars, msg := validateEnvVars(body.Variables)
		if msg != "" {
			web.Err(w, 400, msg)
			return
		}
		if store.EnvNameTaken(name, "") {
			web.Err(w, 409, "An environment named \""+name+"\" already exists")
			return
		}
		id := model.NewID()
		now := nowISO()
		if _, err := store.DB.Exec(
			"INSERT INTO environments (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
			id, name, body.Description, now, now,
		); err != nil {
			web.Err(w, 500, err.Error())
			return
		}
		if err := store.ReplaceEnvVars(id, vars); err != nil {
			web.Err(w, 500, err.Error())
			return
		}
		web.JSON(w, 201, store.GetEnvironment(id))
	})

	r.Put("/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		existing := store.GetEnvironment(id)
		if existing == nil {
			web.Err(w, 404, "Environment not found")
			return
		}
		var body struct {
			Name        *string                      `json:"name"`
			Description *string                      `json:"description"`
			Variables   *[]model.EnvironmentVariable `json:"variables"`
		}
		if err := web.Decode(r, &body); err != nil {
			web.Err(w, 400, "Invalid request body")
			return
		}
		name := existing.Name
		if body.Name != nil {
			name = strings.TrimSpace(*body.Name)
			if name == "" {
				web.Err(w, 400, "Environment name cannot be empty")
				return
			}
			if store.EnvNameTaken(name, id) {
				web.Err(w, 409, "An environment named \""+name+"\" already exists")
				return
			}
		}
		description := existing.Description
		if body.Description != nil {
			description = *body.Description
		}
		var vars []model.EnvironmentVariable
		if body.Variables != nil {
			cleaned, msg := validateEnvVars(*body.Variables)
			if msg != "" {
				web.Err(w, 400, msg)
				return
			}
			vars = cleaned
		}
		if _, err := store.DB.Exec(
			"UPDATE environments SET name = ?, description = ?, updated_at = ? WHERE id = ?",
			name, description, nowISO(), id,
		); err != nil {
			web.Err(w, 500, err.Error())
			return
		}
		if body.Variables != nil {
			if err := store.ReplaceEnvVars(id, vars); err != nil {
				web.Err(w, 500, err.Error())
				return
			}
		}
		web.JSON(w, 200, store.GetEnvironment(id))
	})

	r.Post("/{id}/duplicate", func(w http.ResponseWriter, r *http.Request) {
		src := store.GetEnvironment(chi.URLParam(r, "id"))
		if src == nil {
			web.Err(w, 404, "Environment not found")
			return
		}
		// First free "<name> (copy)", "<name> (copy 2)", ... — the name is UNIQUE.
		name := src.Name + " (copy)"
		for i := 2; store.EnvNameTaken(name, ""); i++ {
			name = src.Name + " (copy " + strconv.Itoa(i) + ")"
		}
		id := model.NewID()
		now := nowISO()
		if _, err := store.DB.Exec(
			"INSERT INTO environments (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
			id, name, src.Description, now, now,
		); err != nil {
			web.Err(w, 500, err.Error())
			return
		}
		if err := store.ReplaceEnvVars(id, src.Variables); err != nil {
			web.Err(w, 500, err.Error())
			return
		}
		web.JSON(w, 201, store.GetEnvironment(id))
	})

	// Deleting an environment clears it from any suite pointing at it, so those
	// suites fall back to globals + suite variables instead of a dangling id.
	// Existing run rows keep env_name, which is why it is stored alongside env_id.
	r.Delete("/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		store.DB.Exec("DELETE FROM environment_variables WHERE env_id = ?", id)
		store.DB.Exec("DELETE FROM environments WHERE id = ?", id)
		store.DB.Exec("UPDATE suites SET default_env_id = NULL WHERE default_env_id = ?", id)
		web.JSON(w, 200, map[string]bool{"ok": true})
	})

	return r
}

func nowISO() string { return time.Now().UTC().Format(time.RFC3339Nano) }

func sanitizeFilename(name string) string {
	var b strings.Builder
	for _, r := range name {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '.' || r == '-' || r == '_' {
			b.WriteRune(r)
		} else {
			b.WriteRune('-')
		}
	}
	out := b.String()
	// collapse runs of '-' like the JS replace(/[^\w.-]+/g,'-')
	for strings.Contains(out, "--") {
		out = strings.ReplaceAll(out, "--", "-")
	}
	if out == "" {
		return "suite"
	}
	return out
}

// serveStatic serves the built frontend when present (single-container deploy).
func serveStatic(r chi.Router) {
	dist := os.Getenv("FRONTEND_DIST")
	if dist == "" {
		dist = filepath.Join("..", "frontend", "dist")
	}
	if _, err := os.Stat(dist); err != nil {
		return
	}
	fs := http.FileServer(http.Dir(dist))
	r.Get("/*", func(w http.ResponseWriter, req *http.Request) {
		p := req.URL.Path
		if strings.HasPrefix(p, "/api/") || strings.HasPrefix(p, "/mock/") {
			http.NotFound(w, req)
			return
		}
		if _, err := os.Stat(filepath.Join(dist, filepath.Clean(p))); err == nil && p != "/" {
			fs.ServeHTTP(w, req)
			return
		}
		http.ServeFile(w, req, filepath.Join(dist, "index.html"))
	})
}

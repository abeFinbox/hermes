// Package bundle implements the native suite bundle — the lossless counterpart
// to internal/postman's exporter.
//
// A Postman collection has nowhere to put polling config, suite settings,
// sandbox scripts or visual assertions, so exporting a suite that way and
// re-importing it elsewhere silently degrades it. A bundle instead carries the
// Suite shape verbatim plus the attached file blobs, so an import on another
// instance (local -> docker, docker -> prod) reproduces the suite exactly.
//
// Wire format is identical to the Node backend's src/suite-bundle.ts: a bundle
// exported from either backend imports into either backend.
package bundle

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/finbox/hermes/backend-go/internal/model"
	"github.com/finbox/hermes/backend-go/internal/store"
)

const Version = 1

// base64 inflates ~33%; warn past this so nobody generates a JSON the browser
// cannot hold. Export still proceeds — it is a warning, not a limit.
const FileBytesWarn = 20 * 1024 * 1024

type File struct {
	ID            string `json:"id"` // id in the SOURCE instance — remapped on import
	OriginalName  string `json:"originalName"`
	Mime          string `json:"mime"`
	Size          int64  `json:"size"`
	SHA256        string `json:"sha256"`
	ContentBase64 string `json:"contentBase64"`
}

type SuitePayload struct {
	Name        string                `json:"name"`
	Description string                `json:"description"`
	Steps       []model.Step          `json:"steps"`
	Variables   []model.SuiteVariable `json:"variables"`
	Settings    model.SuiteSettings   `json:"settings"`
}

type Bundle struct {
	HermesBundle int                    `json:"hermesBundle"`
	ExportedAt   string                 `json:"exportedAt"`
	Suite        SuitePayload           `json:"suite"`
	Globals      []model.GlobalVariable `json:"globals"`
	Files        []File                 `json:"files"`
	// keys whose values were masked — the importer surfaces these to be filled in
	SecretsNeeded []string `json:"secretsNeeded"`
}

var varRef = regexp.MustCompile(`\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}`)

// referencedVarKeys returns every {{token}} used anywhere in the suite
// (urls, headers, bodies, scripts).
func referencedVarKeys(s model.Suite) map[string]bool {
	keys := map[string]bool{}
	blob, _ := json.Marshal(map[string]interface{}{"steps": s.Steps, "variables": s.Variables})
	for _, m := range varRef.FindAllStringSubmatch(string(blob), -1) {
		keys[m[1]] = true
	}
	return keys
}

type fileRef struct {
	fileID   string
	stepName string
	key      string
}

func referencedFileIDs(steps []model.Step) []fileRef {
	var out []fileRef
	for _, step := range steps {
		for _, f := range step.Request.Body.FormData {
			if f.Type == "file" && f.FileID != "" {
				out = append(out, fileRef{f.FileID, step.Name, f.Key})
			}
		}
	}
	return out
}

type BuildOptions struct {
	IncludeFiles   bool
	IncludeSecrets bool
}

// Build assembles a bundle for one suite. Warnings are advisory: a bundle is
// always produced.
func Build(s model.Suite, opts BuildOptions) (*Bundle, []string, error) {
	warnings := []string{}
	secretsNeeded := []string{}

	vars := make([]model.SuiteVariable, 0, len(s.Variables))
	for _, v := range s.Variables {
		if v.Secret && !opts.IncludeSecrets {
			secretsNeeded = append(secretsNeeded, v.Key)
			v.Value = ""
		}
		vars = append(vars, v)
	}

	// only the globals this suite actually uses — no dragging the whole
	// Variables page along with one suite
	referenced := referencedVarKeys(s)
	suiteKeys := map[string]bool{}
	for _, v := range s.Variables {
		suiteKeys[v.Key] = true
	}
	allGlobals, err := store.GetGlobals()
	if err != nil {
		return nil, nil, err
	}
	globals := []model.GlobalVariable{}
	hasReferencedSecret := false
	for _, g := range allGlobals {
		if !referenced[g.Key] || suiteKeys[g.Key] {
			continue
		}
		if g.Secret {
			hasReferencedSecret = true
			if !opts.IncludeSecrets {
				secretsNeeded = append(secretsNeeded, g.Key)
				g.Value = ""
			}
		}
		globals = append(globals, g)
	}

	files := []File{}
	seen := map[string]bool{}
	var totalBytes int64

	refs := referencedFileIDs(s.Steps)
	if opts.IncludeFiles {
		for _, ref := range refs {
			if seen[ref.fileID] {
				continue
			}
			seen[ref.fileID] = true
			row, err := store.GetFileRow(ref.fileID)
			if err != nil || row == nil {
				warnings = append(warnings, fmt.Sprintf(
					"Step %q: form-data part %q points at a file that no longer exists — the part will import with no file attached.", ref.stepName, ref.key))
				continue
			}
			bytes, err := os.ReadFile(filepath.Join(store.FilesDir, row.StoredName))
			if err != nil {
				warnings = append(warnings, fmt.Sprintf(
					"Step %q: file %q is missing from the file store — the part will import with no file attached.", ref.stepName, row.OriginalName))
				continue
			}
			sum := sha256.Sum256(bytes)
			totalBytes += int64(len(bytes))
			files = append(files, File{
				ID:            row.ID,
				OriginalName:  row.OriginalName,
				Mime:          row.Mime,
				Size:          int64(len(bytes)),
				SHA256:        hex.EncodeToString(sum[:]),
				ContentBase64: base64.StdEncoding.EncodeToString(bytes),
			})
		}
		if totalBytes > FileBytesWarn {
			warnings = append(warnings, fmt.Sprintf(
				"Embedded files total %.1f MB (base64 makes the bundle roughly %.1f MB). Large bundles are slow to upload and may hit request size limits.",
				float64(totalBytes)/1024/1024, float64(totalBytes)*1.34/1024/1024))
		}
	} else if len(refs) > 0 {
		skipped := map[string]bool{}
		for _, r := range refs {
			skipped[r.fileID] = true
		}
		warnings = append(warnings, fmt.Sprintf(
			"%d attached file(s) were not embedded — re-attach them on the target instance after importing.", len(skipped)))
	}

	if opts.IncludeSecrets {
		suiteHasSecret := false
		for _, v := range s.Variables {
			if v.Secret {
				suiteHasSecret = true
				break
			}
		}
		if suiteHasSecret || hasReferencedSecret {
			warnings = append(warnings, "This bundle contains secret values in plaintext. Treat the file as a credential.")
		}
	}

	return &Bundle{
		HermesBundle: Version,
		ExportedAt:   time.Now().UTC().Format(time.RFC3339),
		Suite: SuitePayload{
			Name:        s.Name,
			Description: s.Description,
			Steps:       s.Steps,
			Variables:   vars,
			Settings:    s.Settings,
		},
		Globals:       globals,
		Files:         files,
		SecretsNeeded: dedupe(secretsNeeded),
	}, warnings, nil
}

// ---- import ----

// ErrBundle marks a payload the caller should reject with 400 rather than 500.
type ErrBundle struct{ msg string }

func (e *ErrBundle) Error() string { return e.msg }

func badBundle(format string, a ...interface{}) error {
	return &ErrBundle{msg: fmt.Sprintf(format, a...)}
}

// IsBadBundle reports whether err came from validation (client error).
func IsBadBundle(err error) bool {
	var e *ErrBundle
	return errors.As(err, &e)
}

// Parse shape-checks an untrusted payload before anything touches the database.
func Parse(raw json.RawMessage) (*Bundle, error) {
	// probe hermesBundle first so a Postman collection gets a useful message
	var probe struct {
		HermesBundle *int             `json:"hermesBundle"`
		Suite        *json.RawMessage `json:"suite"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return nil, badBundle("Invalid JSON: %s", err.Error())
	}
	if probe.HermesBundle == nil {
		return nil, badBundle("Missing \"hermesBundle\" — this looks like a Postman collection, not a Hermes bundle. Use Import collection for those.")
	}
	if *probe.HermesBundle > Version {
		return nil, badBundle("Bundle format v%d is newer than this instance supports (v%d). Upgrade Hermes on this instance.", *probe.HermesBundle, Version)
	}
	if probe.Suite == nil {
		return nil, badBundle("Missing \"suite\"")
	}

	var b Bundle
	if err := json.Unmarshal(raw, &b); err != nil {
		return nil, badBundle("Bundle did not match the expected shape: %s", err.Error())
	}
	if strings.TrimSpace(b.Suite.Name) == "" {
		return nil, badBundle("Suite name is empty")
	}
	return &b, nil
}

type ImportOptions struct {
	Name             string // override the suite name (defaults to the bundle's, deduped)
	IncludeGlobals   bool
	OverwriteGlobals bool
}

type ImportResult struct {
	SuiteID         string            `json:"suiteId"`
	Name            string            `json:"name"`
	StepCount       int               `json:"stepCount"`
	FileMap         map[string]string `json:"fileMap"` // source file id -> id in this instance
	ImportedGlobals []string          `json:"importedGlobals"`
	SkippedGlobals  []string          `json:"skippedGlobals"`
	SecretsNeeded   []string          `json:"secretsNeeded"`
	Warnings        []string          `json:"warnings"`
}

func Import(b *Bundle, opts ImportOptions) (*ImportResult, error) {
	warnings := []string{}

	// 1. Land the blobs first and build the id mapping.
	fileMap := map[string]string{}
	for _, f := range b.Files {
		if f.ID == "" {
			warnings = append(warnings, "A file entry in the bundle was malformed and was skipped.")
			continue
		}
		bytes, err := base64.StdEncoding.DecodeString(f.ContentBase64)
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("File %q could not be decoded and was skipped.", f.OriginalName))
			continue
		}
		if f.SHA256 != "" {
			sum := sha256.Sum256(bytes)
			if hex.EncodeToString(sum[:]) != f.SHA256 {
				warnings = append(warnings, fmt.Sprintf("File %q failed its checksum and was skipped — the bundle may be corrupt.", f.OriginalName))
				continue
			}
		}
		id := model.NewID()
		name := f.OriginalName
		if name == "" {
			name = "unnamed"
		}
		storedName := id + extOf(name)
		if err := os.WriteFile(filepath.Join(store.FilesDir, storedName), bytes, 0o644); err != nil {
			return nil, err
		}
		if _, err := store.DB.Exec(
			"INSERT INTO files (id, original_name, stored_name, size, mime, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			id, name, storedName, len(bytes), f.Mime, time.Now().UTC().Format(time.RFC3339),
		); err != nil {
			return nil, err
		}
		fileMap[f.ID] = id
	}

	// 2. Rewrite every form-data fileId to point at this instance's store.
	steps := b.Suite.Steps
	for si := range steps {
		parts := steps[si].Request.Body.FormData
		for pi := range parts {
			p := &parts[pi]
			if p.Type != "file" || p.FileID == "" {
				continue
			}
			if mapped, ok := fileMap[p.FileID]; ok {
				p.FileID = mapped
			} else {
				p.FileID = ""
				warnings = append(warnings, fmt.Sprintf(
					"Step %q: form-data part %q had no file in the bundle — attach one before running.", steps[si].Name, p.Key))
			}
		}
	}

	// 3. Globals — never clobber this instance's values unless asked.
	importedGlobals := []string{}
	skippedGlobals := []string{}
	if opts.IncludeGlobals {
		existing := map[string]bool{}
		cur, err := store.GetGlobals()
		if err != nil {
			return nil, err
		}
		for _, g := range cur {
			existing[g.Key] = true
		}
		for _, g := range b.Globals {
			if g.Key == "" {
				continue
			}
			if existing[g.Key] && !opts.OverwriteGlobals {
				skippedGlobals = append(skippedGlobals, g.Key)
				continue
			}
			if err := store.SetGlobal(g.Key, g.Value, g.Secret); err != nil {
				return nil, err
			}
			importedGlobals = append(importedGlobals, g.Key)
		}
	}

	// 4. The suite itself — new id, name deduped so repeat imports don't collide.
	suiteID := model.NewID()
	base := opts.Name
	if strings.TrimSpace(base) == "" {
		base = b.Suite.Name
	}
	name, err := uniqueName(strings.TrimSpace(base))
	if err != nil {
		return nil, err
	}

	settings := model.DefaultSettings()
	if raw, err := json.Marshal(b.Suite.Settings); err == nil {
		json.Unmarshal(raw, &settings)
	}

	if steps == nil {
		steps = []model.Step{}
	}
	vars := b.Suite.Variables
	if vars == nil {
		vars = []model.SuiteVariable{}
	}
	stepsJSON, _ := json.Marshal(steps)
	varsJSON, _ := json.Marshal(vars)
	settingsJSON, _ := json.Marshal(settings)
	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := store.DB.Exec(
		"INSERT INTO suites (id, name, description, collection_id, steps_json, variables_json, settings_json, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)",
		suiteID, name, b.Suite.Description, string(stepsJSON), string(varsJSON), string(settingsJSON), now, now,
	); err != nil {
		return nil, err
	}

	secretsNeeded := append([]string{}, b.SecretsNeeded...)
	for _, v := range vars {
		if v.Secret && v.Value == "" {
			secretsNeeded = append(secretsNeeded, v.Key)
		}
	}
	secretsNeeded = dedupe(secretsNeeded)
	if len(secretsNeeded) > 0 {
		warnings = append(warnings, fmt.Sprintf(
			"Secret values were not included in the bundle: %s. Fill them in before running.", strings.Join(secretsNeeded, ", ")))
	}

	return &ImportResult{
		SuiteID:         suiteID,
		Name:            name,
		StepCount:       len(steps),
		FileMap:         fileMap,
		ImportedGlobals: importedGlobals,
		SkippedGlobals:  skippedGlobals,
		SecretsNeeded:   secretsNeeded,
		Warnings:        warnings,
	}, nil
}

// uniqueName turns "Checkout flow" into "Checkout flow (imported)", then
// "... (imported 2)", so repeat imports never collide.
func uniqueName(base string) (string, error) {
	rows, err := store.DB.Query("SELECT name FROM suites")
	if err != nil {
		return "", err
	}
	defer rows.Close()
	taken := map[string]bool{}
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err == nil {
			taken[n] = true
		}
	}
	if !taken[base] {
		return base, nil
	}
	if c := base + " (imported)"; !taken[c] {
		return c, nil
	}
	for n := 2; n < 1000; n++ {
		c := fmt.Sprintf("%s (imported %d)", base, n)
		if !taken[c] {
			return c, nil
		}
	}
	return fmt.Sprintf("%s (%s)", base, model.NewID()[:8]), nil
}

func extOf(name string) string {
	dot := strings.LastIndex(name, ".")
	if dot <= 0 || dot >= len(name)-1 {
		return ""
	}
	ext := strings.ToLower(name[dot:])
	var b strings.Builder
	for _, r := range ext {
		if r == '.' || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func dedupe(in []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

const codingAgentVersionTimeout = 5 * time.Second

type codingAgentSpec struct {
	ID          string
	DisplayName string
	Binaries    []string
	ConfigDirs  []string
}

type codingAgentCandidate struct {
	CLI      string `json:"cli"`
	Label    string `json:"label"`
	Install  string `json:"install"`
	AuthNote string `json:"authNote"`
}

type codingAgentFound struct {
	ID         string   `json:"id"`
	Label      string   `json:"label"`
	Version    *string  `json:"version"`
	ViaBinary  bool     `json:"viaBinary"`
	ConfigDirs []string `json:"configDirs"`
}

type codingAgentDetection struct {
	Installed  bool                   `json:"installed"`
	CLI        *string                `json:"cli"`
	Label      *string                `json:"label"`
	Version    *string                `json:"version"`
	Agents     []codingAgentFound     `json:"agents"`
	Candidates []codingAgentCandidate `json:"candidates"`
}

var codingAgentKnown = []codingAgentSpec{
	{ID: "opencode", DisplayName: "OpenCode", Binaries: []string{"opencode"}, ConfigDirs: []string{".config/opencode"}},
	{ID: "claude-code", DisplayName: "Claude Code", Binaries: []string{"claude"}, ConfigDirs: []string{".claude"}},
	{ID: "codex", DisplayName: "Codex CLI", Binaries: []string{"codex"}, ConfigDirs: []string{".codex"}},
	{ID: "kilocode", DisplayName: "Kilo Code", Binaries: []string{"kilo", "kilocode"}, ConfigDirs: []string{".kilocode", ".config/kilo"}},
	{ID: "aider", DisplayName: "Aider", Binaries: []string{"aider"}, ConfigDirs: []string{".aider", ".aider.conf.yml", ".aider.tags.yml", ".aider.chat.history"}},
	{ID: "gemini-cli", DisplayName: "Gemini CLI", Binaries: []string{"gemini"}, ConfigDirs: []string{".gemini"}},
}

var codingAgentCandidates = []codingAgentCandidate{
	{CLI: "claude", Label: "Claude Code", Install: "npm install -g @anthropic-ai/claude-code", AuthNote: "Run `claude` once in a terminal and sign in with your Anthropic account."},
	{CLI: "codex", Label: "OpenAI Codex CLI", Install: "npm install -g @openai/codex", AuthNote: "Run `codex` once in a terminal and sign in with your ChatGPT account."},
	{CLI: "gemini", Label: "Gemini CLI", Install: "npm install -g @google/gemini-cli", AuthNote: "Run `gemini` once in a terminal and sign in with your Google account."},
	{CLI: "opencode", Label: "OpenCode", Install: "curl -fsSL https://opencode.ai/install | bash", AuthNote: "Run `opencode` once in a terminal and sign in with your provider account."},
	{CLI: "kilo", Label: "Kilo Code", Install: "npm install -g @kilocode/cli", AuthNote: "Run `kilo` once in a terminal and sign in with your Kilo account."},
	{CLI: "aider", Label: "Aider", Install: "python -m pip install aider-install && aider-install", AuthNote: "Export an ANTHROPIC_API_KEY or OPENAI_API_KEY, then run `aider`."},
}

var codingAgentLabels = map[string]string{
	"opencode":    "OpenCode",
	"claude-code": "Claude Code",
	"codex":       "OpenAI Codex CLI",
	"kilocode":    "Kilo Code",
	"aider":       "Aider",
	"gemini-cli":  "Gemini CLI",
}

var codingAgentCLIs = map[string]string{
	"opencode":    "opencode",
	"claude-code": "claude",
	"codex":       "codex",
	"kilocode":    "kilo",
	"aider":       "aider",
	"gemini-cli":  "gemini",
}

type codingAgentRunner interface {
	Detect(context.Context) (codingAgentDetection, error)
}

// localCodingAgentDetector is the read-only PATH and config-directory probe.
// It never installs anything: the wizard only hands the human a command.
type localCodingAgentDetector struct {
	home       string
	pathEnv    string
	statPath   func(string) (os.FileInfo, error)
	runVersion func(context.Context, string) *string
}

func newLocalCodingAgentDetector() *localCodingAgentDetector {
	home, _ := os.UserHomeDir()
	return &localCodingAgentDetector{
		home:       home,
		pathEnv:    os.Getenv("PATH"),
		statPath:   os.Stat,
		runVersion: probeCodingAgentVersion,
	}
}

func (d *localCodingAgentDetector) which(bin string) string {
	for _, dir := range filepath.SplitList(d.pathEnv) {
		if dir == "" {
			continue
		}
		candidate := filepath.Join(dir, bin)
		if runtime.GOOS == "windows" {
			candidate += ".exe"
		}
		info, err := d.statPath(candidate)
		if err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
			return candidate
		}
	}
	return ""
}

func (d *localCodingAgentDetector) displayPath(path string) string {
	if d.home != "" && strings.HasPrefix(path, d.home) {
		return "~" + path[len(d.home):]
	}
	return path
}

func (d *localCodingAgentDetector) Detect(ctx context.Context) (codingAgentDetection, error) {
	type entry struct {
		found   codingAgentFound
		spec    codingAgentSpec
		binPath string
	}
	entries := make([]entry, 0, len(codingAgentKnown))
	for _, spec := range codingAgentKnown {
		binPath := ""
		for _, bin := range spec.Binaries {
			if hit := d.which(bin); hit != "" {
				binPath = hit
				break
			}
		}
		configDirs := []string{}
		for _, dir := range spec.ConfigDirs {
			full := filepath.Join(d.home, dir)
			if info, err := d.statPath(full); err == nil && info.Mode()&0o444 != 0 {
				configDirs = append(configDirs, d.displayPath(full))
			}
		}
		if binPath == "" && len(configDirs) == 0 {
			continue
		}
		var version *string
		if binPath != "" {
			version = d.runVersion(ctx, binPath)
		}
		label := spec.DisplayName
		if known, ok := codingAgentLabels[spec.ID]; ok {
			label = known
		}
		entries = append(entries, entry{
			found: codingAgentFound{
				ID: spec.ID, Label: label, Version: version,
				ViaBinary: binPath != "", ConfigDirs: configDirs,
			},
			spec:    spec,
			binPath: binPath,
		})
	}
	// A binary on PATH is the usable candidate; config-only hits mean the tool
	// was installed before but is not callable right now.
	sort.SliceStable(entries, func(i, j int) bool {
		return entries[i].found.ViaBinary && !entries[j].found.ViaBinary
	})
	detection := codingAgentDetection{Agents: []codingAgentFound{}, Candidates: codingAgentCandidates}
	for _, item := range entries {
		detection.Agents = append(detection.Agents, item.found)
	}
	if len(entries) > 0 && entries[0].found.ViaBinary {
		best := entries[0]
		detection.Installed = true
		cli := best.spec.Binaries[0]
		if known, ok := codingAgentCLIs[best.spec.ID]; ok {
			cli = known
		}
		detection.CLI = &cli
		label := best.found.Label
		detection.Label = &label
		detection.Version = best.found.Version
	}
	return detection, nil
}

func probeCodingAgentVersion(ctx context.Context, binPath string) *string {
	probeCtx, cancel := context.WithTimeout(ctx, codingAgentVersionTimeout)
	defer cancel()
	output, err := exec.CommandContext(probeCtx, binPath, "--version").Output()
	if err != nil {
		return nil
	}
	trimmed := strings.TrimSpace(string(output))
	if trimmed == "" {
		return nil
	}
	line := strings.SplitN(trimmed, "\n", 2)[0]
	if line == "" {
		return nil
	}
	return &line
}

type platformCreatorAgentHandler struct {
	platformCollectionHandler
	detector codingAgentRunner
}

// NewCreatorAgentHandler builds the read-only coding agent detection endpoint.
// Mount it at GET /api/creator/agent behind the Go API router.
func NewCreatorAgentHandler(resolver SessionResolver, trustedProxyCIDRs []*net.IPNet, logger *slog.Logger) (http.Handler, error) {
	if resolver == nil {
		return nil, errors.New("creator agent handler requires a session resolver")
	}
	for _, cidr := range trustedProxyCIDRs {
		if cidr == nil || cidr.IP == nil || cidr.Mask == nil {
			return nil, errors.New("invalid trusted proxy CIDR")
		}
	}
	return newCreatorAgentHandler(resolver, newLocalCodingAgentDetector(), trustedProxyCIDRs, logger), nil
}

func newCreatorAgentHandler(resolver SessionResolver, detector codingAgentRunner, trustedProxyCIDRs []*net.IPNet, logger *slog.Logger) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	return &platformCreatorAgentHandler{
		platformCollectionHandler: platformCollectionHandler{
			session: resolver, logger: logger, trustedProxy: trustedProxyCIDRs,
			unavailable: "creator agent detection unavailable", forbidden: "forbidden",
		},
		detector: detector,
	}
}

func (h *platformCreatorAgentHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if _, _, ok := h.authenticate(w, r); !ok {
		return
	}
	if h.detector == nil {
		h.refusal(w, http.StatusServiceUnavailable, h.unavailable)
		return
	}
	detection, err := h.detector.Detect(r.Context())
	if err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, detection)
}

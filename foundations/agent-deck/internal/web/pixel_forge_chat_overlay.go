package web

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"
)

type pixelForgeChatBinding struct {
	ChatID        string
	ChatTitle     string
	BindingState  string
	WorkspaceKind string
	OriginKind    string
}

type pixelForgeChatOverlayMenuData struct {
	base   MenuDataLoader
	dbPath string
}

// WrapWithPixelForgeChatIdentity overlays shared Pixel Forge chat identity on
// top of Agent Deck sessions when the shared control-plane database is
// available in the environment.
func WrapWithPixelForgeChatIdentity(base MenuDataLoader) MenuDataLoader {
	if base == nil {
		return nil
	}

	dbPath := detectPixelForgeDBPath()
	if dbPath == "" {
		return base
	}

	return &pixelForgeChatOverlayMenuData{
		base:   base,
		dbPath: dbPath,
	}
}

func (m *pixelForgeChatOverlayMenuData) LoadMenuSnapshot() (*MenuSnapshot, error) {
	if m == nil || m.base == nil {
		return nil, fmt.Errorf("pixel forge chat overlay requires a base menu loader")
	}

	snapshot, err := m.base.LoadMenuSnapshot()
	if err != nil {
		return nil, err
	}

	bindings, err := loadPixelForgeChatBindingsFromPath(m.dbPath)
	if err != nil {
		return snapshot, nil
	}

	return applyPixelForgeChatBindings(snapshot, bindings), nil
}

func detectPixelForgeDBPath() string {
	candidates := []string{
		strings.TrimSpace(os.Getenv("PIXEL_FORGE_DB_PATH")),
	}

	if sharedState := strings.TrimSpace(os.Getenv("PIXEL_FORGE_SHARED_STATE_DIR")); sharedState != "" {
		candidates = append(candidates, filepath.Join(sharedState, "pixel-forge.db"))
	}

	if agentDeckHome := strings.TrimSpace(os.Getenv("PIXEL_FORGE_AGENT_DECK_HOME")); agentDeckHome != "" {
		candidates = append(candidates, filepath.Join(filepath.Dir(agentDeckHome), "pixel-forge.db"))
	}

	for _, candidate := range candidates {
		if candidate == "" {
			continue
		}
		return filepath.Clean(candidate)
	}

	return ""
}

func loadPixelForgeChatBindingsFromPath(dbPath string) (map[string]pixelForgeChatBinding, error) {
	bindings := make(map[string]pixelForgeChatBinding)
	normalizedPath := strings.TrimSpace(dbPath)
	if normalizedPath == "" {
		return bindings, nil
	}

	if _, err := os.Stat(normalizedPath); err != nil {
		if os.IsNotExist(err) {
			return bindings, nil
		}
		return nil, fmt.Errorf("stat pixel forge db: %w", err)
	}

	db, err := sql.Open("sqlite", normalizedPath)
	if err != nil {
		return nil, fmt.Errorf("open pixel forge db: %w", err)
	}
	defer func() { _ = db.Close() }()

	if _, err := db.Exec("PRAGMA busy_timeout=5000"); err != nil {
		return nil, fmt.Errorf("configure pixel forge db busy timeout: %w", err)
	}

	rows, err := db.Query(`
		SELECT
			COALESCE(
				NULLIF(TRIM(chat_session_bindings.agent_deck_session_id), ''),
				NULLIF(TRIM(sessions.agent_deck_session_id), '')
			) AS agent_deck_session_id,
			sessions.thread_id,
			COALESCE(
				NULLIF(TRIM(chat_session_bindings.agent_deck_session_title), ''),
				NULLIF(TRIM(sessions.agent_deck_session_title), ''),
				''
			) AS chat_title,
			sessions.project_path,
			COALESCE(
				NULLIF(TRIM(chat_session_bindings.workspace_path), ''),
				NULLIF(TRIM(sessions.workspace_path), ''),
				sessions.project_path
			) AS workspace_path,
			CASE
				WHEN COALESCE(
					NULLIF(TRIM(chat_session_bindings.agent_deck_session_id), ''),
					NULLIF(TRIM(sessions.agent_deck_session_id), '')
				) IS NULL THEN 'detached'
				ELSE 'attached'
			END AS binding_state,
			COALESCE(NULLIF(TRIM(sessions.origin_kind), ''), 'managed') AS origin_kind
		FROM sessions
		LEFT JOIN chat_session_bindings
			ON chat_session_bindings.chat_id = sessions.thread_id
		WHERE COALESCE(
			NULLIF(TRIM(chat_session_bindings.agent_deck_session_id), ''),
			NULLIF(TRIM(sessions.agent_deck_session_id), '')
		) IS NOT NULL
	`)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "no such table") {
			return bindings, nil
		}
		return nil, fmt.Errorf("query pixel forge chat bindings: %w", err)
	}
	defer func() { _ = rows.Close() }()

	for rows.Next() {
		var (
			sessionID    string
			chatID       string
			chatTitle    string
			projectPath  string
			workspace    string
			bindingState string
			originKind   string
		)
		if err := rows.Scan(
			&sessionID,
			&chatID,
			&chatTitle,
			&projectPath,
			&workspace,
			&bindingState,
			&originKind,
		); err != nil {
			return nil, fmt.Errorf("scan pixel forge chat binding: %w", err)
		}

		normalizedSessionID := strings.TrimSpace(sessionID)
		if normalizedSessionID == "" {
			continue
		}

		normalizedChatID := strings.TrimSpace(chatID)
		bindings[normalizedSessionID] = pixelForgeChatBinding{
			ChatID:        normalizedChatID,
			ChatTitle:     normalizePixelForgeChatTitle(chatTitle, normalizedChatID),
			BindingState:  normalizePixelForgeBindingState(bindingState),
			WorkspaceKind: normalizePixelForgeWorkspaceKind(projectPath, workspace),
			OriginKind:    normalizePixelForgeOriginKind(originKind),
		}
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate pixel forge chat bindings: %w", err)
	}

	return bindings, nil
}

func applyPixelForgeChatBindings(snapshot *MenuSnapshot, bindings map[string]pixelForgeChatBinding) *MenuSnapshot {
	if snapshot == nil {
		return nil
	}

	cloned := cloneMenuSnapshot(snapshot)
	if len(bindings) == 0 {
		return cloned
	}

	for i := range cloned.Items {
		item := &cloned.Items[i]
		if item.Type != MenuItemTypeSession || item.Session == nil {
			continue
		}

		binding, ok := bindings[item.Session.ID]
		if !ok {
			continue
		}

		item.Session.ChatID = binding.ChatID
		item.Session.ChatTitle = binding.ChatTitle
		item.Session.BindingState = binding.BindingState
		item.Session.WorkspaceKind = binding.WorkspaceKind
		item.Session.OriginKind = binding.OriginKind
	}

	return cloned
}

func normalizePixelForgeChatTitle(rawTitle, chatID string) string {
	normalized := strings.TrimSpace(rawTitle)
	if normalized != "" {
		return normalized
	}
	if chatID == "" {
		return ""
	}
	shortID := chatID
	if len(shortID) > 8 {
		shortID = shortID[:8]
	}
	return fmt.Sprintf("Chat %s", shortID)
}

func normalizePixelForgeBindingState(rawState string) string {
	switch strings.TrimSpace(strings.ToLower(rawState)) {
	case "detached":
		return "detached"
	default:
		return "attached"
	}
}

func normalizePixelForgeWorkspaceKind(projectPath, workspacePath string) string {
	if normalizePixelForgePath(projectPath) == normalizePixelForgePath(workspacePath) {
		return "root"
	}
	return "clone"
}

func normalizePixelForgeOriginKind(rawValue string) string {
	switch strings.TrimSpace(strings.ToLower(rawValue)) {
	case "adopted":
		return "adopted"
	default:
		return "managed"
	}
}

func normalizePixelForgePath(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	return filepath.Clean(trimmed)
}

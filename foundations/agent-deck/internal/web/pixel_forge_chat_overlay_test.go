package web

import (
	"database/sql"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

func TestLoadPixelForgeChatBindingsFromPath(t *testing.T) {
	t.Helper()

	dbPath := filepath.Join(t.TempDir(), "pixel-forge.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer func() { _ = db.Close() }()

	statements := []string{
		`CREATE TABLE sessions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			project_path TEXT NOT NULL,
			workspace_path TEXT NOT NULL,
			thread_id TEXT NOT NULL UNIQUE,
			backend TEXT NOT NULL,
			origin_kind TEXT NOT NULL DEFAULT 'managed',
			agent_deck_session_id TEXT,
			agent_deck_session_title TEXT,
			agent_deck_tool TEXT,
			editor_state_json TEXT,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			last_active TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE TABLE chat_session_bindings (
			chat_id TEXT PRIMARY KEY,
			project_path TEXT NOT NULL,
			workspace_path TEXT NOT NULL,
			agent_deck_session_id TEXT NOT NULL UNIQUE,
			agent_deck_session_title TEXT,
			agent_deck_tool TEXT,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		`INSERT INTO sessions (
			project_path,
			workspace_path,
			thread_id,
			backend,
			origin_kind,
			agent_deck_session_id,
			agent_deck_session_title
		) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		`INSERT INTO chat_session_bindings (
			chat_id,
			project_path,
			workspace_path,
			agent_deck_session_id,
			agent_deck_session_title
		) VALUES (?, ?, ?, ?, ?)`,
	}

	for index, statement := range statements[:2] {
		if _, err := db.Exec(statement); err != nil {
			t.Fatalf("exec schema %d: %v", index, err)
		}
	}

	if _, err := db.Exec(
		statements[2],
		"/repo/project",
		"/repo/project/.agents/chat-a",
		"chat-a",
		"agent-deck",
		"adopted",
		"sess-1",
		"Deck Session",
	); err != nil {
		t.Fatalf("insert session: %v", err)
	}

	if _, err := db.Exec(
		statements[3],
		"chat-a",
		"/repo/project",
		"/repo/project/.agents/chat-a",
		"sess-1",
		"Shared Chat Title",
	); err != nil {
		t.Fatalf("insert binding: %v", err)
	}

	bindings, err := loadPixelForgeChatBindingsFromPath(dbPath)
	if err != nil {
		t.Fatalf("loadPixelForgeChatBindingsFromPath() error = %v", err)
	}

	binding, ok := bindings["sess-1"]
	if !ok {
		t.Fatalf("expected session binding for sess-1")
	}
	if binding.ChatID != "chat-a" {
		t.Fatalf("expected chat id chat-a, got %q", binding.ChatID)
	}
	if binding.ChatTitle != "Shared Chat Title" {
		t.Fatalf("expected shared chat title, got %q", binding.ChatTitle)
	}
	if binding.BindingState != "attached" {
		t.Fatalf("expected attached binding state, got %q", binding.BindingState)
	}
	if binding.WorkspaceKind != "clone" {
		t.Fatalf("expected clone workspace kind, got %q", binding.WorkspaceKind)
	}
	if binding.OriginKind != "adopted" {
		t.Fatalf("expected adopted origin kind, got %q", binding.OriginKind)
	}
}

func TestApplyPixelForgeChatBindings(t *testing.T) {
	snapshot := &MenuSnapshot{
		Items: []MenuItem{
			{
				Type: MenuItemTypeSession,
				Session: &MenuSession{
					ID:    "sess-1",
					Title: "Deck Session",
				},
			},
		},
	}

	updated := applyPixelForgeChatBindings(snapshot, map[string]pixelForgeChatBinding{
		"sess-1": {
			ChatID:        "chat-a",
			ChatTitle:     "Shared Chat Title",
			BindingState:  "attached",
			WorkspaceKind: "clone",
			OriginKind:    "managed",
		},
	})

	if updated == snapshot {
		t.Fatalf("expected cloned snapshot")
	}

	session := updated.Items[0].Session
	if session.ChatID != "chat-a" {
		t.Fatalf("expected chat id chat-a, got %q", session.ChatID)
	}
	if session.ChatTitle != "Shared Chat Title" {
		t.Fatalf("expected chat title Shared Chat Title, got %q", session.ChatTitle)
	}
	if session.BindingState != "attached" {
		t.Fatalf("expected attached binding state, got %q", session.BindingState)
	}
	if session.WorkspaceKind != "clone" {
		t.Fatalf("expected clone workspace kind, got %q", session.WorkspaceKind)
	}
	if session.OriginKind != "managed" {
		t.Fatalf("expected managed origin kind, got %q", session.OriginKind)
	}
}

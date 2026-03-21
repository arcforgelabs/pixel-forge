package tmux

import "testing"

func TestDetectStuckComposerPromptRequiresStableHash(t *testing.T) {
	sess := NewSession("retry-test", "/tmp")
	content := `Some prior output
──────────────────────────────────────────────────────────────
❯ Run go test ./...
──────────────────────────────────────────────────────────────
  [Opus 4.6] Context: 41%
  ⏵⏵ bypass permissions on (shift+Tab to cycle) · 3 files +25 -3`

	stuck, hash, prompt := sess.detectStuckComposerPrompt(content, "Run go test ./...", "")
	if stuck {
		t.Fatal("first check should not be considered stuck without prior hash")
	}
	if hash == "" {
		t.Fatal("expected hash on first candidate snapshot")
	}
	if prompt != "Run go test ./..." {
		t.Fatalf("prompt = %q, want %q", prompt, "Run go test ./...")
	}

	stuck, hash2, prompt2 := sess.detectStuckComposerPrompt(content, "Run go test ./...", hash)
	if !stuck {
		t.Fatal("second identical snapshot should be considered stuck")
	}
	if hash2 != hash {
		t.Fatalf("hash changed unexpectedly: %q vs %q", hash2, hash)
	}
	if prompt2 != "Run go test ./..." {
		t.Fatalf("prompt = %q, want %q", prompt2, "Run go test ./...")
	}
}

func TestDetectStuckComposerPromptAcceptsShortcutsIndicator(t *testing.T) {
	sess := NewSession("retry-test-shortcuts", "/tmp")
	content := `Output
❯ Open the release notes
  [Tab] for shortcuts`

	stuck, hash, prompt := sess.detectStuckComposerPrompt(content, "Open the release notes", "")
	if stuck {
		t.Fatal("first check should not be considered stuck without prior hash")
	}
	if hash == "" {
		t.Fatal("expected hash for shortcuts indicator variant")
	}
	if prompt != "Open the release notes" {
		t.Fatalf("prompt = %q, want %q", prompt, "Open the release notes")
	}
}

func TestDetectStuckComposerPromptRejectsPromptWithoutText(t *testing.T) {
	sess := NewSession("retry-test-empty", "/tmp")
	content := `Output
❯
  ⏵⏵ bypass permissions on`

	stuck, hash, prompt := sess.detectStuckComposerPrompt(content, "any message", "")
	if stuck {
		t.Fatal("prompt without text must not be considered stuck")
	}
	if hash != "" {
		t.Fatalf("hash = %q, want empty", hash)
	}
	if prompt != "" {
		t.Fatalf("prompt = %q, want empty", prompt)
	}
}

func TestDetectStuckComposerPromptRejectsMessageMismatch(t *testing.T) {
	sess := NewSession("retry-test-mismatch", "/tmp")
	content := `Output
❯ Real prompt text
  ⏵⏵ bypass permissions on`

	stuck, hash, prompt := sess.detectStuckComposerPrompt(content, "different message", "")
	if stuck {
		t.Fatal("message mismatch should not be considered stuck")
	}
	if hash != "" {
		t.Fatalf("hash = %q, want empty", hash)
	}
	if prompt != "" {
		t.Fatalf("prompt = %q, want empty", prompt)
	}
}

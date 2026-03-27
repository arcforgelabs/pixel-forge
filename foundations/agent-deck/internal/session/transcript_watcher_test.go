package session

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestTranscriptFileWatcherDeliversExactFileEvents(t *testing.T) {
	dir := t.TempDir()
	transcript := filepath.Join(dir, "session.jsonl")
	other := filepath.Join(dir, "other.jsonl")

	got := make(chan string, 4)
	watcher, err := NewTranscriptFileWatcher(func(key, path string) {
		got <- key + "|" + filepath.Base(path)
	})
	if err != nil {
		t.Fatalf("NewTranscriptFileWatcher() error = %v", err)
	}
	defer watcher.Stop()

	go watcher.Start()

	if err := watcher.Sync([]WatchedTranscript{{Key: "session-a", Path: transcript}}); err != nil {
		t.Fatalf("Sync() error = %v", err)
	}

	if err := osWriteFile(transcript, []byte("one\n")); err != nil {
		t.Fatalf("write transcript: %v", err)
	}
	select {
	case msg := <-got:
		if msg != "session-a|session.jsonl" {
			t.Fatalf("callback = %q, want %q", msg, "session-a|session.jsonl")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for exact transcript event")
	}

	if err := osWriteFile(other, []byte("ignored\n")); err != nil {
		t.Fatalf("write other transcript: %v", err)
	}
	select {
	case msg := <-got:
		t.Fatalf("unexpected callback for unwatched file: %q", msg)
	case <-time.After(350 * time.Millisecond):
	}
}

func TestTranscriptFileWatcherSyncRemovesOldDirectoryWatches(t *testing.T) {
	dirA := filepath.Join(t.TempDir(), "a")
	dirB := filepath.Join(t.TempDir(), "b")
	if err := osMkdirAll(dirA, 0o755); err != nil {
		t.Fatalf("mkdir a: %v", err)
	}
	if err := osMkdirAll(dirB, 0o755); err != nil {
		t.Fatalf("mkdir b: %v", err)
	}
	fileA := filepath.Join(dirA, "a.jsonl")
	fileB := filepath.Join(dirB, "b.jsonl")

	got := make(chan string, 4)
	watcher, err := NewTranscriptFileWatcher(func(key, path string) {
		got <- key + "|" + filepath.Base(path)
	})
	if err != nil {
		t.Fatalf("NewTranscriptFileWatcher() error = %v", err)
	}
	defer watcher.Stop()

	go watcher.Start()

	if err := watcher.Sync([]WatchedTranscript{{Key: "a", Path: fileA}}); err != nil {
		t.Fatalf("first Sync() error = %v", err)
	}
	if err := watcher.Sync([]WatchedTranscript{{Key: "b", Path: fileB}}); err != nil {
		t.Fatalf("second Sync() error = %v", err)
	}

	if err := osWriteFile(fileA, []byte("old\n")); err != nil {
		t.Fatalf("write old file: %v", err)
	}
	select {
	case msg := <-got:
		t.Fatalf("unexpected callback for removed watch: %q", msg)
	case <-time.After(350 * time.Millisecond):
	}

	if err := osWriteFile(fileB, []byte("new\n")); err != nil {
		t.Fatalf("write new file: %v", err)
	}
	select {
	case msg := <-got:
		if msg != "b|b.jsonl" {
			t.Fatalf("callback = %q, want %q", msg, "b|b.jsonl")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for synced transcript event")
	}
}

func osWriteFile(path string, data []byte) error {
	return os.WriteFile(path, data, 0o644)
}

func osMkdirAll(path string, perm os.FileMode) error {
	return os.MkdirAll(path, perm)
}

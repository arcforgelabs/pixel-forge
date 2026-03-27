package session

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"

	"github.com/asheshgoplani/agent-deck/internal/logging"
)

var transcriptWatchLog = logging.ForComponent(logging.CompSession)

// WatchedTranscript describes one exact transcript file to observe.
type WatchedTranscript struct {
	Key  string
	Path string
}

// TranscriptFileWatcher watches exact transcript files by watching their parent
// directories and routing matching create/write events back to a callback.
type TranscriptFileWatcher struct {
	watcher *fsnotify.Watcher

	ctx    context.Context
	cancel context.CancelFunc

	mu       sync.RWMutex
	files    map[string]string // absolute cleaned file path -> key
	dirRefs  map[string]int    // watched parent dir -> refcount
	onChange func(key, path string)

	debounceMu sync.Mutex
	debounce   map[string]*time.Timer
}

// NewTranscriptFileWatcher creates a watcher for exact transcript files.
func NewTranscriptFileWatcher(onChange func(key, path string)) (*TranscriptFileWatcher, error) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &TranscriptFileWatcher{
		watcher:  watcher,
		ctx:      ctx,
		cancel:   cancel,
		files:    make(map[string]string),
		dirRefs:  make(map[string]int),
		onChange: onChange,
		debounce: make(map[string]*time.Timer),
	}, nil
}

// Start begins watching. Call in a goroutine.
func (w *TranscriptFileWatcher) Start() {
	for {
		select {
		case <-w.ctx.Done():
			return
		case event, ok := <-w.watcher.Events:
			if !ok {
				return
			}
			if event.Op&(fsnotify.Create|fsnotify.Write|fsnotify.Rename) == 0 {
				continue
			}
			w.handleEvent(event.Name)
		case err, ok := <-w.watcher.Errors:
			if !ok {
				return
			}
			transcriptWatchLog.Warn("transcript_watcher_error", slog.String("error", err.Error()))
		}
	}
}

// Stop shuts down the watcher.
func (w *TranscriptFileWatcher) Stop() {
	w.cancel()
	_ = w.watcher.Close()

	w.debounceMu.Lock()
	for _, timer := range w.debounce {
		timer.Stop()
	}
	w.debounce = make(map[string]*time.Timer)
	w.debounceMu.Unlock()
}

// Sync replaces the watched transcript set with the provided exact files.
func (w *TranscriptFileWatcher) Sync(files []WatchedTranscript) error {
	nextFiles := make(map[string]string, len(files))
	nextDirRefs := make(map[string]int)
	for _, entry := range files {
		key := entry.Key
		path := normalizeWatchedTranscriptPath(entry.Path)
		if key == "" || path == "" {
			continue
		}
		nextFiles[path] = key
		nextDirRefs[filepath.Dir(path)]++
	}

	w.mu.Lock()
	defer w.mu.Unlock()

	for dir := range w.dirRefs {
		if nextDirRefs[dir] == 0 {
			if err := w.watcher.Remove(dir); err != nil {
				transcriptWatchLog.Debug(
					"transcript_watcher_remove_failed",
					slog.String("dir", dir),
					slog.String("error", err.Error()),
				)
			}
		}
	}
	for dir := range nextDirRefs {
		if w.dirRefs[dir] > 0 {
			continue
		}
		if stat, err := os.Stat(dir); err != nil || !stat.IsDir() {
			continue
		}
		if err := w.watcher.Add(dir); err != nil {
			return err
		}
	}

	w.files = nextFiles
	w.dirRefs = nextDirRefs
	transcriptWatchLog.Debug(
		"transcript_watcher_sync",
		slog.Int("files", len(nextFiles)),
		slog.Int("dirs", len(nextDirRefs)),
	)
	return nil
}

func (w *TranscriptFileWatcher) handleEvent(path string) {
	path = normalizeWatchedTranscriptPath(path)
	if path == "" {
		return
	}

	w.mu.RLock()
	key, ok := w.files[path]
	w.mu.RUnlock()
	if !ok || key == "" {
		return
	}
	transcriptWatchLog.Debug(
		"transcript_watcher_event",
		slog.String("key", key),
		slog.String("path", path),
	)

	w.debounceMu.Lock()
	if timer, exists := w.debounce[path]; exists {
		timer.Stop()
	}
	w.debounce[path] = time.AfterFunc(200*time.Millisecond, func() {
		w.debounceMu.Lock()
		delete(w.debounce, path)
		w.debounceMu.Unlock()
		if w.onChange != nil {
			w.onChange(key, path)
		}
	})
	w.debounceMu.Unlock()
}

func normalizeWatchedTranscriptPath(path string) string {
	path = filepath.Clean(path)
	if path == "." || path == "" {
		return ""
	}
	if abs, err := filepath.Abs(path); err == nil {
		return abs
	}
	return path
}

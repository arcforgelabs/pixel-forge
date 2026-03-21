package ui

import (
	"bytes"
	"embed"
	"fmt"
	"strings"
	"sync"
	"text/template"
)

//go:embed prompt_templates/*.md.tmpl
var promptTemplateFS embed.FS

var (
	promptTemplatesOnce sync.Once
	promptTemplates     *template.Template
	promptTemplatesErr  error
)

func renderPromptTemplate(name string, data any) (string, error) {
	promptTemplatesOnce.Do(func() {
		promptTemplates, promptTemplatesErr = template.New("prompt-templates").ParseFS(
			promptTemplateFS,
			"prompt_templates/*.md.tmpl",
		)
	})
	if promptTemplatesErr != nil {
		return "", fmt.Errorf("load prompt templates: %w", promptTemplatesErr)
	}

	var buf bytes.Buffer
	if err := promptTemplates.ExecuteTemplate(&buf, name, data); err != nil {
		return "", fmt.Errorf("render prompt template %q: %w", name, err)
	}

	return strings.TrimSpace(buf.String()) + "\n", nil
}

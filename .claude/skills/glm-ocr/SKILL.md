---
name: glm-ocr
description: Extract text from scanned PDFs and images using GLM-OCR. Use when pdf-extract returns empty or minimal text from a PDF (indicating it's a scanned document), when the user mentions "OCR", "scanned document", "read this image", "extract text from image", or provides image/PDF files that need text extraction. Supports PDF, JPG, PNG. Auto-detects local Ollama first, falls back to cloud API.
---

# GLM-OCR

Extract text from scanned documents using GLM-OCR via local Ollama or cloud API.

## Modes (auto-detected)

1. **Local Ollama** (preferred) — tries `host.docker.internal:11434` then `localhost:11434`
2. **Cloud API** — fallback using Zhipu AI API key

## Setup

### Local (Ollama)

```bash
curl -fsSL https://ollama.ai/install.sh | sh
ollama pull glm-ocr:latest
```

That's it. The skill auto-detects Ollama and uses local inference.

### Cloud Fallback

Set `ZAI_API_KEY` env var or add to `~/.nanoclaw/config.json`:

```json
{
  "skills": {
    "entries": {
      "glm-ocr": { "apiKey": "your-key" }
    }
  }
}
```

## Install

Run from within the NanoClaw directory:

```bash
mkdir -p scripts
cp "${CLAUDE_SKILL_DIR}/scripts/ocr.cjs" scripts/ocr.cjs
chmod +x scripts/ocr.cjs
```

## Usage

```bash
node scripts/ocr.cjs <file_url_or_path> [options]
```

### Options

| Option | Description |
|--------|-------------|
| `--output <path>` | Write output to file instead of stdout |
| `--category <name>` | Output to `storage/<category>/` with auto-generated filename |
| `--title <title>` | Document title (used in filename generation) |
| `--format <type>` | Output format: `raw` (default) or `obsidian` (with frontmatter) |

### Category Aliases

| Alias | Resolves To |
|-------|-------------|
| `clubs` | `storage/home/kids/school/clubs/` |
| `events` | `storage/home/kids/school/events/` |
| `school` | `storage/home/kids/school/` |
| `shopping` | `storage/home/shopping/` |
| `tasks` | `storage/home/tasks/` |
| `uplynk` | `storage/work/uplynk/` |
| `work` | `storage/work/uplynk/` |

If no category specified, output defaults to `storage/temp/`.

### Examples

```bash
# Basic usage (stdout)
node scripts/ocr.cjs https://example.com/document.pdf

# Output to specific file
node scripts/ocr.cjs ./scan.jpg --output ./output.md

# Categorize with auto-generated filename
node scripts/ocr.cjs ./newsletter.pdf --category school --title "October Newsletter"

# Obsidian format with frontmatter
node scripts/ocr.cjs ./receipt.png --category shopping --format obsidian

# Use full category path
node scripts/ocr.cjs ./doc.pdf --category home/kids/school/clubs
```

## Storage Integration

Output integrates with the NanoClaw storage system:

```
storage/
├── temp/                    # Default (staging area)
├── home/
│   ├── kids/school/
│   ├── shopping/
│   └── tasks/
└── work/
    └── uplynk/
```

## Output Format

### Raw (default)
Plain markdown text extracted from document.

### Obsidian (`--format obsidian`)
Full Obsidian-compatible markdown with YAML frontmatter:

```markdown
---
source: "path/to/original.pdf"
date_processed: "2026-03-26"
category: "school"
original_path: "path/to/original.pdf"
---

# Document Title

**Source:** original.pdf
**Date:** 2026-03-26
**Category:** school

---

## Extracted Text

[OCR content here]

---

_Tags: #ocr #school_
```

## Requirements

- **Local:** Ollama with `glm-ocr:latest` model
- **Cloud:** Zhipu AI API key (get at https://docs.z.ai)
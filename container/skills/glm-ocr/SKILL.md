---
name: glm-ocr
description: Extract text from scanned PDFs and images using GLM-OCR. Use when you receive an image or PDF attachment that needs text extraction. Supports PDF, JPG, PNG. Auto-detects local Ollama first, falls back to cloud API.
---

# GLM-OCR

Extract text from scanned documents using GLM-OCR via local Ollama or cloud API.

## Modes (auto-detected)

1. **Local Ollama** (preferred) — connects to `host.docker.internal:11434`
2. **Cloud API** — fallback using Zhipu AI API key

## Usage

```bash
node /workspace/group/.claude/skills/glm-ocr/scripts/ocr.cjs <file_path> [options]
```

### Options

| Option | Description |
|--------|-------------|
| `--output <path>` | Write output to file instead of stdout |
| `--category <name>` | Output to storage/<category>/ with auto-generated filename |
| `--title <title>` | Document title (used in filename generation) |
| `--format <type>` | Output format: `raw` (default) or `obsidian` (with frontmatter) |

### Examples

```bash
# Extract text from a photo in the media folder
node /workspace/group/.claude/skills/glm-ocr/scripts/ocr.cjs /workspace/group/media/2026-04-05T12-30-00_photo.jpg

# Extract from PDF with output file
node /workspace/group/.claude/skills/glm-ocr/scripts/ocr.cjs /workspace/group/media/document.pdf --output /workspace/group/extracted.md

# Use cloud API fallback
ZAI_API_KEY=xxx node /workspace/group/.claude/skills/glm-ocr/scripts/ocr.cjs /workspace/group/media/scan.png
```

## Setup

### Local (Ollama)

Ollama runs on the host at port 11434. The container connects via `host.docker.internal:11434`.

Pull the model:
```bash
ollama pull glm-ocr:latest
```

### Cloud Fallback

Set `ZAI_API_KEY` environment variable or add to `~/.nanoclaw/config.json`:
```json
{
  "skills": {
    "entries": {
      "glm-ocr": { "apiKey": "your-key" }
    }
  }
}
```

## Storage Paths

Inside the container:
- Media files: `/workspace/group/media/`
- Output: `/workspace/group/` or specify with `--output`

## Requirements

- **Local:** Ollama with `glm-ocr:latest` model running on host
- **Cloud:** Zhipu AI API key (get at https://docs.z.ai)